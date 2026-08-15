// The Google Sign-In gate on the Sales page's write endpoints.
//
// The Sales page has no login and is reachable by anyone who guesses the URL —
// including a client, who would find a form that says "Notes for the assistant —
// the client never sees this". A password was ruled out (it has to be
// zero-friction for reps); the team's Gmail sits behind Okta, so "already signed
// into your work Google account" is the gate.
//
// verifyGoogleIdToken is pure — token in, verdict out — so it is EXERCISED with
// canned tokeninfo responses rather than pattern-matched. The forgery cases are
// the point: a token that is real but issued to a DIFFERENT app, or belongs to a
// personal Gmail, must be rejected just as firmly as a garbage string.

import { describe, it, expect } from "vitest";
import { verifyGoogleIdToken, verifyGoogleAuth, googleGateConfigured } from "../netlify/lib/google-auth.js";

const CLIENT_ID = "313512206545-umn2k6012lgmkkckjhbcu8vuccthi61i.apps.googleusercontent.com";
const DOMAIN = "hootsuite.com";

/** A fake Google tokeninfo endpoint returning `payload` with status `status`. */
const fakeGoogle = (payload, status = 200) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const goodPayload = {
  aud: CLIENT_ID, hd: DOMAIN, email: "rep@hootsuite.com", email_verified: "true",
};
const verify = (token, payload, status) =>
  verifyGoogleIdToken(token, { clientId: CLIENT_ID, domain: DOMAIN, fetchImpl: fakeGoogle(payload, status) });

describe("verifyGoogleIdToken", () => {
  it("accepts a verified work account", async () => {
    const r = await verify("tok", goodPayload);
    expect(r.ok).toBe(true);
    expect(r.email).toBe("rep@hootsuite.com");
  });

  it("rejects a token Google issued to a DIFFERENT application", async () => {
    // This is the attack the aud check exists for: a real, correctly-signed
    // Google token obtained from any other site, replayed at our endpoint.
    const r = await verify("tok", { ...goodPayload, aud: "999-someone-else.apps.googleusercontent.com" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong_audience");
  });

  it("rejects a personal Gmail account", async () => {
    // No hd claim at all is what a consumer @gmail.com account looks like.
    const { hd, ...noHd } = goodPayload;
    const r = await verify("tok", { ...noHd, email: "someone@gmail.com" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong_domain");
  });

  it("rejects another company's Workspace account", async () => {
    const r = await verify("tok", { ...goodPayload, hd: "evil.com", email: "x@evil.com" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong_domain");
  });

  it("does not trust the email suffix in place of the signed hd claim", async () => {
    // hd is signed by Google; a display email is not the thing to authorise on.
    // An account whose email merely LOOKS right but carries no hd must fail.
    const { hd, ...noHd } = goodPayload;
    const r = await verify("tok", { ...noHd, email: "rep@hootsuite.com" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong_domain");
  });

  it("rejects an unverified email", async () => {
    const r = await verify("tok", { ...goodPayload, email_verified: "false" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("email_unverified");
  });

  it("accepts email_verified as a real boolean too", async () => {
    // tokeninfo documents the string "true"; accept both so a response-format
    // change does not lock every rep out.
    const r = await verify("tok", { ...goodPayload, email_verified: true });
    expect(r.ok).toBe(true);
  });

  it("rejects an expired or malformed token (tokeninfo 400)", async () => {
    const r = await verify("tok", { error: "invalid_token", error_description: "Invalid Value" }, 400);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("Invalid Value");
  });

  it("rejects a missing token without calling Google at all", async () => {
    let called = false;
    const r = await verifyGoogleIdToken("", {
      clientId: CLIENT_ID, domain: DOMAIN,
      fetchImpl: async () => { called = true; return { ok: true, json: async () => goodPayload }; },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_token");
    expect(called).toBe(false);
  });

  it("FAILS CLOSED when Google is unreachable", async () => {
    // A network blip must not become an open door on the endpoint that writes
    // confidential notes. Contrast with the rate limiter, which fails OPEN by
    // design because its job is cost control, not access control.
    const r = await verifyGoogleIdToken("tok", {
      clientId: CLIENT_ID, domain: DOMAIN,
      fetchImpl: async () => { throw new Error("network down"); },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("tokeninfo_unreachable");
  });

  it("fails closed if the gate is half-configured", async () => {
    const r = await verifyGoogleIdToken("tok", { clientId: CLIENT_ID, domain: "", fetchImpl: fakeGoogle(goodPayload) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("gate_misconfigured");
  });
});

describe("the gate's on/off switch", () => {
  it("is off unless BOTH the client id and the domain are set", () => {
    // A client id with no domain would authenticate anyone with any Google
    // account and look secure while doing it — worse than no gate.
    expect(googleGateConfigured({})).toBe(false);
    expect(googleGateConfigured({ GOOGLE_CLIENT_ID: CLIENT_ID })).toBe(false);
    expect(googleGateConfigured({ ALLOWED_EMAIL_DOMAIN: DOMAIN })).toBe(false);
    expect(googleGateConfigured({ GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_EMAIL_DOMAIN: DOMAIN })).toBe(true);
  });

  it("is a transparent no-op when unconfigured, so existing sites are unchanged", async () => {
    const req = { headers: { get: () => null } };
    const r = await verifyGoogleAuth(req, { env: {} });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
  });

  it("reads the token from the x-google-id-token header once configured", async () => {
    const req = { headers: { get: (k) => (k === "x-google-id-token" ? "tok" : null) } };
    const r = await verifyGoogleAuth(req, {
      env: { GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_EMAIL_DOMAIN: DOMAIN },
      fetchImpl: fakeGoogle(goodPayload),
    });
    expect(r.ok).toBe(true);
    expect(r.email).toBe("rep@hootsuite.com");
  });

  it("rejects a configured site when the header is absent", async () => {
    const req = { headers: { get: () => null } };
    const r = await verifyGoogleAuth(req, {
      env: { GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_EMAIL_DOMAIN: DOMAIN },
      fetchImpl: fakeGoogle(goodPayload),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("missing_token");
  });
});
