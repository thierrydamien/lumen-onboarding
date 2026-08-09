// Poll endpoint for a background chat job (Netlify Functions v2).
//   GET /.netlify/functions/chat-status?id=<rid>
//     -> { state: "pending" }                              (job not finished yet)
//     -> { state: "done", status, body }                  (persisted result)
//
// Pairs with chat-background.js: the client kicks off a background job, then polls
// here until the result appears. Lightweight and synchronous (a single blob read),
// so it stays well inside the normal function window no matter how long the model
// call behind it takes.

import { getStore } from "@netlify/blobs";

export const config = { path: "/.netlify/functions/chat-status" };

const JOB_STORE = "lumen-chat-jobs";
const RID_RE = /^r_[A-Za-z0-9_-]{6,64}$/;
// How long a terminal result survives after it is first read, so a repeat poll is
// idempotent (see the handler). Comfortably longer than the client's 500ms polling
// cadence and its 12s per-poll timeout, and far shorter than a session, so nothing
// lingers meaningfully. TRADE-OFF: a client that reads successfully and stops polling
// leaves the blob behind, because nothing arrives to trigger the cleanup branch. That
// is deliberate — losing a paid reply is worse than leaving a few KB — but it means
// the jobs store still wants the TTL sweep it has never had.
const CONSUMED_GRACE_MS = 60_000;

// What to do with a terminal result on this read. Pure so the retention rule can be
// tested without a store: "stamp" on first sight (keep it, record when it was read),
// "keep" while still inside the grace window (a repeat poll must be idempotent), and
// "delete" only once the window has passed.
export function consumeAction(rec, now, graceMs = CONSUMED_GRACE_MS) {
  const consumedAt = rec && typeof rec.consumedAt === "number" ? rec.consumedAt : null;
  if (consumedAt == null) return "stamp";
  return now - consumedAt > graceMs ? "delete" : "keep";
}

export default async (req) => {
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });

  const rid = new URL(req.url).searchParams.get("id") || "";
  if (!RID_RE.test(rid)) return json(400, { error: "bad_id" });

  // Same-origin friction, consistent with the other endpoints — but only enforced
  // when an Origin header is present (browsers omit it on some same-origin GETs).
  // The unguessable rid is the real guard, and the payload is only the assistant
  // reply (no cross-user data; consultant notes never reach the browser regardless).
  const origin = req.headers.get("origin");
  const siteURL = process.env.URL;
  if (siteURL && origin) {
    let ok = false;
    try { ok = new URL(origin).host === new URL(siteURL).host; } catch { ok = false; }
    if (!ok) return json(403, { error: "forbidden_origin" });
  }

  let store;
  try { store = getStore(JOB_STORE); }
  catch (err) { console.error("chat-status: blobs unavailable", err); return json(500, { error: "store_unavailable" }); }

  let rec;
  try { rec = await store.get(rid, { type: "json" }); }
  catch (err) { console.error("chat-status: read failed", err); return json(502, { error: "read_failed" }); }

  if (!rec) return json(200, { state: "pending" });

  // Terminal result found. Do NOT delete it on sight.
  //
  // Deleting on first read destroyed the only copy of a finished reply. If that poll
  // response was lost in flight, the tab reloaded, or two polls overlapped, the next
  // poll saw nothing, the client waited out its deadline and re-rolled a brand new
  // job: a second paid generation, a second wait, and possibly a DIFFERENT answer to
  // the same question. The reply was already written and paid for; throwing it away
  // on an unacknowledged read was the wrong trade.
  //
  // Instead, keep it for a grace window so a repeated poll is idempotent, and clean up
  // on the first poll that arrives after the window. rids are minted fresh per attempt
  // (see callAPI), so a stale result can never be served to a later turn.
  const now = Date.now();
  const action = consumeAction(rec, now);
  if (action === "stamp") {
    // First read: stamp it, keep the blob. Best effort — if the stamp fails the next
    // read simply treats it as a first read too, which errs toward keeping the reply.
    store.setJSON(rid, { ...rec, consumedAt: now }).catch(() => {});
  } else if (action === "delete") {
    store.delete(rid).catch(() => {});
  }
  return json(200, { state: "done", status: rec.status, body: rec.body, genMs: rec.genMs });
};

// Explicit no-store on every poll response: this endpoint is polled every 500ms
// for a result that changes turn to turn, so a CDN/edge layer serving even a
// briefly-stale cached "pending" would silently add real seconds to perceived
// latency between generation finishing and the client seeing "done" — a gap
// observed in production logs (~5-6s unaccounted for beyond genMs). Belt and
// suspenders: both the generic and the Netlify-specific CDN header, since only
// one may be honored depending on which cache layer is in front of this response.
function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, must-revalidate",
    "Netlify-CDN-Cache-Control": "no-store",
  } });
}
