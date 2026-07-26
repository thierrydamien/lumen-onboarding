// Resumable in-progress drafts (Netlify Functions v2 + Blobs).
//   POST   /.netlify/functions/draft  { seedId, snapshot }  -> { ok: true }
//   POST   /.netlify/functions/draft  { seedId, done: true } -> { ok: true }  (clear on send)
//   GET    /.netlify/functions/draft?seedId=<id>            -> { draft } | 404
//
// WHY THIS EXISTS: pause/resume used to live only in localStorage, so a client who
// started on their laptop and reopened the link on their phone lost everything and
// had to start over. That pushed busy clients toward submitting an incomplete brief.
// The conversation snapshot is now also kept server-side, keyed by the LINK's seed id,
// so reopening the same link resumes exactly where it was left on ANY device.
//
// This is deliberately a SEPARATE store from lumen-sessions (the dashboard's summary
// records): different retention, different read auth, and a much larger payload.
// Keeping them apart means nothing here can change what the dashboard reads.
//
// ACCESS MODEL (reviewed): the GET is not token-gated — the opaque link id IS the
// credential, the same way the client's chat already is. Note the exposure delta this
// creates: previously a link let a holder CONTINUE a session; now it also lets them
// READ what was captured so far. Anyone the link is forwarded to gains that. The
// snapshot contains only data that already lived in the client's own browser.
// Consultant notes / package / brief are NOT in it: the client fetches the seed
// without the dashboard token (client-safe fields only) and chat.js injects the
// confidential blocks server-side, so they never enter client state.
// GOVERNANCE: this makes client-supplied data (possibly PII) retrievable by link
// holder. Confirm retention and access with the ISO 42001 owner before enabling.

import { getStore } from "@netlify/blobs";

const STORE = "lumen-drafts";
// A snapshot carries the rendered messages plus the model history, so it is far
// larger than a session summary. ~1MB leaves generous headroom over a realistic
// worst case (a long session is a few hundred KB) while still bounding abuse.
const MAX_BODY_BYTES = 1_000_000;
// Retention: drafts hold the client's own answers, so they expire rather than living
// forever. Enforced lazily on read (no cron): an expired draft reads as not-found and
// is deleted when next touched. Mirrors seed.js, including the env guards below.
// Override the 90-day default with DRAFT_TTL_DAYS (0 disables expiry).
const _ttlDays = process.env.DRAFT_TTL_DAYS != null ? Number(process.env.DRAFT_TTL_DAYS) : 90;
// Guard NaN (a typo'd value would otherwise disable expiry and keep client data
// forever) AND negative (a sign typo makes the TTL negative-but-truthy, so every
// record reads as expired and the whole store is swept). Clamp to >= 0; 0 = keep.
const DRAFT_TTL_MS = Math.max(0, Number.isFinite(_ttlDays) ? _ttlDays : 90) * 86400000;
// Same shape the chat page's seed ids use, so a malformed/probing key can't become
// a store entry.
const SEED_RE = /^sd_[A-Za-z0-9-]{1,64}$/;
export const config = { path: "/.netlify/functions/draft" };

function isExpired(rec) {
  if (!DRAFT_TTL_MS || !rec || !rec.savedAt) return false;
  const t = Date.parse(rec.savedAt);
  return Number.isFinite(t) && (Date.now() - t) > DRAFT_TTL_MS;
}

export default async (req) => {
  let store;
  try { store = getStore(STORE); }
  catch (err) { console.error("Blobs store unavailable", err); return json(500, { error: "store_unavailable" }); }

  const url = new URL(req.url);

  if (req.method === "POST") {
    // Origin check, same posture as seed.js / session.js: require a PRESENT,
    // same-origin Origin header. Layered rather than strong (Origin is spoofable
    // outside a browser); the seedId format check and size cap back it up.
    const origin = req.headers.get("origin");
    const siteURL = process.env.URL;
    if (siteURL) {
      let ok = false;
      try { ok = !!origin && new URL(origin).host === new URL(siteURL).host; } catch { ok = false; }
      if (!ok) return json(403, { error: "forbidden_origin" });
    } else {
      console.warn("URL env not set — cannot validate Origin on draft write");
    }

    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

    let body;
    try { body = JSON.parse(rawBody); }
    catch { return json(400, { error: "bad_json" }); }

    const seedId = body && body.seedId;
    if (typeof seedId !== "string" || !SEED_RE.test(seedId)) return json(400, { error: "bad_seed_id" });

    // Sent (or explicitly discarded) — drop the draft so reopening the link doesn't
    // offer to resume a conversation the client already finished.
    if (body.done === true) {
      try { await store.delete(seedId); } catch (err) { console.error("Failed to clear draft", err); }
      return json(200, { ok: true, cleared: true });
    }

    const snapshot = body.snapshot;
    // Only a real, non-empty conversation is worth storing. This also stops an empty
    // autosave from clobbering a good draft with nothing.
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return json(400, { error: "bad_snapshot" });
    if (!Array.isArray(snapshot.messages) || snapshot.messages.length === 0) return json(400, { error: "empty_snapshot" });

    const record = { seedId, snapshot, savedAt: new Date().toISOString() };
    try { await store.setJSON(seedId, record); }
    catch (err) { console.error("Failed to save draft", err); return json(502, { error: "save_failed" }); }
    return json(200, { ok: true });
  }

  if (req.method === "GET") {
    const seedId = url.searchParams.get("seedId");
    if (typeof seedId !== "string" || !SEED_RE.test(seedId)) return json(400, { error: "bad_seed_id" });
    let rec;
    try { rec = await store.get(seedId, { type: "json" }); }
    catch (err) { console.error("Failed to read draft", err); return json(502, { error: "read_failed" }); }
    if (!rec) return json(404, { error: "not_found" });
    if (isExpired(rec)) { store.delete(seedId).catch(() => {}); return json(404, { error: "expired" }); }
    return json(200, { draft: rec.snapshot, savedAt: rec.savedAt });
  }

  return json(405, { error: "method_not_allowed" });
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
