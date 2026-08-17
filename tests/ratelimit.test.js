// netlify/lib/ratelimit.js — the per-IP limiter behind every write endpoint
// (draft, session, sheet, session-admin, parse-brief, preview-brief).
//
// It had no tests at all, which mattered because it is the only thing standing
// between a spoofed Origin and either an unbounded Anthropic bill (preview-brief)
// or unlimited fabricated rows in the internal dashboard (session).
//
// These EXECUTE the real module against a fake Blobs store rather than reading the
// source, because the defects found here are all arithmetic on a stored value and
// none of them are visible by inspection.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

let STORE = new Map();
let getThrows = false, setThrows = false, storeThrows = false;

vi.mock("@netlify/blobs", () => ({
  getStore: () => {
    if (storeThrows) throw new Error("blobs unavailable");
    return {
      get: async (k) => { if (getThrows) throw new Error("read failed"); return STORE.get(k) ?? null; },
      // Round-trips through JSON exactly as setJSON does, which is load-bearing:
      // it is why an array record silently drops its counters and why NaN lands as
      // null. Storing the object by reference would hide both.
      setJSON: async (k, v) => { if (setThrows) throw new Error("write failed"); STORE.set(k, JSON.parse(JSON.stringify(v))); },
    };
  },
}));

const { rateLimit, clientIp, tooMany } = await import("../netlify/lib/ratelimit.js");

const req = (ip = "1.2.3.4") => new Request("https://x.test/", { headers: { "x-nf-client-connection-ip": ip } });
const callN = async (n, r, bucket, lim) => {
  const out = [];
  for (let i = 0; i < n; i++) out.push((await rateLimit(r, bucket, lim)).ok);
  return out;
};

beforeEach(() => { STORE = new Map(); getThrows = setThrows = storeThrows = false; });

