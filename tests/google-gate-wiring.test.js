// The gate is only worth anything if every write endpoint actually calls it,
// and if the page attaches the token to every write. verifyGoogleIdToken can be
// perfect and the tool still wide open if one endpoint forgets — so this file
// checks the wiring rather than the logic (that lives in google-auth.test.js).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const sales = read("public/sales.html");
// Every endpoint that WRITES on behalf of the Sales page. Adding a fourth write
// endpoint without adding it here is the failure mode this list guards against.
const WRITE_ENDPOINTS = [
  "netlify/functions/seed.js",
  "netlify/functions/parse-brief.js",
  "netlify/functions/preview-brief.js",
];

describe("every Sales write endpoint enforces the gate", () => {
  for (const f of WRITE_ENDPOINTS) {
    it(`${f} verifies server-side`, () => {
      const s = read(f);
      expect(s, `${f} does not import the gate`).toMatch(/import \{ verifyGoogleAuth \} from "\.\.\/lib\/google-auth\.js"/);
      expect(s, `${f} imports but never calls it`).toMatch(/await verifyGoogleAuth\(req\)/);
      expect(s, `${f} calls it but ignores the verdict`).toMatch(/if \(!gauth\.ok\)/);
      expect(s, `${f} does not 401 on failure`).toMatch(/unauthorized_google/);
    });
  }

  it("checks it BEFORE doing any work", () => {
    // seed.js must not write the record, and preview-brief must not spend money
    // on a model call, before deciding the caller is allowed in.
    const seed = read("netlify/functions/seed.js");
    expect(seed.indexOf("await verifyGoogleAuth(req)")).toBeLessThan(seed.indexOf("store.setJSON"));
    const prev = read("netlify/functions/preview-brief.js");
    expect(prev.indexOf("await verifyGoogleAuth(req)")).toBeLessThan(prev.indexOf("ANTHROPIC_URL,"));
  });
});

describe("the Sales page sends the token on every write", () => {
  it("wraps all three write calls in googleHeaders()", () => {
    // One un-wrapped call = that path 401s for every rep once the gate is on.
    expect((sales.match(/googleHeaders\(/g) || []).length).toBeGreaterThanOrEqual(4); // 1 definition + 3 call sites
    for (const fn of ["functions/seed", "functions/parse-brief", "functions/preview-brief"]) {
      const i = sales.indexOf(fn);
      expect(i, fn).toBeGreaterThan(-1);
    }
  });

  it("keeps the ID token in memory, never in storage", () => {
    // Tokens expire in about an hour; a stale one in localStorage would produce
    // confusing 401s on the next day's first click.
    expect(sales).not.toMatch(/(local|session)Storage\.setItem\(\s*["'][^"']*google/i);
    expect(sales).toMatch(/GOOGLE = \{ on: false/);
  });

  it("tells a Google 401 apart from a write-token 401", () => {
    // Clearing the stored write token because the GOOGLE token expired would log
    // the rep out of the wrong thing and prompt for the wrong secret.
    expect(sales).toMatch(/async function is401Google\(res\)/);
    expect(sales).toMatch(/res\.clone\(\)/); // body must stay readable for the caller
    expect((sales.match(/await is401Google\(res\)/g) || []).length).toBe(3);
    expect(sales).toMatch(/function reauthGoogle\(/);
  });

  it("does not lock reps out when the config endpoint is unreachable", () => {
    // The server is the real enforcement point, so failing open HERE only means a
    // rep sees a clear 401 from Generate instead of a mystifying blank gate.
    const init = sales.slice(sales.indexOf("async function initGoogleGate()"));
    expect(init.slice(0, 900)).toMatch(/catch \(e\) \{[\s\S]*?return;/);
  });

  it("is actually invoked on page load", () => {
    // Defined but never called is the classic way a gate ships switched off.
    expect(sales).toMatch(/^\s*initGoogleGate\(\);/m);
  });
});

describe("app-config exposes only what the page needs", () => {
  const cfg = read("netlify/functions/app-config.js");

  it("returns the flag, client id and domain — and nothing else", () => {
    const keys = (cfg.match(/JSON\.stringify\(\s*\{([^}]*)\}/) || [, ""])[1];
    expect(keys).toContain("googleAuth");
    expect(keys).toContain("clientId");
    expect(keys).toContain("domain");
    // It is unauthenticated by necessity (the page calls it before sign-in), so
    // it must never become a general environment dump.
    expect(cfg).not.toMatch(/SEED_WRITE_TOKEN|DASHBOARD_TOKEN|ANTHROPIC_API_KEY/);
  });

  it("reports the gate as off unless both values are present", () => {
    expect(cfg).toMatch(/googleAuth = !!\(clientId && domain\)/);
    // And withholds the id when off, so a half-configured site can't half-work.
    expect(cfg).toMatch(/googleAuth \? clientId : ""/);
  });
});
