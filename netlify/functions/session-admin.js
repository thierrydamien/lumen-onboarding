// Dashboard housekeeping: archive, restore, and permanently delete sessions and the
// "link sent" seed rows beside them (Netlify Functions v2 + Blobs).
//
//   POST /.netlify/functions/session-admin
//     { action: "archive" | "restore" | "delete", items: [{ kind, id }, ...] }
//
// WHY THIS IS ITS OWN FUNCTION: session.js is on the path every client autosave takes,
// and already carries subtle status-lock and writeback-reconciliation logic. Bolting a
// destructive third branch onto it would put the one operation that can lose a client
// brief inside the one function that must never break. Keeping it separate means this
// file can be read, reviewed and reasoned about on its own.
//
// TWO-STAGE BY DESIGN. Archiving only sets a flag; the record is untouched and restore
// is a flag flip. Permanent deletion is refused unless the record is ALREADY archived
// — enforced here, server-side, not merely greyed out in the UI. So destroying a real
// client's brief takes two deliberate actions separated by a visible state change,
// rather than one misclick.
//
// AUTH: the dashboard read token, same as every other read/write here. There is no
// second password — the two-stage archive-then-delete flow plus the dashboard's own
// confirm dialogs (which name the affected clients and require typing "DELETE") are
// the guard against a misclick, not a separate secret.

import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { rateLimit, tooMany, clientIp } from "../lib/ratelimit.js";
import { verifyGoogleAuth } from "../lib/google-auth.js";

const SESSION_STORE = "lumen-sessions";
const SEED_STORE = "lumen-seeds";
const DRAFT_STORE = "lumen-drafts";
const NUDGE_STORE = "lumen-nudges";

const MAX_BODY_BYTES = 100_000;
// Bulk is the whole point (clearing a run of test sessions), but an unbounded array
// would let one request walk the entire store. 200 is far above any real cleanup.
const MAX_ITEMS = 200;
// Deliberately tight. This is a destructive, human-driven action: nobody legitimately
// issues more than a handful of these a minute, so a low ceiling costs nothing and
// bounds the damage from a leaked dashboard token.
const RL = { perMin: 10, perHour: 60 };

// Same shapes the two stores actually mint (see genId in session.js, and "sd_"+uuid in
// seed.js). Validated so a crafted id can neither address an arbitrary blob key nor
// pick the wrong store.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SEED_ID_RE = /^sd_[A-Za-z0-9-]{1,64}$/;

export const config = { path: "/.netlify/functions/session-admin" };

