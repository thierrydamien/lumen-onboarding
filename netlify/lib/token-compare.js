// Constant-time secret comparison, shared by every function that checks a
// bearer-style token (DASHBOARD_TOKEN, SEED_WRITE_TOKEN, APPS_SCRIPT_SECRET).
//
// Extracted from session-admin.js, which had this right, after an audit found
// seed.js and session.js were comparing with plain === / !== instead — a
// byte-by-byte timing side channel on the response time. Remote exploitation
// over the internet is hard, but the repo is public, so the source itself is
// no longer part of the defense; only the comparison is. One shared
// implementation means the three call sites can't drift apart again.
//
// Length is compared first because timingSafeEqual THROWS on a length
// mismatch rather than returning false; leaking only the length of a long
// random secret is not useful to an attacker.
import crypto from "node:crypto";

export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
