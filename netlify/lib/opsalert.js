// Ops alerting: tell a human when the TOOL is broken, not when a client did
// something.
//
// Every alert in this repo is about clients — completions, stalls, assignees.
// None was about the system. chat.js had seven console.error paths (a missing
// API key, upstream 401/429/5xx, an aborted call) that were logged and nothing
// else, so an expired key or a quota wall broke every live session while the
// only signal was a Netlify log nobody was watching. The first report would come
// from a client.
//
// EMAIL, NOT SLACK, and deliberately: an outage message naming the failing
// provider and status code is operational detail, and the completion channel is
// read by people who cannot act on it. Netlify functions cannot send mail
// without a new provider + credential, but the Apps Script already runs as a
// real Google account and can, so this posts to the same web app behind the same
// shared secret and lets it send. Recipient is a Script Property (OPS_EMAIL),
// never in this repo.
//
// Config: APPS_SCRIPT_WEBAPP_URL + APPS_SCRIPT_SECRET (both already set for
// sheet.js) and OPS_EMAIL in Script Properties. Missing any of them = no-op.
import { getStore } from "@netlify/blobs";

const STORE = "lumen-opsalerts";
// One mail per KIND per window. The failures worth alerting on are exactly the
// ones that hit every concurrent session at once, so the un-throttled version of
// this is a mail per client per turn during an outage — which buries the signal
// it exists to send, and does it in an inbox.
const THROTTLE_MS = 60 * 60 * 1000;

// In-process claim, checked and set SYNCHRONOUSLY, and the thing that actually
// stops the flood. The Blobs stamp below is a read-then-write with no
// compare-and-swap (Blobs has none — the rate limiter carries the same caveat),
// so concurrent invocations all read "nothing sent yet" before any of them
// writes. Measured: 50 simultaneous failures produced 50 mails. An outage is
// concurrent by definition, so that is the normal case, not the edge case.
//
// JS is single-threaded, so a synchronous check-and-set cannot interleave: a
// burst on one warm instance collapses to exactly one mail. Netlify may run
// several instances, so the residual is one mail per instance per window rather
// than one per request — bounded by concurrency instead of by traffic.
const _claimed = new Map();

/**
 * Fire-and-forget. NEVER throws and never blocks the caller's response: an
 * alerting path that can break the request it is reporting on is worse than no
 * alerting at all.
 * @param {string} kind  stable slug, also the throttle key ("anthropic_error")
 * @param {string} detail  one line of context; goes in the mail body
 */
export async function notifyOps(kind, detail) {
  const url = process.env.APPS_SCRIPT_WEBAPP_URL, secret = process.env.APPS_SCRIPT_SECRET;
  if (!url || !secret || !kind) return false;
  // Claim first, before ANY await, or the window reopens.
  const claimedAt = _claimed.get(kind);
  if (claimedAt && Date.now() - claimedAt < THROTTLE_MS) return false;
  _claimed.set(kind, Date.now());

  try {
    // Throttle BEFORE sending. Best-effort: if the store is unavailable we would
    // rather send a duplicate than swallow a real outage, so a failed read falls
    // through to sending.
    let store = null;
    try { store = getStore(STORE); } catch { /* proceed unthrottled */ }
    if (store) {
      const prev = await store.get(kind, { type: "json" }).catch(() => null);
      if (prev && prev.at && Date.now() - Date.parse(prev.at) < THROTTLE_MS) return false;
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret, action: "ops", kind,
          detail: String(detail == null ? "" : detail).slice(0, 1000),
          site: process.env.URL || "",
        }),
        redirect: "follow",
        signal: ctl.signal,
      });
    } finally { clearTimeout(timer); }

    // Stamp AFTER the send. Stamping first would silence the next hour on a send
    // that never landed.
    if (store) await store.setJSON(kind, { at: new Date().toISOString() }).catch(() => {});
    return true;
  } catch (err) {
    // Release the claim: the mail did not go, so the next failure should be free
    // to try again. The burst that raced this one has already been rejected, so
    // releasing costs at most one more attempt per round, never a flood.
    _claimed.delete(kind);
    console.error("ops alert failed (non-fatal)", err && err.message);
    return false;
  }
}
