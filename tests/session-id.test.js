// The session-id shape guard added to session.js POST.
//
// This is the highest-consequence guard in the change set: the client mints its own id
// and must keep reusing it so autosaves UPDATE one record rather than creating a new
// one per save. If the guard rejected a legitimate id, the completed brief would 400
// on save — a 15-minute onboarding lost. So every id format that can legitimately
// reach the endpoint is pinned here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

// Read the regex out of session.js rather than restating it, so the test cannot drift
// from the implementation it is meant to protect.
const src = readFileSync(new URL("../netlify/functions/session.js", import.meta.url), "utf8");
const m = /const SESSION_ID_RE = (\/.*\/);/.exec(src);
expect(m, "SESSION_ID_RE not found in session.js").not.toBeNull();
// eslint-disable-next-line no-eval
const SESSION_ID_RE = eval(m[1]);

describe("SESSION_ID_RE accepts every id that can legitimately arrive", () => {
  it("accepts the client's own crypto.randomUUID()", () => {
    // src/lumen.jsx resetSession: sidRef.current = crypto.randomUUID()
    for (let i = 0; i < 50; i++) expect(SESSION_ID_RE.test(crypto.randomUUID())).toBe(true);
  });

  it("accepts the server's current genId() form", () => {
    for (let i = 0; i < 50; i++) expect(SESSION_ID_RE.test("s_" + crypto.randomUUID())).toBe(true);
  });

  it("accepts the LEGACY genId() form still present on stored records", () => {
    // "s_" + base36 timestamp + "_" + base36 random, from before genId moved to
    // crypto.randomUUID. Records written by the old code are still in the store and
    // are still re-POSTed on resume.
    for (let i = 0; i < 50; i++) {
      const legacy = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
      expect(SESSION_ID_RE.test(legacy), legacy).toBe(true);
    }
  });
});

describe("SESSION_ID_RE rejects what it is there to reject", () => {
  it("rejects path-like, oversized and empty keys", () => {
    for (const bad of [
      "",                       // empty
      "../../etc/passwd",       // traversal
      "a/b",                    // path separator
      "a".repeat(65),           // over the 64-char cap
      "id with spaces",
      "id\nwith\nnewlines",
      "id:with:colons",
    ]) {
      expect(SESSION_ID_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
