// Background chat generation (Netlify Functions v2, background mode).
//   POST /.netlify/functions/chat-background?rid=<opaque id>   { messages, ... }
//     -> 202 immediately; the reply is generated in the background and persisted
//        to the "lumen-chat-jobs" blob store under rid for chat-status.js to serve.
//
// WHY THIS EXISTS: a synchronous function is capped at ~26s. Real onboarding replies
// were measured at 20-30s (document attaches, topic-heavy turns), so they were being
// killed mid-generation and surfaced to clients as timeouts (see the 504 cluster in
// the Netlify request log). A background function runs up to 15 min, so the identical
// model call — same model, same prompt, same token ceiling, same notes-leak guard —
// simply finishes instead of racing a 26s wall.
//
// The generation logic itself is NOT duplicated here: it is generateReply() in
// chat.js, called with a larger abort budget. This file only handles the async
// plumbing (persist the result, never fail back to Netlify).

import { getStore } from "@netlify/blobs";
import { generateReply } from "./chat.js";

export const config = { path: "/.netlify/functions/chat-background", background: true };

const JOB_STORE = "lumen-chat-jobs";
// Matches the client's rid format (see callAPI). An opaque, unguessable id — not
// personal or sensitive data, so it is fine in the query string.
const RID_RE = /^r_[A-Za-z0-9_-]{6,64}$/;
// MUST STAY BELOW the client's POLL_MAX_MS (180_000 in src/lumen.jsx callAPI).
//
// This was 9 minutes, i.e. three times the client's own deadline, and the asymmetry
// was the bug: the client gave up at 180s while this kept generating to 540s. The
// abandoned job then finished, billed a full generation, and persisted a result
// nobody would ever poll for — and the client, seeing nothing, re-rolled a BRAND NEW
// job (see the `stuck job: re-roll` branch in callAPI). One slow turn, two paid
// generations, and a failure shown to the client while their answer was still being
// written. It hit hardest on document attaches, which are both the slowest turns and
// the ones the client cared most about.
//
// Inverting it makes the server give up FIRST, so the outcome is always reported
// rather than inferred: at 150s this persists a clean 504, the client reads it on its
// next 500ms poll (~30s inside its own deadline), and takes its normal transient-retry
// path with no orphaned generation running in the background.
//
// 150s is ~5x the slowest legitimate reply measured to date (20-30s). If a real turn
// ever needs longer, raise BOTH numbers together and keep this one lower — the
// invariant, not either value, is what matters. tests/timeouts.test.js enforces it.
const BG_ABORT_MS = 150_000;

export default async (req) => {
  const rid = new URL(req.url).searchParams.get("rid") || "";
  // No/invalid rid means the client can't poll for a result, so there's nothing
  // worth generating. Return the 202 the platform expects and stop. (This also
  // makes a bare warm-up ping cheap — it never triggers a model call.)
  if (!RID_RE.test(rid)) { console.warn("chat-background: missing/invalid rid — skipping"); return accepted(); }

  let store;
  try { store = getStore(JOB_STORE); }
  catch (err) { console.error("chat-background: blobs unavailable", err); return accepted(); }

  // Run the SAME core as the synchronous proxy, only with a budget that fits the
  // background window. Everything below is wrapped so this function NEVER signals
  // failure to Netlify: a non-2xx return makes Netlify auto-retry the background
  // function (after 1 min, then 2 min), which would fire a DUPLICATE model call.
  // Instead we always persist a result (success OR error) and return 200, letting
  // the client surface any error through the polled result.
  // Timestamp the actual generation, not the kickoff: the request-log "duration"
  // for this function only reflects the synchronous 202 accept, not the background
  // continuation, so it can't answer "how long did generation really take". This
  // makes that number visible directly in the persisted/polled result instead of
  // requiring a dig through Netlify's function-specific log view.
  const genStart = Date.now();
  let result;
  try {
    const resp = await generateReply(req, { abortMs: BG_ABORT_MS });
    const body = await resp.json().catch(() => ({ error: "bad_upstream_json" }));
    result = { status: resp.status, body };
  } catch (err) {
    console.error("chat-background: generateReply threw", err && err.message);
    result = { status: 502, body: { error: "background_failed" } };
  }
  const genMs = Date.now() - genStart;
  // Log output tokens next to the duration so tokens/sec — and the share taken by
  // the hidden <thought> block — can be tracked from the function log alone when
  // tuning prompt-driven latency (genMs is output-bound on this workload).
  const outTok = result.body && result.body.usage && result.body.usage.output_tokens;
  console.log("chat-background: generation took", genMs, "ms,", outTok || "?", "output tokens, for", rid);

  try {
    await store.setJSON(rid, { ...result, genMs, savedAt: new Date().toISOString() });
  } catch (err) {
    // If we can't persist, the client will poll to its deadline and re-roll a fresh
    // job — degraded but not broken.
    console.error("chat-background: failed to persist result", err);
  }
  return accepted();
};

// A background function's return value isn't sent to the client (it already got its
// 202), so the exact shape here only matters for the platform. Return 200 so Netlify
// treats the invocation as successful and does not retry it.
function accepted() {
  return new Response(null, { status: 200 });
}
