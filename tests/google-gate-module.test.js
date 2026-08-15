// public/google-gate.js — the shared sign-in gate for the two internal pages.
//
// Extracted from sales.html and dashboard.html once the same ~60 lines needed the
// same auth fix in both. Duplicated auth code drifts, and drift here means one
// page quietly less protected than the other.
//
// The behaviour under test is TOKEN REUSE, which fixes "it asks me to sign in
// every single time": the token used to be memory-only, so every page load and
// every hop between the two tools needed a fresh one from Google. That is silent
// only when auto_select can fire, and auto_select disables itself when the
// browser holds more than one Google session — work + personal, i.e. most people.
//
// The expiry arithmetic is where this goes wrong in either direction: too strict
// and reps are prompted constantly again; too loose and a dead token is sent,
// producing a 401 they cannot explain. So it is exercised, not pattern-matched.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/google-gate.js", import.meta.url), "utf8");

// The module is a browser IIFE attaching to `window`; give it just enough of one.
function loadModule(store = {}) {
  const win = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
  };
  const fn = new Function("window", "document", "atob", "escape", "unescape", "fetch", src + "\n;return window.LumenGoogleGate;");
  return {
    mod: fn(win, { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } },
            (s) => Buffer.from(s, "base64").toString("binary"),
            globalThis.escape, globalThis.unescape, async () => ({ json: async () => ({}) })),
    store,
    win,
  };
}

const jwt = (payload) =>
  "hdr." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".sig";

describe("token expiry arithmetic", () => {
  let mod;
  beforeEach(() => { mod = loadModule().mod; });

  it("reads the expiry out of a token", () => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    expect(mod._payloadOf(jwt({ exp, email: "rep@hootsuite.com" })).email).toBe("rep@hootsuite.com");
    expect(Math.round(mod._msLeft(jwt({ exp })) / 1000)).toBeCloseTo(600, -1);
  });

  it("reports an already-expired token as having no life left", () => {
    expect(mod._msLeft(jwt({ exp: Math.floor(Date.now() / 1000) - 1 }))).toBeLessThan(0);
  });

  it("treats a malformed or unparseable token as expired rather than throwing", () => {
    // A truncated value in storage must not take the whole page down.
    for (const bad of ["", "not-a-jwt", "a.b", "a.!!!.c", jwt({ noExp: 1 })]) {
      expect(() => mod._msLeft(bad)).not.toThrow();
      expect(mod._msLeft(bad)).toBe(0);
    }
  });

  it("survives a non-ASCII name in the payload", () => {
    // Base64 + atob mangles multi-byte characters unless decoded carefully, and a
    // throw here would look like "sign-in is broken" for anyone with an accent
    // in their display name.
    const p = mod._payloadOf(jwt({ exp: 1, name: "Zoë Müller", email: "z@hootsuite.com" }));
    expect(p.name).toBe("Zoë Müller");
  });
});

describe("what the module actually stores", () => {
  it("keeps a token under a single known key, so it can be cleared", () => {
    expect(src).toMatch(/var KEY = "lumen_gid_token"/);
  });

  it("expires tokens EARLY, so one cannot die mid-request", () => {
    // Without the skew a token with 3 seconds left would be sent and 401.
    expect(src).toMatch(/var SKEW_MS = 120000/);
    expect(src).toMatch(/msLeft\(t\) > SKEW_MS/);
  });

  it("drops an expired token from storage instead of leaving it to 401 later", () => {
    const load = src.slice(src.indexOf("function load()"));
    expect(load.slice(0, 300)).toMatch(/localStorage\.removeItem\(KEY\)/);
  });

  it("clears the stored token on a server 401, rather than retrying forever", () => {
    const re = src.slice(src.indexOf("reauth: function"));
    expect(re.slice(0, 300)).toMatch(/state\.token = ""; clear\(\)/);
  });

  it("never treats the unverified payload as authorisation", () => {
    // payloadOf is for the expiry timestamp and a friendlier error only; the
    // server re-verifies every token with Google.
    expect(src).toMatch(/never for authorisation/);
  });
});

