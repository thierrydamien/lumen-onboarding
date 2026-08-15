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
    get: async () => null,
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
