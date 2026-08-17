// netlify/functions/keep-warm.js — the every-minute scheduled ping.
//
// Low risk in itself, but it runs 4 requests a minute forever, so the property
// that actually matters is the one its own comment claims: each target rejects a
// bare GET BEFORE doing anything that costs money or touches state. That claim is
// about four OTHER files, so nothing was stopping a later edit from quietly
// invalidating it — and the failure would be silent and continuous.
//
// The specific thing guarded against: chat.js rejects non-POST at the top and
// only rate-limits further down. If those were ever reordered, this ping would
// spend the rate-limit budget for the "unknown" IP bucket every single minute,
// and any real client arriving without the platform's IP header would be locked
// out by our own cron.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../netlify/functions/${f}`, import.meta.url), "utf8");
const keepWarm = read("keep-warm.js");

describe("what it pings", () => {
  it("pings the whole sync-first critical path and nothing else", () => {
    const targets = [...keepWarm.matchAll(/"\/\.netlify\/functions\/([\w-]+)"/g)].map(m => m[1]);
    expect(new Set(targets)).toEqual(new Set(["chat", "chat-background", "chat-status", "seed"]));
  });

  it("runs on the schedule the comment describes", () => {
    expect(keepWarm).toMatch(/export const config = \{ schedule: "\* \* \* \* \*" \}/);
  });
});

describe("no target can be woken into doing real work", () => {
  it("chat rejects a non-POST before it ever reaches the rate limiter", () => {
    // The important ordering. Reversing these would have the cron consuming the
    // shared "unknown" IP bucket 1440 times a day.
    // Scope to generateReply, which is what `export default` delegates to.
    // Searching the whole file matches "anthropic" in the header comment at char
    // 15, and the assertion passes vacuously — which is how the first version of
    // this test "passed".
    const chat = read("chat.js");
    const fn = chat.slice(chat.indexOf("async function generateReply"));
    expect(fn.length).toBeGreaterThan(0);
    const method = fn.indexOf('req.method !== "POST"');
    const limiter = fn.indexOf("await rateLimit(clientIp(req)");
    const model = fn.indexOf("ANTHROPIC_URL");
    expect(method).toBeGreaterThan(-1);
    expect(limiter).toBeGreaterThan(-1);
    expect(model).toBeGreaterThan(-1);
    expect(method).toBeLessThan(limiter);
    expect(method).toBeLessThan(model);
  });

  it("chat-background bails on a missing rid before opening the job store", () => {
    const bg = read("chat-background.js");
    const body = bg.slice(bg.indexOf("export default"));
    const bail = body.indexOf("if (!RID_RE.test(rid))");
    const store = body.indexOf("getStore(JOB_STORE)");
    expect(bail).toBeGreaterThan(-1);
    expect(bail).toBeLessThan(store);
  });

  it("chat-status rejects an absent id before reading anything", () => {
    const st = read("chat-status.js");
    const body = st.slice(st.indexOf("export default"));
    const bail = body.indexOf('return json(400, { error: "bad_id" })');
    const store = body.indexOf("getStore(");
    expect(bail).toBeGreaterThan(-1);
    if (store > -1) expect(bail).toBeLessThan(store);
  });

  it("seed refuses an unauthenticated listing rather than enumerating the store", () => {
    // A bare GET has no id and no token, so it must hit the 401 and never reach
    // store.list() — which would otherwise read every seed in the account, once a
    // minute, forever.
    // Scope to the GET branch. seed.js also lists in its POST branch (the
    // duplicate-client scan), which sits EARLIER in the file, so comparing raw
    // file offsets compares two unrelated branches and always fails.
    const seed = read("seed.js");
    const getBranch = seed.slice(seed.indexOf('if (req.method === "GET")'));
    const unauth = getBranch.indexOf('if (!authed) return json(401, { error: "unauthorized" })');
    const list = getBranch.indexOf("await store.list()");
    expect(unauth).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(-1);
    expect(unauth).toBeLessThan(list);
  });
});

describe("the pinger itself", () => {
  let calls, warns;
  beforeEach(() => {
    calls = []; warns = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation((...a) => warns.push(a.join(" ")));
  });
  afterEach(() => { vi.restoreAllMocks(); delete process.env.URL; });

  const load = async () => (await import("../netlify/functions/keep-warm.js?" + Math.random())).default;

  it("does nothing at all when the site URL is not configured", async () => {
    // Without this it would fetch relative paths against no origin, once a minute.
    delete process.env.URL;
    vi.stubGlobal("fetch", async (u) => { calls.push(u); return new Response("", { status: 200 }); });
    const res = await (await load())();
    expect(calls).toEqual([]);
    expect(res.status).toBe(200);
    expect(warns.join(" ")).toMatch(/URL env not set/);
    vi.unstubAllGlobals();
  });

  it("pings every target with a bare GET, carrying no body and no credentials", async () => {
    process.env.URL = "https://lumen-onboarding.netlify.app";
    const seen = [];
    vi.stubGlobal("fetch", async (u, opts) => { seen.push({ u, opts }); return new Response("", { status: 405 }); });
    await (await load())();
    expect(seen).toHaveLength(4);
    for (const { u, opts } of seen) {
      expect(u.startsWith("https://lumen-onboarding.netlify.app/.netlify/functions/")).toBe(true);
      expect(opts.method).toBe("GET");
      expect(opts.body).toBeUndefined();
      expect(opts.headers).toBeUndefined();
    }
    vi.unstubAllGlobals();
  });

  it("still reports success when a target is unreachable", async () => {
    // It is a scheduled function: returning non-2xx invites the platform to retry,
    // and a warm-up is never worth retrying.
    process.env.URL = "https://lumen-onboarding.netlify.app";
    vi.stubGlobal("fetch", async () => { throw new Error("network down"); });
    const res = await (await load())();
    expect(res.status).toBe(200);
    expect(warns.join(" ")).toMatch(/keep-warm failed/);
    vi.unstubAllGlobals();
  });
});
