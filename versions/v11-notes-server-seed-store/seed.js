// Seed store for pre-filled client profiles (Netlify Functions v2 + Blobs).
//   POST /.netlify/functions/seed   { seed }            -> { id }
//   GET  /.netlify/functions/seed?id=<id>               -> { seed } CLIENT-SAFE (no notes)
//   GET  /.netlify/functions/seed?id=<id> + x-dashboard-token -> { seed } FULL (incl notes)
//
// WHY THIS EXISTS: the Sales page used to base64-encode the entire seed —
// including confidential consultant notes — into the client's ?c= link. Base64
// is trivially reversible, so any client could read the notes. Now Sales stores
// the seed here and the link carries only an opaque id. The chat page fetches
// only the client-safe fields; the notes are returned solely to the dashboard,
// which authenticates with DASHBOARD_TOKEN.

import { getStore } from "@netlify/blobs";

const STORE = "lumen-seeds";
const MAX_BODY_BYTES = 40_000;
export const config = { path: "/.netlify/functions/seed" };

// Fields safe to hand back to the (unauthenticated) client chat page. Notes are
// deliberately excluded and only ever returned to an authenticated dashboard.
const CLIENT_SAFE = ["company", "contactName", "email", "industry", "language"];

export default async (req) => {
  let store;
  try { store = getStore(STORE); }
  catch (err) { console.error("Blobs store unavailable", err); return json(500, { error: "store_unavailable" }); }

  const url = new URL(req.url);

  if (req.method === "POST") {
    // Same-origin friction for writes (the Sales page is same-origin).
    const origin = req.headers.get("origin");
    const siteURL = process.env.URL;
    if (origin && siteURL && new URL(origin).host !== new URL(siteURL).host) {
      return json(403, { error: "forbidden_origin" });
    }

    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

    let body;
    try { body = JSON.parse(rawBody); }
    catch { return json(400, { error: "bad_json" }); }

    const seed = body && body.seed;
    if (!seed || typeof seed !== "object" || Array.isArray(seed)) return json(400, { error: "missing_seed" });
    if (!seed.company || !seed.contactName) return json(400, { error: "company_and_contact_required" });

    // Store only known string fields, each length-capped, so a tampered client
    // cannot stuff arbitrary or oversized data into the store.
    const clean = {};
    for (const k of [...CLIENT_SAFE, "notes"]) {
      if (seed[k] != null) clean[k] = String(seed[k]).slice(0, 4000);
    }
    const id = "sd_" + crypto.randomUUID();
    const record = { ...clean, id, savedAt: new Date().toISOString() };
    try { await store.setJSON(id, record); }
    catch (err) { console.error("Failed to save seed", err); return json(502, { error: "save_failed" }); }
    return json(200, { id });
  }

  if (req.method === "GET") {
    const id = url.searchParams.get("id");
    if (!id) return json(400, { error: "missing_id" });
    let rec;
    try { rec = await store.get(id, { type: "json" }); }
    catch (err) { console.error("Failed to read seed", err); return json(502, { error: "read_failed" }); }
    if (!rec) return json(404, { error: "not_found" });

    // Notes are returned only to a caller holding the dashboard token. Everyone
    // else (i.e. the client chat page) gets the client-safe subset.
    const expected = process.env.DASHBOARD_TOKEN;
    const provided = req.headers.get("x-dashboard-token");
    const authed = !!expected && provided === expected;

    const safe = {};
    for (const k of CLIENT_SAFE) if (rec[k] != null) safe[k] = rec[k];
    const out = authed ? { ...safe, notes: rec.notes || "" } : safe;
    return json(200, { seed: out });
  }

  return json(405, { error: "method_not_allowed" });
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
