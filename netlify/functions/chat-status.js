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

  // In-progress partial (streaming path only): return the visible prose so far and
  // do NOT delete — the job is still running and will overwrite this record with the
  // terminal result. The client renders `text` as a live bubble and keeps polling.
  if (rec.state === "partial") return json(200, { state: "partial", text: rec.text || "" });

  // Terminal result found. Delete it so the store doesn't grow without bound
  // (best effort — a failed delete just leaves a blob for a later sweep to reap).
  store.delete(rid).catch(() => {});
  return json(200, { state: "done", status: rec.status, body: rec.body, genMs: rec.genMs });
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
