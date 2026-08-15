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
  // Dashboard surfaces: every client's PII, transcripts and consultant notes.
  // The shared DASHBOARD_TOKEN is a secret people paste into Slack, so it gets
  // the same second lock.
  "netlify/functions/session.js",
  "netlify/functions/session-admin.js",
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

  it("delegates the gate to the shared module rather than its own copy", () => {
    // This used to assert the token was memory-only. That was CHANGED on purpose:
    // memory-only meant a fresh sign-in on every page load, which is the friction
    // that makes a tool go unused. It is now reused until it actually expires —
    // see tests/google-gate-module.test.js for the expiry rules.
    expect(sales).toMatch(/<script src="\/google-gate\.js"><\/script>/);
    expect(sales).toMatch(/LumenGoogleGate\.create\(/);
    // And no second, drifting copy of the logic left behind in the page.
    expect(sales).not.toMatch(/accounts\.google\.com\/gsi\/client/);
  });

  it("tells a Google 401 apart from a write-token 401", () => {
    // Clearing the stored write token because the GOOGLE token expired would log
    // the rep out of the wrong thing and prompt for the wrong secret.
    expect(sales).toMatch(/async function is401Google\(res\)/);
    expect(sales).toMatch(/res\.clone\(\)/); // body must stay readable for the caller
    expect((sales.match(/await is401Google\(res\)/g) || []).length).toBe(3);
    expect(sales).toMatch(/function reauthGoogle\(/);
  });

  it("routes init through the shared module", () => {
    // Fail-open-on-config-failure now lives in google-gate.js and is tested there.
    expect(sales).toMatch(/function initGoogleGate\(\) \{ return GGATE\.init\(\); \}/);
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

describe("the dashboard's second lock does not reach the client", () => {
  const session = read("netlify/functions/session.js");
  const seed = read("netlify/functions/seed.js");
  const dash = read("public/dashboard.html");

  it("gates session READS but never the client's own save", () => {
    // POST is a stranger on the internet finishing their onboarding; they are
    // not signed into a Hootsuite account and must never need to be.
    const getAt = session.indexOf('if (req.method === "GET")');
    const gateAt = session.indexOf("await verifyGoogleAuth(req)");
    expect(gateAt).toBeGreaterThan(getAt); // the check lives inside the GET branch
  });

  it("gates the seed record only for a caller presenting a dashboard token", () => {
    // The same branch serves the client's prefill fetch; gating it wholesale
    // would break every onboarding link.
    expect(seed).toMatch(/if \(authed\) \{\s*\n\s*const gauth = await verifyGoogleAuth\(req\)/);
  });

  it("rejects rather than silently downgrading a token-holder who fails Google", () => {
    // A silent downgrade would render the notes panel as "No notes." — read as
    // missing data, not as a failed sign-in.
    const i = seed.indexOf("if (authed) {");
    expect(seed.slice(i, i + 260)).toContain("unauthorized_google");
  });

  it("sends the token on all three dashboard fetches, including the background poll", () => {
    // A missed poll would 401 every 90 seconds behind the scenes.
    expect((dash.match(/googleHeaders\(/g) || []).length).toBeGreaterThanOrEqual(4);
    const poll = dash.slice(dash.indexOf("function pollUpdates()"));
    expect(poll.slice(0, 600)).toMatch(/googleHeaders\(/);
  });

  it("resolves the gate before the first read, not after", () => {
    // Loading first fires a guaranteed 401 and stacks the token card behind the
    // sign-in card — two prompts, the wrong one on top.
    expect(dash).toMatch(/initGoogleGate\(\)\.then\(function \(gate\) \{/);
    // THREE outcomes, not two. "unlocked" (a reused, still-valid token) is truthy,
    // so folding it in with "waiting for sign-in" left the dashboard permanently
    // stuck on an empty table — caught by driving the page, not by reading it.
    expect(dash).toMatch(/if \(gate === "unlocked"\) \{ load\(\); return; \}/);
    expect(dash).toMatch(/if \(gate\) \{ _gPending = true; return; \}/);
  });

  it("tells the two 401s apart, so the wrong credential is not cleared", () => {
    const af = dash.slice(dash.indexOf("function authedFetch(url)"));
    expect(af.slice(0, 900)).toMatch(/unauthorized_google/);
    expect(af.slice(0, 900)).toMatch(/reauthGoogle\(/);
  });
});

// The lock stopped a stranger ACTING. It did not stop them LOOKING: the Sales
// gate used a 40%-opacity scrim, so the whole internal form — product tiers,
// package allowances, the "never shown to the client" section, the confidential
// notes box — was readable straight through the sign-in card. Reported from a
// real incognito window, not caught by any test, because every test so far
// asserted the card was PRESENT rather than that the page was UNREADABLE.
describe("a stranger cannot read the internal tools", () => {
  for (const page of ["public/sales.html", "public/dashboard.html"]) {
    const s = read(page);

    it(`${page}: the backdrop is opaque, not a see-through scrim`, () => {
      const gate = s.match(/\.gate \{[^}]*\}/)[0];
      expect(gate, "translucent backdrop leaks the page behind it").not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/);
      expect(gate).toMatch(/background:var\(--bg\)/);
    });

    it(`${page}: content is hidden from FIRST PAINT, not once the card appears`, () => {
      // Without this there is a readable window between paint and the gate
      // resolving — and it also covers scrolling past a card that only covers
      // the viewport.
      expect(s).toMatch(/html\.gate-check \.wrap, html\.gate-locked \.wrap \{ visibility: hidden; \}/);
      // Set synchronously in <body>, before the form markup.
      const setAt = s.indexOf('className += " gate-check"');
      expect(setAt).toBeGreaterThan(-1);
      expect(setAt).toBeLessThan(s.indexOf('<div class="wrap">'));
    });

    it(`${page}: reveals as a last resort ONLY if the gate module never ran`, () => {
      // The old net removed gate-check at 4s unconditionally, which flashed the
      // form while a slow config fetch was still deciding. Now it fires at 8s and
      // only when __lumenGateLoaded was never set — i.e. the module was blocked
      // or failed to parse and can never unlock the page itself.
      expect(s).toMatch(/if \(!window\.__lumenGateLoaded\)/);
      expect(s).toMatch(/classList\.remove\("gate-locked"\)/);
      expect(s).toMatch(/\}, 8000\)/);
    });

    it(`${page}: re-locks when the sign-in expires`, () => {
      // The module's reauth() shows the card, which fires the page's onLock and
      // hides the content again rather than leaving it readable behind the card.
      expect(s).toMatch(/function reauthGoogle\(msg\) \{ (?:_gPending = true; )?GGATE\.reauth\(msg\); \}/);
      expect(s).toMatch(/onLock:\s*function \(\) \{[^}]*add\("gate-locked"\)/);
    });
  }

  it("reveals only on an explicit allow — gate off, or signed in", () => {
    // hideCard() is the module's single unlock path, and it is the ONLY thing
    // that calls onUnlock. Every route to a usable page goes through it.
    const mod = read("public/google-gate.js");
    const hide = mod.slice(mod.indexOf("var hideCard ="));
    expect(hide.slice(0, 260)).toMatch(/onUnlock && opts\.onUnlock\(\)/);
    for (const page of ["public/sales.html", "public/dashboard.html"]) {
      expect(read(page), page).toMatch(/onUnlock:\s*function \(\) \{[^}]*remove\("gate-locked"\)/);
    }
  });
});
