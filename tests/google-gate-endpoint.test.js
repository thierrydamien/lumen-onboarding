// Does the seed endpoint ACTUALLY reject a forged request?
//
// google-auth.test.js proves the verification logic; google-gate-wiring.test.js
// proves each endpoint calls it. This file closes the loop by driving the real
// exported handler end to end with a fake Google and a fake Blobs store, because
// a gate that is imported, called, and then somehow bypassed by control flow
// would pass both of those and still leak.
//
// Blobs is mocked because seed.js opens the store BEFORE any auth check, so
// without it every request 500s on a missing-environment error and the probe
// says nothing at all — which is exactly what a first attempt at this did.

import { describe, it, expect, vi, beforeEach } from "vitest";

const CLIENT_ID = "313512206545-umn2k6012lgmkkckjhbcu8vuccthi61i.apps.googleusercontent.com";
const ORIGIN = "https://lumen-onboarding-v2.netlify.app";

const written = [];
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    setJSON: async (k, v) => { written.push(v); },
    // A real record for the client-prefill test, so that assertion exercises an
    // actual 200 + field filtering rather than passing vacuously on a 404.
    get: async (k) => (k === "sd_x"
      ? { id: "sd_x", company: "ClientCo", contactName: "Jane", language: "English",
          notes: "CONFIDENTIAL", preparedBy: "Alex", savedAt: new Date().toISOString() }
      : null),
    list: async () => ({ blobs: [] }),
    delete: async () => {},
  }),
}));

// Fake tokeninfo. Each token string stands for a scenario.
const PAYLOADS = {
  GOOD:     { aud: CLIENT_ID, hd: "hootsuite.com", email: "rep@hootsuite.com", email_verified: "true" },
  OTHERAPP: { aud: "999-other.apps.googleusercontent.com", hd: "hootsuite.com", email: "rep@hootsuite.com", email_verified: "true" },
  GMAIL:    { aud: CLIENT_ID, email: "someone@gmail.com", email_verified: "true" },
};
vi.stubGlobal("fetch", async (url) => {
  const tok = new URL(String(url)).searchParams.get("id_token");
  if (PAYLOADS[tok]) return { ok: true, status: 200, json: async () => PAYLOADS[tok] };
  return { ok: false, status: 400, json: async () => ({ error: "invalid_token", error_description: "Invalid Value" }) };
});

const { default: seed } = await import("../netlify/functions/seed.js");

const post = (headers) => seed(new Request(ORIGIN + "/.netlify/functions/seed", {
  method: "POST",
  headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
  body: JSON.stringify({ seed: { company: "ProbeCo", notes: "confidential" } }),
}));

describe("the seed endpoint with the gate switched ON", () => {
  beforeEach(() => {
    written.length = 0;
    vi.stubEnv("URL", ORIGIN);
    vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "hootsuite.com");
  });

  const blocked = [
    ["no token at all — a plain curl", {}],
    ["a garbage token", { "x-google-id-token": "nonsense" }],
    ["a REAL Google token issued to another app", { "x-google-id-token": "OTHERAPP" }],
    ["a personal @gmail.com account", { "x-google-id-token": "GMAIL" }],
  ];

  for (const [label, headers] of blocked) {
    it(`rejects ${label}, and writes nothing`, async () => {
      const res = await post(headers);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized_google");
      // The point of the whole exercise: no seed reached the store.
      expect(written).toHaveLength(0);
    });
  }

  it("lets a signed-in work account through and stores the seed", async () => {
    const res = await post({ "x-google-id-token": "GOOD" });
    expect(res.status).toBe(200);
    expect(written).toHaveLength(1);
    expect(written[0].company).toBe("ProbeCo");
  });
});

describe("the seed endpoint with the gate switched OFF", () => {
  beforeEach(() => {
    written.length = 0;
    vi.stubEnv("URL", ORIGIN);
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("ALLOWED_EMAIL_DOMAIN", "");
  });

  it("behaves exactly as before, so nothing breaks until you opt in", async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(written).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The dashboard gets the same second lock. The danger here is over-reach: the
// SAME two functions also serve the client chat page, which has no login and
// must never need one. These tests exist mainly to prove the client paths were
// left alone — gating them would break onboarding for every client.

const { default: session } = await import("../netlify/functions/session.js");

const ON = { URL: ORIGIN, GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_EMAIL_DOMAIN: "hootsuite.com", DASHBOARD_TOKEN: "dash-secret" };
const stub = (env) => { for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v); };

describe("dashboard reads, gate ON", () => {
  beforeEach(() => { written.length = 0; stub(ON); });

  it("rejects a correct dashboard token with no Google sign-in", () => {
    // The whole point of a second lock: the shared secret alone is no longer
    // enough, so a leaked token is not a breach on its own.
    return session(new Request(ORIGIN + "/.netlify/functions/session", {
      headers: { "x-dashboard-token": "dash-secret" },
    })).then(async (res) => {
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("unauthorized_google");
    });
  });

  it("rejects a correct token with a Google account from another domain", async () => {
    const res = await session(new Request(ORIGIN + "/.netlify/functions/session", {
      headers: { "x-dashboard-token": "dash-secret", "x-google-id-token": "GMAIL" },
    }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("unauthorized_google");
  });

  it("allows a signed-in work account holding the token", async () => {
    const res = await session(new Request(ORIGIN + "/.netlify/functions/session", {
      headers: { "x-dashboard-token": "dash-secret", "x-google-id-token": "GOOD" },
    }));
    expect(res.status).toBe(200);
  });
});

describe("the CLIENT chat page is never gated", () => {
  beforeEach(() => { written.length = 0; stub(ON); });

  it("still saves a session with no Google token at all", async () => {
    // A client is a stranger on the internet finishing their onboarding. If this
    // ever 401s, every client silently loses their progress.
    const res = await session(new Request(ORIGIN + "/.netlify/functions/session", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ session: { id: "cs_1", company: "ClientCo", status: "in_progress" } }),
    }));
    expect(res.status).not.toBe(401);
    expect(written.length).toBeGreaterThan(0);
  });

  it("still fetches its own seed prefill with no Google token", async () => {
    // seed.js GET-by-id serves BOTH the client (client-safe fields) and the
    // dashboard (full record). Only the token-presenting caller is gated.
    const res = await seed(new Request(ORIGIN + "/.netlify/functions/seed?id=sd_x"));
    expect(res.status).toBe(200);
    const { seed: got } = await res.json();
    expect(got.company).toBe("ClientCo");
    // ...and the client-safe filtering still holds: no notes, no preparedBy.
    expect(got.notes).toBeUndefined();
    expect(got.preparedBy).toBeUndefined();
  });
});
