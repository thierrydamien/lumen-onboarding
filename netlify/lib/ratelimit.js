// Shared per-IP fixed-window rate limiter for the write endpoints.
//
// Lives OUTSIDE netlify/functions on purpose: netlify.toml points the functions
// directory at netlify/functions, so anything in here is bundled as a dependency
// rather than being deployed as its own callable function.
//
// Modelled on the limiter already proven in chat.js: fixed windows kept in Blobs,
// FAILING OPEN on any storage error so a Blobs incident can never lock a real client
// out of finishing their onboarding. Deliberately NOT atomic — Blobs has no CAS, so
// concurrent requests can undercount. That is an accepted tradeoff: this exists to
// stop a script running up an Anthropic bill or flooding the session store, not to
// enforce an exact quota.
//
// chat.js keeps its own copy rather than importing this, because it additionally
// picks a tier from the seed. Leaving that hot path untouched was deliberate.

import { getStore } from "@netlify/blobs";

const RL_STORE = "lumen-ratelimit";
const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

export function clientIp(req) {
  return req.headers.get("x-nf-client-connection-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
}

// bucket namespaces the counter per endpoint, so a client autosaving a long session
// can never exhaust the budget for, say, generating their Sheet.
export async function rateLimit(req, bucket, { perMin, perHour }) {
  const now = Date.now();
  let store;
  try { store = getStore(RL_STORE); } catch { return { ok: true }; }   // fail open
  const key = bucket + ":" + clientIp(req);
  let rec;
  try { rec = await store.get(key, { type: "json" }); } catch { return { ok: true }; }
  // Anything that is not the exact shape we wrote is treated as absent. Without
  // this a malformed record is permanently self-sustaining, and it fails BOTH
  // ways — neither of which is the fail-open this module promises:
  //   - non-numeric mStart/hStart: `now - mStart` is NaN, so `>= MIN_MS` is never
  //     true, the window never rolls, and that IP is locked out of the endpoint
  //     for good.
  //   - an array: `rec.mCount++` sets a non-index property, which JSON drops on
  //     write, so the counter never persists and the limit is bypassed for good.
  //   - a string or number: `rec.mCount++` throws a TypeError straight out of
  //     here, past the two storage catches above.
  // Measured, all four shapes, before and after. Cheap to check and every failure
  // it prevents is silent.
  const usable = rec && typeof rec === "object" && !Array.isArray(rec)
    && Number.isFinite(rec.mStart) && Number.isFinite(rec.hStart)
    && Number.isFinite(rec.mCount) && Number.isFinite(rec.hCount);
  if (!usable) rec = { mStart: now, mCount: 0, hStart: now, hCount: 0 };
  if (now - rec.mStart >= MIN_MS) { rec.mStart = now; rec.mCount = 0; }
  if (now - rec.hStart >= HOUR_MS) { rec.hStart = now; rec.hCount = 0; }
  rec.mCount++; rec.hCount++;
  const overMin = rec.mCount > perMin, overHour = rec.hCount > perHour;
  // Best effort. Note that if writes fail PERSISTENTLY the counter never advances,
  // so the limiter stops limiting altogether rather than merely losing a bucket.
  // That is consistent with the fail-open posture above, but it is worth knowing:
  // a Blobs write outage disables this control silently while reads still succeed.
  try { await store.setJSON(key, rec); } catch { /* see above */ }
  if (overMin || overHour) {
    const secs = overHour ? Math.ceil((rec.hStart + HOUR_MS - now) / 1000)
                          : Math.ceil((rec.mStart + MIN_MS - now) / 1000);
    return { ok: false, retryAfter: Math.max(1, secs) };
  }
  return { ok: true };
}

export function tooMany(retryAfter) {
  return new Response(JSON.stringify({ error: "rate_limited", retryAfter }), {
    status: 429,
    headers: { "Content-Type": "application/json", "Retry-After": String(retryAfter) },
  });
}
