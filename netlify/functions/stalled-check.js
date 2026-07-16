// Scheduled nudge for stalled onboardings (finding 10). Netlify runs this on a
// cron: it scans the session store for IN-PROGRESS sessions that have been idle
// longer than STALLED_HOURS (default 24) and were never nudged, posts one Slack
// alert to the same channel as the completion alert, and stamps `nudgedAt` so
// each stalled session fires exactly once.
//
// Config (Netlify environment variables):
//   SLACK_BOT_TOKEN  required to post; no-op if unset. Same token the Apps Script
//                    uses for the completion alert — set it here too so this
//                    function (which lives in Netlify, where the session store is)
//                    can post directly.
//   SLACK_CHANNEL    channel id (default C097154H39N, matches the Apps Script).
//   STALLED_HOURS    idle threshold in hours (default 24).
//   URL              site URL (set automatically by Netlify); powers the dashboard
//                    deep link in the alert.
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
  const hours = Number(process.env.STALLED_HOURS) || 24;
  const cutoff = Date.now() - hours * 3600000;

  let store;
  try { store = getStore("lumen-sessions"); }
  catch (err) { console.error("Blobs store unavailable", err); return resp(500, "store error"); }

  let blobs;
  try { ({ blobs } = await store.list()); }
  catch (err) { console.error("stalled-check list failed", err); return resp(500, "list error"); }

  let nudged = 0, scanned = 0;
  for (const b of blobs) {
    let r;
    try { r = await store.get(b.key, { type: "json" }); } catch { continue; }
    scanned++;
    if (!isStalled(r, cutoff)) continue;

    const company = (r.merged && r.merged.company && r.merged.company.name) || "(unnamed client)";
    const pct = Number.isFinite(r.percent) ? Math.max(0, Math.min(100, Math.round(r.percent))) : 0;
    const last = Date.parse(r.lastActiveAt || r.savedAt || "");
    const idleH = Math.round((Date.now() - last) / 3600000);
    const link = process.env.URL ? `${process.env.URL}/dashboard?id=${encodeURIComponent(r.id)}` : null;
    const text = `:warning: *Onboarding stalled* — *${slackEsc(company)}* has been idle ${idleH}h at ${pct}% (still in progress).`
      + (link ? `\n<${link}|View the partial session>` : "");

    const ok = await postSlack(token, channel, text);
    if (!ok) continue; // leave nudgedAt unset so a failed post retries next run

    // Re-read immediately before writing: a stalled session is idle by definition,
    // but if the client happened to complete it while we were posting, we must NOT
    // overwrite that completed record with a stale in-progress copy. Blobs has no
    // CAS, so this read-then-write only narrows the window — which is enough here,
    // since the client is not active on a 24h-idle session.
    const fresh = await store.get(r.id, { type: "json" }).catch(() => null);
    if (fresh && fresh.status === "in_progress" && !fresh.nudgedAt) {
      try { await store.setJSON(r.id, { ...fresh, nudgedAt: new Date().toISOString() }); nudged++; }
      catch (err) { console.error("stalled-check failed to mark nudgedAt", err); }
    }
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

async function postSlack(token, channel, text) {
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: "Bearer " + token },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error("stalled-check Slack post failed", data.error || res.status);
    return !!data.ok;
  } catch (err) { console.error("stalled-check Slack post threw", err); return false; }
}

function resp(status, body) { return new Response(body, { status }); }
