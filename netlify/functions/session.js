// Session store for completed onboarding briefs (Netlify Functions v2 + Blobs).
//   POST /.netlify/functions/session   { session }        -> { id }
//   GET  /.netlify/functions/session                      -> { sessions: [...] }
//   GET  /.netlify/functions/session?id=<id>              -> { session }
//
// In v2, getStore() picks up the site context automatically, so Blobs works
// with no siteID/token wiring. Only dependency: @netlify/blobs.

import { getStore } from "@netlify/blobs";
import { verifyGoogleAuth } from "../lib/google-auth.js";
import crypto from "node:crypto"; // explicit import: globalThis.crypto only exists on Node >= 19
import { rateLimit, tooMany } from "../lib/ratelimit.js";

const STORE = "lumen-sessions";
const MAX_BODY_BYTES = 400_000;
// Shape guard for the client-supplied record key. The client mints its own id with
// crypto.randomUUID and must keep using it so autosaves UPDATE one record instead of
// creating a new one per save, so the key stays client-supplied by design. This does
// not make the id secret (it is already unguessable); it stops an arbitrary, huge, or
// path-like string becoming a blob key. Permissive enough to accept both a UUID and
// this file's own "s_"-prefixed genId form, so no stored record is orphaned.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Deliberately far above any legitimate traffic. The autosave is debounced at 600ms
// and keyed to settled state changes, so one client averages ~4 writes/min. The only
// realistic way to approach a ceiling is many clients sharing one office NAT address
// (a group onboarding, an enterprise rolling out several teams at once), and at
// 300/min that would take ~75 concurrent sessions on a single IP.
//
// Sized this way on purpose: a false positive here is worse than a slow abuser. A
// 429 on an autosave is harmless (the next one succeeds), but a 429 on the FINAL
// save means the completed brief never reaches the dashboard — and the client is
// still shown "Brief sent" (see handleSend in src/lumen.jsx, which calls setSent(true)
// regardless of saveOk). A script doing real damage runs at thousands/min, so this
// still catches what it needs to.
const RL_WRITE = { perMin: 300, perHour: 3000 };
const DEFAULT_CHANNEL = "C097154H39N"; // matches stalled-check.js and the Apps Script completion alert
export const config = { path: "/.netlify/functions/session" };