// Constant-time compare so a token cannot be recovered byte-by-byte from response
// timing. Length is compared first because timingSafeEqual throws on a length
// mismatch; leaking only the length of a long random secret is not useful.
function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // Same-origin friction, consistent with every other write endpoint here.
  const origin = req.headers.get("origin");
  const siteURL = process.env.URL;
  if (siteURL) {
    let ok = false;
    try { ok = !!origin && new URL(origin).host === new URL(siteURL).host; } catch { ok = false; }
    if (!ok) return json(403, { error: "forbidden_origin" });
  }

  // Gate 1: the dashboard read token. You cannot act on what you cannot see.
  const readToken = process.env.DASHBOARD_TOKEN;
  if (!readToken) return json(500, { error: "dashboard_token_not_configured" });
  if (!tokenMatches(req.headers.get("x-dashboard-token"), readToken)) {
    return json(401, { error: "unauthorized" });
  }
  // Gate 2: Google Sign-In (dormant unless configured). This endpoint PERMANENTLY
  // DELETES sessions, so it gets the same second lock as the reads.
  const gauth = await verifyGoogleAuth(req);
  if (!gauth.ok) return json(401, { error: "unauthorized_google", reason: gauth.reason });

  const rl = await rateLimit(req, "session-admin", RL);
  if (!rl.ok) return tooMany(rl.retryAfter);

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  let body;
  try { body = JSON.parse(rawBody); } catch { return json(400, { error: "bad_json" }); }

  const action = body && body.action;
  if (!["archive", "restore", "delete"].includes(action)) return json(400, { error: "bad_action" });

  const items = body && body.items;
  if (!Array.isArray(items) || items.length === 0) return json(400, { error: "no_items" });
  if (items.length > MAX_ITEMS) return json(400, { error: "too_many_items", max: MAX_ITEMS });

  let sessions, seeds;
  try { sessions = getStore(SESSION_STORE); seeds = getStore(SEED_STORE); }
  catch (err) { console.error("Blobs store unavailable", err); return json(500, { error: "store_unavailable" }); }
  // Drafts and nudges are only touched on permanent delete, and their absence must
  // never fail the operation.
  let drafts = null, nudges = null;
  try { drafts = getStore(DRAFT_STORE); } catch { /* optional */ }
  try { nudges = getStore(NUDGE_STORE); } catch { /* optional */ }

  const now = new Date().toISOString();
  const results = [];

  for (const item of items) {
    const kind = item && item.kind;
    const id = item && item.id;
    const valid = (kind === "session" && typeof id === "string" && SESSION_ID_RE.test(id))
      || (kind === "seed" && typeof id === "string" && SEED_ID_RE.test(id));
    if (!valid) { results.push({ id: String(id || ""), ok: false, error: "bad_item" }); continue; }

    try {
      results.push(kind === "session"
        ? await applyToSession(action, id, { sessions, seeds, drafts, nudges, now })
        : await applyToSeed(action, id, { seeds, drafts, now }));
    } catch (err) {
      console.error(`session-admin: ${action} failed for ${id}`, err);
      results.push({ id, ok: false, error: "failed" });
    }
  }

  // Audit line. A shared token means this records THAT a token-holder acted, not who —
  // real attribution would need per-user identity, which this app does not have.
  const done = results.filter((r) => r.ok).length;
  console.log(`session-admin: ${action} requested for ${items.length}, applied ${done}, from ${clientIp(req)}`,
    JSON.stringify(results.filter((r) => r.ok).map((r) => r.id)));

  return json(200, { action, requested: items.length, applied: done, results });
};

// A session row and everything that belongs to it: the session record, the seed behind
// its link, that link's resume draft, and the stalled-alert marker. Archiving touches
// only the first two (visibility); deleting removes all four.
async function applyToSession(action, id, { sessions, seeds, drafts, nudges, now }) {
  const rec = await sessions.get(id, { type: "json" }).catch(() => null);
  if (!rec) return { id, ok: false, error: "not_found" };

  if (action === "delete") {
    // The two-stage guard. Enforced HERE rather than only in the dashboard, so a
    // scripted or replayed call cannot skip the archive step either.
    if (!rec.archivedAt) return { id, ok: false, error: "not_archived" };
    await sessions.delete(id);
    if (rec.seedId) {
      await seeds.delete(rec.seedId).catch(() => {});
      if (drafts) await drafts.delete(rec.seedId).catch(() => {});
    }
    if (nudges) await nudges.delete(id).catch(() => {});
    return { id, ok: true, deleted: true };
  }

  const archivedAt = action === "archive" ? now : null;
  await sessions.setJSON(id, { ...rec, archivedAt });
  // Keep the link's "link sent" row in step, so archiving a test does not leave its
  // other half on screen. The seed record itself is untouched otherwise, and still
  // resolves for the client (see the note in seed.js).
  if (rec.seedId) {
    const seed = await seeds.get(rec.seedId, { type: "json" }).catch(() => null);
    if (seed) await seeds.setJSON(rec.seedId, { ...seed, archivedAt }).catch(() => {});
  }
  return { id, ok: true, archivedAt };
}

// A "link sent" row with no session behind it: a link generated but never opened.
async function applyToSeed(action, id, { seeds, drafts, now }) {
  const rec = await seeds.get(id, { type: "json" }).catch(() => null);
  if (!rec) return { id, ok: false, error: "not_found" };

  if (action === "delete") {
    if (!rec.archivedAt) return { id, ok: false, error: "not_archived" };
    await seeds.delete(id);
    if (drafts) await drafts.delete(id).catch(() => {});
    return { id, ok: true, deleted: true };
  }

  await seeds.setJSON(id, { ...rec, archivedAt: action === "archive" ? now : null });
  return { id, ok: true, archivedAt: action === "archive" ? now : null };
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
