// Scheduled nudge for stalled onboardings (finding 10). Netlify runs this on a
// cron: it scans the session store for IN-PROGRESS sessions that have been idle
// longer than STALLED_HOURS (default 48) and were never nudged, posts one Slack
// alert to the same channel as the completion alert, and stamps `nudgedAt` so
// each stalled session fires exactly once.
//
// Config (Netlify environment variables):
//   SLACK_BOT_TOKEN  required to post; no-op if unset. Same token the Apps Script
//                    uses for the completion alert — set it here too so this
//                    function (which lives in Netlify, where the session store is)
//                    can post directly.
//   SLACK_CHANNEL    channel id (default C097154H39N, matches the Apps Script).
//   STALLED_HOURS    idle threshold in hours (default 48). MUST match STALE_MS in
//                    public/dashboard.html, which is what a consultant sees: at 24 the
//                    Slack nudge fired a full day before the dashboard showed the
//                    session as stalled, so the alert pointed at a row still labelled
//                    "in progress".
//   URL              site URL (set automatically by Netlify); powers the dashboard
//                    deep link in the alert.
//   APPS_SCRIPT_WEBAPP_URL / APPS_SCRIPT_SECRET
//                    optional; enables the threaded IC/TAM @mention. The tracker is
//                    a Google Sheet and the roster lives in Script Properties, so
//                    this function cannot read either — it asks the Apps Script,
//                    behind the same shared secret sheet.js already uses. Unset
//                    means the nudge posts exactly as before.
//
// Scheduled functions are registered by the `config.schedule` export below — no
// netlify.toml entry is needed.

import { getStore } from "@netlify/blobs";

const DEFAULT_CHANNEL = "C097154H39N";
export const config = { schedule: "0 * * * *" }; // hourly; a stalled session is a 24h+ condition, so latency is not critical

export default async () => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { console.warn("SLACK_BOT_TOKEN not set — stalled check is a no-op"); return resp(200, "no token"); }
  const channel = process.env.SLACK_CHANNEL || DEFAULT_CHANNEL;
  const hours = Number(process.env.STALLED_HOURS) || 48;
  const cutoff = Date.now() - hours * 3600000;

  let store;
  try { store = getStore("lumen-sessions"); }
  catch (err) { console.error("Blobs store unavailable", err); return resp(500, "store error"); }
  // Nudge de-dup lives in a SEPARATE store, not on the session record. This removes
  // the two failure modes of read-modify-writing the record: a transient re-read
  // error that skipped the stamp (re-firing the alert next run), and any chance of
  // overwriting a just-completed record with a stale in-progress copy. It also keeps
  // these markers out of the session list the dashboard renders.
  let nudgeStore = null;
  try { nudgeStore = getStore("lumen-nudges"); }
  catch (err) { console.error("nudge store unavailable — proceeding without marker dedup", err); }

  let blobs;
  try { ({ blobs } = await store.list()); }
  catch (err) { console.error("stalled-check list failed", err); return resp(500, "list error"); }

  let nudged = 0, scanned = 0;
  for (const b of blobs) {
    let r;
    try { r = await store.get(b.key, { type: "json" }); } catch { continue; }
    scanned++;
    if (!isStalled(r, cutoff)) continue;
    // Already nudged (dedicated marker)? isStalled already skips old records that
    // carry the legacy nudgedAt stamp, so both paths stay deduped.
    if (nudgeStore && await nudgeStore.get(r.id, { type: "json" }).catch(() => null)) continue;

    const company = (r.merged && r.merged.company && r.merged.company.name) || "(unnamed client)";
    const pct = Number.isFinite(r.percent) ? Math.max(0, Math.min(100, Math.round(r.percent))) : 0;
    const last = Date.parse(r.lastActiveAt || r.savedAt || "");
    const idleH = Math.round((Date.now() - last) / 3600000);
    const link = process.env.URL ? `${process.env.URL}/dashboard?id=${encodeURIComponent(r.id)}` : null;
    const text = `:warning: *Onboarding stalled* — *${slackEsc(company)}* has been idle ${idleH}h at ${pct}% (still in progress).`
      + (link ? `\n<${link}|View the partial session>` : "");

    const posted = await postSlack(token, channel, text);
    if (!posted.ok) continue; // leave the session un-marked so a failed post retries next run

    // Tag whoever owns this client. This is the alert where someone actually has to
    // act, and it was the one addressed to nobody. Threaded, so the channel still
    // reads as one line per stalled client. Strictly best-effort: the nudge itself
    // has already posted and is already deduped, so a lookup failure must never
    // cost the marker write below and cause a duplicate nudge next run.
    const mentionText = posted.ts ? await assigneeText(company) : "";
    if (mentionText) await postSlack(token, channel, mentionText, posted.ts);

    // Record the nudge in the dedicated store. A simple write (no read-modify-write
    // of the session record) that cannot clobber a completed record; on the rare
    // write failure the worst case is one duplicate next run, not a lost completion.
    if (nudgeStore) {
      try { await nudgeStore.setJSON(r.id, { at: new Date().toISOString() }); nudged++; }
      catch (err) { console.error("stalled-check failed to write nudge marker", err); }
    } else { nudged++; }
  }
  console.log(`stalled-check: scanned ${scanned}, nudged ${nudged}`);
  return resp(200, `nudged ${nudged}`);
};

function isStalled(r, cutoff) {
  if (!r || r.status !== "in_progress" || r.nudgedAt) return false;
  const last = Date.parse(r.lastActiveAt || r.savedAt || "");
  return Number.isFinite(last) && last <= cutoff;
}

function slackEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Ask the Apps Script who owns this client. Returns "" on any failure or when the
// integration is not configured — every caller treats that as "post nothing extra".
async function assigneeText(company) {
  const url = process.env.APPS_SCRIPT_WEBAPP_URL, secret = process.env.APPS_SCRIPT_SECRET;
  if (!url || !secret || !company) return "";
  try {
    // Bounded: this runs inside a loop over every stalled session, so an Apps Script
    // that is slow rather than down would otherwise stretch the whole scheduled run.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret, action: "assignees", client: company }),
        redirect: "follow", // Apps Script /exec answers via a 302 to googleusercontent
        signal: ctl.signal,
      });
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    return typeof data.text === "string" ? data.text : "";
  } catch (err) {
    console.error("assignee lookup failed (non-fatal)", err && err.message);
    return "";
  }
}

async function postSlack(token, channel, text, threadTs) {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: "Bearer " + token },
      body: JSON.stringify(threadTs ? { channel, text, thread_ts: threadTs, unfurl_links: false } : { channel, text, unfurl_links: false }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error("stalled-check Slack post failed", data.error || res.status);
    return { ok: !!data.ok, ts: data.ts || "" };
  } catch (err) { console.error("stalled-check Slack post threw", err); return { ok: false, ts: "" }; }
}

function resp(status, body) { return new Response(body, { status }); }
