// Google Sign-In gate for the Sales page's write endpoints (seed.js,
// parse-brief.js, preview-brief.js).
//
// WHY: those three endpoints used to be protected by nothing but a same-origin
// Origin header (spoofable outside a browser) plus an OPTIONAL manually-typed
// write token. The Sales page itself has no login at all — it is reachable by
// anyone who guesses the URL, and a client who does so lands on a form that
// says "Notes for the assistant — the client never sees this", which is a bad
// thing for a client to discover. A password was ruled out (it needs to be
// zero-friction for reps), but the team is on Google Workspace behind Okta, so
// "already signed into your work Google account" is a real, zero-typing gate.
//
// DORMANT until BOTH env vars are set — see googleGateConfigured() below — so
// nothing about existing behaviour changes until you opt in, same posture as
// SEED_WRITE_TOKEN:
//   GOOGLE_CLIENT_ID      OAuth 2.0 Web application Client ID from Google Cloud
//                         Console. This is a PUBLIC value by design — it ships
//                         in the page (see public/sales.html's app-config
//                         fetch) — its security comes from the domain check
//                         below and from the OAuth consent screen being set to
//                         "Internal" in Google Cloud, not from being secret.
//   ALLOWED_EMAIL_DOMAIN  e.g. "hootsuite.com"
//
// Verification calls Google's tokeninfo endpoint rather than validating the
// JWT signature locally: at Sales-page volume (a handful of writes a day) the
// extra round trip is irrelevant, and it means this file never has to carry
// its own JWK/signature-verification code — Google's server does that and
// simply errors on a forged, tampered, or expired token.
//
// NOT LIVE-TESTED against a real signed-in Google session — there is no way to
// simulate an actual Hootsuite Google Workspace sign-in from this environment.
// The contract with Google's tokeninfo endpoint (response shape, error cases)
// is implemented per Google's published documentation and exercised here with
// mocked responses; the deploy checklist should include one real sign-in
// before relying on this as the only gate.

const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

/** True once both env vars needed to turn the gate on are set. Takes an `env`
 *  object (defaults to process.env) so callers/tests can pass a plain object
 *  instead of mutating real process.env. */
export function googleGateConfigured(env = process.env) {
  return !!(env.GOOGLE_CLIENT_ID && env.ALLOWED_EMAIL_DOMAIN);
}

// The pure check: given an ID token (a JWT string) and the expected client id
// + domain, ask Google whether it is genuine and report what it says. No
// process.env, no Request object — trivially unit-testable with a fake
// fetchImpl and canned tokeninfo responses.
export async function verifyGoogleIdToken(idToken, { clientId, domain, fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  if (!idToken) return { ok: false, reason: "missing_token" };
  if (!clientId || !domain) return { ok: false, reason: "gate_misconfigured" };

  let info;
  try {
    // Bound the tokeninfo round trip. This function FAILS CLOSED (a throw below
    // becomes a 401), so without a timeout a slow — not even down — tokeninfo
    // would hang every gated request until the platform wall-clock killed it,
    // taking the dashboard and all three write endpoints with it. Every other
    // outbound call in this repo (parse-brief, preview-brief) is already bounded
    // this way. AbortController is passed as a second arg the injected test fetch
    // simply ignores.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try { r = await fetchImpl(`${TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`, { signal: ctl.signal }); }
    finally { clearTimeout(timer); }
    info = await r.json().catch(() => ({}));
    // tokeninfo returns 400 with {error, error_description} for an expired,
    // malformed, or otherwise invalid token — that IS the "not ok" case, not a
    // network failure, so it is reported as a normal rejection reason.
    if (!r.ok) return { ok: false, reason: info.error_description || info.error || "tokeninfo_rejected" };
  } catch (err) {
    return { ok: false, reason: "tokeninfo_unreachable" };
  }

  // aud must be OUR client id, or this is a token Google issued to some OTHER
  // application and replayed here.
  if (info.aud !== clientId) return { ok: false, reason: "wrong_audience" };
  // hd is Google's own "hosted domain" claim — present and signed only for
  // Google Workspace accounts — and is exactly the field that distinguishes
  // "this account belongs to hootsuite.com" from any personal @gmail.com.
  // Checking the email's suffix instead would be checking an unsigned claim.
  if (String(info.hd || "").toLowerCase() !== String(domain).toLowerCase()) {
    return { ok: false, reason: "wrong_domain" };
  }
  // tokeninfo returns this as the STRING "true"/"false", not a boolean.
  if (info.email_verified !== "true" && info.email_verified !== true) {
    return { ok: false, reason: "email_unverified" };
  }
  return { ok: true, email: info.email };
}

// Convenience wrapper the Netlify functions actually call: reads the header +
// env and is a no-op (ok:true, skipped:true) when the gate is not configured,
// so a caller can unconditionally `await verifyGoogleAuth(req)` without its
// own "is this even on" branch — mirrors the existing SEED_WRITE_TOKEN checks,
// which are similarly unconditional and simply pass when the var is unset.
export async function verifyGoogleAuth(req, { env = process.env, fetchImpl = fetch } = {}) {
  if (!googleGateConfigured(env)) return { ok: true, skipped: true };
  const idToken = req.headers.get("x-google-id-token");
  return verifyGoogleIdToken(idToken, {
    clientId: env.GOOGLE_CLIENT_ID,
    domain: env.ALLOWED_EMAIL_DOMAIN,
    fetchImpl,
  });
}
