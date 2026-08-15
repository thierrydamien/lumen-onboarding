// tokenMatches — the constant-time comparison every secret check in
// netlify/functions/ now shares.
//
// Found during a public-repo audit: session.js and seed.js compared their
// DASHBOARD_TOKEN/SEED_WRITE_TOKEN with plain === / !==, a byte-by-byte timing
// side channel, while session-admin.js already did this correctly. Remote
// exploitation over HTTP is hard, but the source is public, so only the
// comparison itself is still part of the defense — extracted so all five call
// sites (session GET, seed GET/POST, parse-brief, preview-brief, the Apps
// Script writeback) share one implementation instead of being able to drift.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tokenMatches } from "../netlify/lib/token-compare.js";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

describe("tokenMatches", () => {
  it("accepts the correct secret", () => {
    expect(tokenMatches("a-long-random-secret-123", "a-long-random-secret-123")).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(tokenMatches("a-long-random-secret-124", "a-long-random-secret-123")).toBe(false);
  });

  it("rejects a shorter or longer guess without throwing", () => {
    // timingSafeEqual THROWS on a length mismatch; a naive caller forwarding
    // that exception would 500 instead of 401 on every wrong-length guess.
    expect(() => tokenMatches("short", "a-long-random-secret-123")).not.toThrow();
    expect(tokenMatches("short", "a-long-random-secret-123")).toBe(false);
    expect(tokenMatches("a-long-random-secret-123-and-then-some", "a-long-random-secret-123")).toBe(false);
  });

  it("rejects when either side is missing or the wrong type", () => {
    for (const bad of [null, undefined, 123, {}, [], ""]) {
      expect(tokenMatches(bad, "a-long-random-secret-123")).toBe(false);
      expect(tokenMatches("a-long-random-secret-123", bad)).toBe(false);
    }
  });

  it("does not leak comparison time proportional to the matching prefix", () => {
    // Not a real timing-attack simulation (impossible to measure meaningfully in
    // a shared CI runner) — this only checks the function doesn't short-circuit
    // via string equality before reaching timingSafeEqual, by confirming it
    // still delegates for a same-length near-miss rather than fast-pathing on
    // instance equality. If someone "optimises" this back to `a === b` first,
    // the fast path bypasses timingSafeEqual entirely.
    const src = read("netlify/lib/token-compare.js");
    expect(src).toMatch(/crypto\.timingSafeEqual\(a, b\)/);
    expect(src).not.toMatch(/provided === expected/);
  });
});

describe("every secret check in netlify/functions uses it", () => {
  const FILES = ["netlify/functions/session.js", "netlify/functions/seed.js",
                 "netlify/functions/session-admin.js", "netlify/functions/parse-brief.js",
                 "netlify/functions/preview-brief.js"];

  for (const f of FILES) {
    it(`${f} imports the shared comparator`, () => {
      const s = read(f);
      expect(s).toMatch(/import \{ tokenMatches \} from "\.\.\/lib\/token-compare\.js"/);
    });
  }

  it("no function still compares a secret with plain === / !==", () => {
    for (const f of FILES) {
      const s = read(f);
      expect(s, f).not.toMatch(/provided === expected|provided !== expected/);
      expect(s, f).not.toMatch(/req\.headers\.get\("x-app-write-token"\) !== writeToken/);
      expect(s, f).not.toMatch(/body\.secret !== wbSecret/);
    }
  });
});
