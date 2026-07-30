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
import { generateReply, streamReply } from "./chat.js";

export const config = { path: "/.netlify/functions/chat-background", background: true };

const JOB_STORE = "lumen-chat-jobs";
// Matches the client's rid format (see callAPI). An opaque, unguessable id — not
// personal or sensitive data, so it is fine in the query string.
const RID_RE = /^r_[A-Za-z0-9_-]{6,64}$/;
// Inside the 15-min background ceiling with wide margin; far above the 20-30s the
// slowest legitimate replies take, so a real reply never hits it.
const BG_ABORT_MS = 9 * 60 * 1000;

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
  // Opt-in streaming path: only when the client explicitly asks (stream=1 in the
  // query, gated behind a ?stream=1 page param). Real clients never send it, so they
  // stay on the untouched generateReply path below. On this path we persist partial
  // visible prose as it is generated (state "partial", NOT deleted on read) and then
  // overwrite it with the identical final result (deleted on read, exactly as today).
  const wantStream = new URL(req.url).searchParams.get("stream") === "1";

  const genStart = Date.now();
  let result;
  if (wantStream) {
    // Throttle partial writes so a fast stream can't hammer the blob store: at most
    // one write per PARTIAL_MS, plus the latest text always wins the final race.
    const PARTIAL_MS = 400;
    let lastWrite = 0, latest = "";
    const flush = async (text) => {
      latest = text;
      const now = Date.now();
      if (now - lastWrite < PARTIAL_MS) return;
      lastWrite = now;
      try { await store.setJSON(rid, { state: "partial", text: latest, savedAt: new Date().toISOString() }); }
      catch (err) { /* a dropped partial just means the client shows the previous one a beat longer */ }
    };
    try {
      const r = await streamReply(req, { abortMs: BG_ABORT_MS, onVisible: (t) => { flush(t); } });
      result = { status: r.status, body: r.body };
    } catch (err) {
      console.error("chat-background: streamReply threw", err && err.message);
      result = { status: 502, body: { error: "background_failed" } };
    }
  } else {
    try {
      const resp = await generateReply(req, { abortMs: BG_ABORT_MS });
      const body = await resp.json().catch(() => ({ error: "bad_upstream_json" }));
      result = { status: resp.status, body };
    } catch (err) {
      console.error("chat-background: generateReply threw", err && err.message);
      result = { status: 502, body: { error: "background_failed" } };
    }
  }
  const genMs = Date.now() - genStart;
  console.log("chat-background: generation took", genMs, "ms for", rid);

  try {
    // Final write overwrites any "partial" record under this rid. It has {status,
    // body, genMs} and NO state:"partial" flag, which is how chat-status tells a
    // finished job from an in-progress one.
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