describe("silent re-auth", () => {
  it("reuses a still-valid token instead of asking Google again", () => {
    const init = src.slice(src.indexOf("init: function"));
    expect(init).toMatch(/var cached = load\(\);/);
    // Cached token: straight in with "unlocked", and GIS is warmed in the
    // background so a later reauth has a working button (was the dead-card bug).
    expect(init).toMatch(/if \(cached\) \{ state\.token = cached; hideCard\(\); ensureGis\(\); return "unlocked"; \}/);
  });

  it("uses FedCM, which works without third-party cookies", () => {
    // The legacy One Tap rides on third-party cookies, which Chrome is removing;
    // without this, silent re-auth degrades into the account picker.
    expect(src).toMatch(/use_fedcm_for_prompt: true/);
    expect(src).toMatch(/auto_select: true/);
  });

  it("fails CLOSED for visibility if the config endpoint is unreachable", () => {
    // CHANGED from fail-open: the old hideCard() here, racing a slow config fetch
    // against the safety net, flashed the confidential form. Now the page stays
    // hidden behind a reload card. The server is still the real lock, so no ACTION
    // is exposed — this governs only what a stranger can READ.
    const c = src.slice(src.indexOf("Config unreachable. Deliberately FAIL CLOSED"));
    expect(c.slice(0, 900)).toMatch(/opts\.onLock && opts\.onLock\(\)/);
    expect(c.slice(0, 900)).toMatch(/showCard\("Couldn't verify access/);
    expect(c.slice(0, 900)).not.toMatch(/^\s*hideCard\(\);/m); // no hideCard CALL (the word appears in a comment)
  });

  it("bounds the config fetch so a hung one cannot leave the page in limbo", () => {
    expect(src).toMatch(/config_timeout/);
    expect(src).toMatch(/setTimeout\(function \(\) \{ rej\(new Error\("config_timeout"\)\); \}, 6000\)/);
  });

  it("explains itself when Google's script loads but provides no API", () => {
    // An ad blocker or corporate proxy returning an empty 200 leaves a card with
    // no button; without a message that is a dead end with nothing to report.
    expect(src).toMatch(/ad blocker or network policy/);
  });
});

// "Can it just never ask if I'm already logged into Gmail?"
// Mostly yes — and the thing that made it feel otherwise was ours: the card was
// shown BEFORE Google was even loaded, so a returning rep watched it appear and
// vanish a second later when auto-select silently succeeded. No click was ever
// needed, but it read as being asked every time.
describe("silent sign-in shows no card at all", () => {
  it("locks the page without showing a card while Google tries silently", () => {
    const init = src.slice(src.indexOf("init: function"));
    const beforeScript = init.slice(0, init.indexOf("accounts.google.com/gsi/client"));
    // Locks (hides content) but must NOT call showCard() on this path.
    expect(beforeScript).toMatch(/opts\.onLock && opts\.onLock\(\)/);
    expect(beforeScript.slice(beforeScript.indexOf("var cached"))).not.toMatch(/showCard\(\)/);
  });

  it("cancels the pending card the moment a credential arrives", () => {
    const acc = src.slice(src.indexOf("function accept(tok)"));
    expect(acc.slice(0, 200)).toMatch(/cancelGrace\(\)/);
  });

  it("always reaches exactly one outcome, so the page cannot hang hidden", () => {
    // presentCard: on silent success accept() cancels the grace timer (no card);
    // on silence it shows the card; if GIS never loads it shows a card with an
    // explanation. And ensureGis itself has an 8s cap so a black-holed script
    // cannot hang the promise forever.
    expect(src).toMatch(/graceTimer = setTimeout\(function \(\) \{ graceTimer = null; showCard\(msg\); \}, SILENT_MS\)/);
    const ensure = src.slice(src.indexOf("function ensureGis()"));
    expect(ensure.slice(0, 600)).toMatch(/setTimeout\(function \(\) \{ finish\(false\); \}, 8000\)/);
    const present = src.slice(src.indexOf("function presentCard("));
    expect(present.slice(0, 500)).toMatch(/ad blocker or network policy/);
  });

  it("waits long enough for auto-reauthn but not long enough to feel broken", () => {
    const m = src.match(/var SILENT_MS = (\d+)/);
    expect(m).not.toBeNull();
    const ms = Number(m[1]);
    expect(ms).toBeGreaterThanOrEqual(1000); // FedCM needs room to resolve
    expect(ms).toBeLessThanOrEqual(2500);    // beyond this a blank page reads as broken
  });
});