export default async (req) => {
  let store;
  try { store = getStore(STORE); }
  catch (err) { console.error("Blobs store unavailable", err); return json(500, { error: "store_unavailable" }); }

  const url = new URL(req.url);

  if (req.method === "POST") {
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

    let body;
    try { body = JSON.parse(rawBody); }
    catch { return json(400, { error: "bad_json" }); }

    // Server-to-server sheetUrl writeback from the Apps Script (authenticated by the
    // shared APPS_SCRIPT_SECRET). Lets the dashboard show the "Open Sheet" link even
    // when the client timed out before receiving the URL — a long/heavy session can
    // outlast the client's wait while the Apps Script still finishes and calls this.
    // Bypasses the Origin check (the Apps Script is cross-origin); it ONLY updates
    // the sheetUrl on an EXISTING record and cannot create or otherwise mutate a
    // session, so the secret is the sole authority for this narrow write.
    if (body && typeof body.secret === "string" && body.id && typeof body.sheetUrl === "string") {
      const wbSecret = process.env.APPS_SCRIPT_SECRET;
      if (!wbSecret || body.secret !== wbSecret) return json(401, { error: "unauthorized" });
      try {
        const prev = await store.get(body.id, { type: "json" }).catch(() => null);
        if (!prev) return json(404, { error: "not_found" });
        prev.sheetUrl = String(body.sheetUrl).slice(0, 2000);
        prev.notifyFallback = false; // the Sheet exists now, so the fallback alert is moot
        await store.setJSON(body.id, prev);
        return json(200, { id: body.id, updated: true });
      } catch (err) { console.error("sheetUrl writeback failed", err); return json(502, { error: "writeback_failed" }); }
    }

    // Origin check for normal client writes. Browsers send an Origin header on POST
    // even same-origin, so we require it PRESENT and same-origin — this rejects naive
    // scripted writes that omit or mismatch it. It is NOT a strong control (Origin is
    // spoofable outside a browser), so it layers with the payload validation, size
    // caps and status lock below. The chat page has no login, so it cannot carry a
    // server secret — see README (write-endpoint exposure) for why there's no token
    // gate on the normal path.
    const origin = req.headers.get("origin");
    const siteURL = process.env.URL;
    if (siteURL) {
      let ok = false;
      try { ok = !!origin && new URL(origin).host === new URL(siteURL).host; } catch { ok = false; }
      if (!ok) return json(403, { error: "forbidden_origin" });
    } else {
      console.warn("URL env not set — cannot validate Origin on session write");
    }

    // Per-IP write limiter. The Origin check above is spoofable outside a browser, so
    // without this an anonymous caller can fabricate unlimited session records in the
    // store the internal dashboard renders, and fire the completion Slack alert below
    // once per record. Fails open on any storage error (see ../lib/ratelimit.js).
    const rl = await rateLimit(req, "session", RL_WRITE);
    if (!rl.ok) return tooMany(rl.retryAfter);

    const session = body && body.session;
    if (!session || typeof session !== "object" || Array.isArray(session)) return json(400, { error: "missing_session" });
    if (session.id != null && (typeof session.id !== "string" || !SESSION_ID_RE.test(session.id))) {
      return json(400, { error: "bad_session_id" });
    }

    // Structural sanity + caps. The 400KB body cap bounds total size; this keeps
    // individual collections from ballooning and rejects an obviously malformed
    // shape before it reaches the store. Client input is otherwise stored as data
    // (the dashboard HTML-escapes everything on render).
    const merged = session.merged;
    if (merged != null && (typeof merged !== "object" || Array.isArray(merged))) return json(400, { error: "bad_merged" });
    const capArr = (o, k, n) => { if (o && Array.isArray(o[k]) && o[k].length > n) o[k] = o[k].slice(0, n); };
    if (merged) ["topics", "channels", "reports", "alerts"].forEach((k) => capArr(merged, k, 300));
    capArr(session, "users", 200);
    const capStr = (o, k, n) => { if (o && typeof o[k] === "string" && o[k].length > n) o[k] = o[k].slice(0, n); };
    capStr(session, "queries", 80_000);
    if (merged) capStr(merged, "queries", 80_000);

    const id = (typeof session.id === "string" && session.id) || genId();
    const record = { ...session, id, savedAt: new Date().toISOString() };
    try {
      // One read serves both branches below AND the archive-preservation rule.
      const prev = await store.get(id, { type: "json" }).catch(() => null);

      // ARCHIVE IS OPERATOR METADATA, NOT CLIENT DATA — carry it across every write.
      // Without this, archiving a row whose browser tab is still open would be undone
      // by that tab's next autosave (autosave POSTs the whole record and would simply
      // omit archivedAt), and the row would silently reappear in the dashboard minutes
      // later. That reads as "archiving randomly doesn't work" and is miserable to
      // diagnose. Restore clears the flag explicitly via session-admin.js, which is
      // the only thing that should ever remove it.
      if (prev && prev.archivedAt && !record.archivedAt) record.archivedAt = prev.archivedAt;

      // Status lock: in-progress autosaves and the final completed record share an
      // id (last-write-wins in Blobs). A delayed in-progress write must never
      // downgrade a completed brief and lose its sheetUrl/handoff/full data, so
      // refuse to overwrite a stored completed record with a non-completed one.
      // (Read-before-write isn't atomic — Blobs has no CAS — but it closes the
      // realistic reorder window.)
      if (record.status !== "completed") {
        if (prev && prev.status === "completed") return json(200, { id, skipped: "completed_locked" });
      } else {
        // Completed record. Reconcile with the Apps Script's server-side sheetUrl
        // writeback, which can land BEFORE this POST: a client that timed out sends
        // a completed record with no sheetUrl and notifyFallback set, but the Sheet
        // may already exist and its link already be stored. Never null out a known
        // Sheet link, and don't fire the fallback when a Sheet is on record.
        if (prev && prev.sheetUrl && !record.sheetUrl) record.sheetUrl = prev.sheetUrl;
        if (record.sheetUrl) record.notifyFallback = false;
        // Fallback completion alert: only when there is genuinely no Sheet, exactly
        // once (stamped alertedAt so a re-POST can't double-fire). No-op if
        // SLACK_BOT_TOKEN is unset (same posture as stalled-check.js).
        if (record.notifyFallback && !record.sheetUrl) {
          if (prev && prev.alertedAt) {
            record.alertedAt = prev.alertedAt; // already alerted — preserve, never re-fire
          } else {
            const ok = await postCompletionFallback(record);
            if (ok) record.alertedAt = new Date().toISOString();
          }
        } else if (prev && prev.alertedAt) {
          record.alertedAt = prev.alertedAt; // keep any prior stamp
        }
      }
      await store.setJSON(id, record);
    }
    catch (err) { console.error("Failed to save session", err); return json(502, { error: "save_failed" }); }
    return json(200, { id });
  }

  if (req.method === "GET") {
    // Reads expose client PII, so they require the dashboard token.
    const expected = process.env.DASHBOARD_TOKEN;
    if (!expected) {
      console.error("DASHBOARD_TOKEN is not set on this Netlify site — session reads are locked until it is");
      return json(500, { error: "dashboard_token_not_configured" });
    }
    const provided = req.headers.get("x-dashboard-token");
    if (provided !== expected) return json(401, { error: "unauthorized" });
    // Second, independent gate: Google Sign-In, dormant unless configured. Only
    // the GET branch is gated — the POST above is the CLIENT saving their own
    // onboarding session, and they are not (and must never need to be) signed
    // into a Hootsuite Google account.
    const gauth = await verifyGoogleAuth(req);
    if (!gauth.ok) return json(401, { error: "unauthorized_google", reason: gauth.reason });

    const id = url.searchParams.get("id");
    if (id) {
      try {
        const rec = await store.get(id, { type: "json" });
        if (!rec) return json(404, { error: "not_found" });
        return json(200, { session: rec });
      } catch (err) { console.error("Failed to read session", err); return json(502, { error: "read_failed" }); }
    }
    try {
      const { blobs } = await store.list();
      const records = await Promise.all(
        blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null))
      );
      // Archived rows are hidden from the default view and returned ONLY when the
      // dashboard explicitly asks for them (?archived=1), which is what backs its
      // "Show archived" toggle. Archiving is a visibility decision, never a data one:
      // the record is untouched and restore is a flag flip (see session-admin.js).
      const wantArchived = url.searchParams.get("archived") === "1";
      const sessions = records
        .filter(Boolean)
        .filter((r) => (wantArchived ? !!r.archivedAt : !r.archivedAt))
        .map(summarize)
        .sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
      return json(200, { sessions });
    } catch (err) { console.error("Failed to list sessions", err); return json(502, { error: "list_failed" }); }
  }

  return json(405, { error: "method_not_allowed" });
};