describe("it actually limits", () => {
  it("allows exactly perMin requests, then refuses", async () => {
    expect(await callN(5, req(), "b", { perMin: 3, perHour: 100 }))
      .toEqual([true, true, true, false, false]);
  });

  it("applies the hour budget independently of the minute one", async () => {
    expect(await callN(4, req(), "b", { perMin: 100, perHour: 2 }))
      .toEqual([true, true, false, false]);
  });

  it("counts each endpoint separately", async () => {
    // Otherwise a client autosaving a long draft exhausts the budget for
    // generating their Sheet.
    const r = req();
    await callN(3, r, "draft", { perMin: 2, perHour: 100 });
    expect((await rateLimit(r, "sheet", { perMin: 2, perHour: 100 })).ok).toBe(true);
  });

  it("counts each IP separately", async () => {
    await callN(3, req("9.9.9.9"), "b", { perMin: 2, perHour: 100 });
    expect((await rateLimit(req("8.8.8.8"), "b", { perMin: 2, perHour: 100 })).ok).toBe(true);
  });

  it("reports a usable Retry-After for each window", async () => {
    const r = req();
    await callN(3, r, "b", { perMin: 2, perHour: 100 });
    expect((await rateLimit(r, "b", { perMin: 2, perHour: 100 })).retryAfter).toBe(60);
    STORE = new Map();
    await callN(3, r, "b", { perMin: 100, perHour: 2 });
    expect((await rateLimit(r, "b", { perMin: 100, perHour: 2 })).retryAfter).toBe(3600);
  });

  it("rolls the window once it has elapsed", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const r = req();
      expect(await callN(3, r, "b", { perMin: 2, perHour: 999 })).toEqual([true, true, false]);
      vi.setSystemTime(new Date("2026-01-01T00:01:01Z")); // past the minute
      expect((await rateLimit(r, "b", { perMin: 2, perHour: 999 })).ok).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("a malformed stored record cannot break it", () => {
  // Every one of these was measured against the unguarded version. Two failed
  // OPEN (limit bypassed for good), one failed CLOSED (that IP locked out of the
  // endpoint for good), and two threw a TypeError straight past the module's two
  // storage catches. None of them is visible by reading the code.
  const SHAPES = {
    "an empty object": {},
    "a string": "garbage",
    "a number": 42,
    "an array": [],
    "null fields": { mStart: null, mCount: null, hStart: null, hCount: null },
    "non-numeric timestamps": { mStart: "x", mCount: "y", hStart: "x", hCount: "y" },
    "missing counters": { mStart: Date.now(), hStart: Date.now() },
    "Infinity": { mStart: Infinity, mCount: Infinity, hStart: Infinity, hCount: Infinity },
  };

  for (const [label, bad] of Object.entries(SHAPES)) {
    it(`recovers from ${label}`, async () => {
      STORE = new Map([["b:1.2.3.4", bad]]);
      // Must behave exactly like a fresh record: two through, then refused.
      await expect(callN(6, req(), "b", { perMin: 2, perHour: 50 }))
        .resolves.toEqual([true, true, false, false, false, false]);
    });

    it(`rewrites ${label} as a well-formed record instead of preserving it`, async () => {
      // The array case is the reason this is asserted separately: it "worked" on
      // every call while silently never persisting a counter, so only the stored
      // value shows the difference.
      STORE = new Map([["b:1.2.3.4", bad]]);
      await callN(3, req(), "b", { perMin: 2, perHour: 50 });
      const rec = STORE.get("b:1.2.3.4");
      expect(Array.isArray(rec)).toBe(false);
      expect(typeof rec).toBe("object");
      for (const k of ["mStart", "mCount", "hStart", "hCount"]) {
        expect(Number.isFinite(rec[k]), `${k} should be a finite number after recovery`).toBe(true);
      }
    });
  }

  it("never throws out of rateLimit, whatever is stored", async () => {
    // The module promises to fail open on storage trouble. A TypeError escaping to
    // the caller is a different failure entirely, and no caller wraps it.
    for (const bad of Object.values(SHAPES)) {
      STORE = new Map([["b:1.2.3.4", bad]]);
      await expect(rateLimit(req(), "b", { perMin: 5, perHour: 5 })).resolves.toBeTruthy();
    }
  });
});

describe("it fails open on storage trouble, as documented", () => {
  it("allows the request when the store cannot be opened", async () => {
    storeThrows = true;
    expect((await rateLimit(req(), "b", { perMin: 0, perHour: 0 })).ok).toBe(true);
  });

  it("allows the request when the read fails", async () => {
    getThrows = true;
    expect((await rateLimit(req(), "b", { perMin: 0, perHour: 0 })).ok).toBe(true);
  });

  it("stops limiting entirely while writes are failing", async () => {
    // Not a bug — it is the fail-open posture — but it is worth pinning, because
    // the original comment said a lost write "resets a bucket", which understates
    // it: a Blobs write outage disables this control completely while reads still
    // succeed, and nothing surfaces that.
    setThrows = true;
    expect(await callN(5, req(), "b", { perMin: 2, perHour: 9 }))
      .toEqual([true, true, true, true, true]);
  });
});

describe("client identity", () => {
  it("prefers the header the platform sets over the one a caller can forge", async () => {
    expect(clientIp(new Request("https://x.test/", {
      headers: { "x-nf-client-connection-ip": "1.1.1.1", "x-forwarded-for": "9.9.9.9" },
    }))).toBe("1.1.1.1");
  });

  it("takes the first hop from x-forwarded-for when the platform header is absent", async () => {
    expect(clientIp(new Request("https://x.test/", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    }))).toBe("9.9.9.9");
  });

  it("buckets unidentifiable callers together rather than giving each a fresh budget", async () => {
    // Sharing one bucket is the safe direction: a caller who strips both headers
    // gets MORE limited, not less.
    expect(clientIp(new Request("https://x.test/"))).toBe("unknown");
    const anon = new Request("https://x.test/");
    expect(await callN(4, anon, "b", { perMin: 2, perHour: 99 }))
      .toEqual([true, true, false, false]);
  });
});

describe("chat.js's own copy of the limiter carries the same guard", () => {
  // chat.js deliberately keeps its own copy (it picks a tier from the seed), so
  // the fix has to be made twice. It matters MORE there: that path runs on every
  // client turn, so a record whose mStart is not a number means the minute window
  // never rolls and the client's onboarding simply stops mid-conversation on a
  // 429 that never clears. Source-parsed because the function is not exported;
  // the behaviour it produces is proved above against the identical lib version.
  const chat = readFileSync(new URL("../netlify/functions/chat.js", import.meta.url), "utf8");
  const fn = chat.slice(chat.indexOf("async function rateLimit(ip, seeded)"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  it("validates the record shape before doing arithmetic on it", () => {
    expect(body).toMatch(/Number\.isFinite\(rec\.mStart\)/);
    expect(body).toMatch(/Number\.isFinite\(rec\.hStart\)/);
    expect(body).toMatch(/Number\.isFinite\(rec\.mCount\)/);
    expect(body).toMatch(/Number\.isFinite\(rec\.hCount\)/);
    expect(body).toMatch(/!Array\.isArray\(rec\)/);
  });

  it("falls back to a fresh window, and does so before the window roll", () => {
    expect(body).toMatch(/if \(!usable\) rec = \{ mStart: now, mCount: 0, hStart: now, hCount: 0 \};/);
    expect(body.indexOf("if (!usable)")).toBeLessThan(body.indexOf("rec.mCount++"));
    expect(body.indexOf("if (!usable)")).toBeLessThan(body.indexOf("now - rec.mStart"));
  });
});

describe("the 429 it hands back", () => {
  it("carries the status, the code and a Retry-After header", async () => {
    const res = tooMany(42);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    await expect(res.json()).resolves.toEqual({ error: "rate_limited", retryAfter: 42 });
  });
});