// The record is client-POSTed, so numeric fields must be coerced (not just
// passed through): a non-numeric value would otherwise reach the dashboard and
// either render as an XSS sink (apiCalls) or poison the KPI math (tokens -> NaN).
const numOrNull = (x) => (Number.isFinite(x) ? x : null);

function summarize(r) {
  const company = (r.merged && r.merged.company) || {};
  const status = r.status === "in_progress" ? "in_progress" : "completed"; // whitelist
  const t = r.tokens && typeof r.tokens === "object" ? r.tokens : null;
  const tokens = t ? { input: +t.input || 0, output: +t.output || 0, cacheRead: +t.cacheRead || 0, cacheWrite: +t.cacheWrite || 0 } : null;
  const percent = Number.isFinite(r.percent)
    ? Math.max(0, Math.min(100, Math.round(r.percent)))
    : (status === "completed" ? 100 : 0);
  return {
    id: r.id,
    company: company.name || "(unnamed)",
    contact: company.contact || "",
    email: company.email || "",
    objectives: company.objectives || "",
    topicCount: Array.isArray(r.merged && r.merged.topics) ? r.merged.topics.length : 0,
    channelCount: Array.isArray(r.merged && r.merged.channels) ? r.merged.channels.length : 0,
    userCount: Array.isArray(r.users) ? r.users.length : 0,
    status: status,
    percent: percent,
    durationMs: numOrNull(r.durationMs),
    apiCalls: numOrNull(r.apiCalls),
    tokens: tokens,
    sheetUrl: r.sheetUrl || null,
    hasHandoff: !!(r.handoff && typeof r.handoff === "object" && Object.keys(r.handoff).length),
    seeded: !!r.seedId,
    seedId: r.seedId || null,
    lastActiveAt: r.lastActiveAt || r.sentAt || r.savedAt || null,
    sentAt: r.sentAt || null,
    savedAt: r.savedAt || null,
    // Drives the dashboard's archived view and gates permanent deletion: only an
    // already-archived record can be deleted (enforced server-side in session-admin.js,
    // not just in the UI).
    archivedAt: r.archivedAt || null,
  };
}

// crypto.randomUUID, not Math.random. This id is the only thing protecting a stored
// session record (there is no per-record auth), so it is a capability and has to be
// unguessable. The previous form was a predictable timestamp prefix plus ~30 bits
// from Math.random, which is not a CSPRNG.
function genId() {
  return "s_" + crypto.randomUUID();
}

// Fallback completion alert (see the notifyFallback branch above). Concise by
// design — it exists to make sure a completed brief is never invisible, not to
// replicate the Apps Script's rich @mention alert. Slack posting mirrors
// stalled-check.js (kept as its own small copy rather than a shared module to
// avoid changing the function-bundling surface).
async function postCompletionFallback(record) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return false; // Slack not configured — the dashboard still has the brief
  const channel = process.env.SLACK_CHANNEL || DEFAULT_CHANNEL;
  const company = (record.merged && record.merged.company && record.merged.company.name) || "(unnamed client)";
  const link = process.env.URL ? `${process.env.URL}/dashboard?id=${encodeURIComponent(record.id)}` : null;
  const text = `:page_facing_up: *Onboarding brief completed* — *${slackEsc(company)}* finished their setup, but the Google Sheet could not be generated (this alert is the fallback). The full brief is saved.`
    + (link ? `\n<${link}|View the session>` : "");
  return postSlack(token, channel, text);
}

function slackEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

async function postSlack(token, channel, text) {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: "Bearer " + token },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error("session fallback Slack post failed", data.error || res.status);
    return !!data.ok;
  } catch (err) { console.error("session fallback Slack post threw", err); return false; }
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
