// The team hub (public/index.html) is gated behind the same work-Google sign-in
// as /sales and /dashboard. Two halves, and the second matters more:
//
//   1. an outsider must not be able to READ the hub, and
//   2. a CLIENT must still reach /chat and /chat?s=<seedId> with no sign-in at all.
//
// (2) is the one that would be a live incident. Every client link routes through
// /chat, so a gate that leaked onto that page would lock out every client at once
// while looking, from the inside, exactly like a working gate.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const hub = read("public/index.html");
const chat = read("public/chat.html");
const toml = read("netlify.toml");

describe("the hub is gated like the other internal pages", () => {
  it("uses the shared module rather than its own copy of the logic", () => {
    // The whole reason the module was extracted: three pages needing the same
    // auth fix in three places is how one of them ends up quietly less protected.
    expect(hub).toMatch(/<script src="\/google-gate\.js"><\/script>/);
    expect(hub).toMatch(/LumenGoogleGate\.create\(\{/);
    expect(hub).toMatch(/\}\)\.init\(\);/);
    expect(hub).not.toMatch(/accounts\.google\.com\/gsi\/client/); // no second implementation
  });

  it("hides the hub from first paint, not after a round trip", () => {
    // A deferred script still allows one readable frame. Inline and synchronous,
    // before the markup, is the only version of this that works.
    const beforeWrap = hub.slice(hub.indexOf("<body>"), hub.indexOf('<div class="wrap">'));
    expect(beforeWrap).toMatch(/document\.documentElement\.className \+= " gate-check"/);
    expect(hub).toMatch(/html\.gate-check \.wrap, html\.gate-locked \.wrap\{visibility:hidden\}/);
  });

  it("covers the hub with an OPAQUE backdrop, not a translucent scrim", () => {
    // Verified in a browser: rgb(244,246,249) light, rgb(11,18,32) dark, both
    // fully opaque. A 40% scrim leaves "Proserv" and the dashboard card legible
    // straight through the sign-in card, which is the thing being prevented.
    const gate = hub.slice(hub.indexOf("  .gate{"), hub.indexOf("  .gate.show"));
    expect(gate).toMatch(/background:var\(--bg\)/);
    expect(gate).not.toMatch(/rgba/);
  });

  it("reveals the hub only if the module never ran at all", () => {
    // If the module IS running it owns reveal/hide; firing the net alongside it
    // is what flashed the internal form on sales.html during a slow config fetch.
    // Verified in a browser: module blocked → hidden until 9.3s then revealed;
    // module working → still hidden and locked at 10.5s.
    const net = hub.slice(hub.indexOf("setTimeout(function () {"), hub.indexOf("}, 8000);") + 9);
    expect(net).toMatch(/if \(!window\.__lumenGateLoaded\)/);
    expect(net).toMatch(/remove\("gate-check"\)/);
    expect(net).toMatch(/remove\("gate-locked"\)/);
  });
});

describe("the gate does not reach the client", () => {
  it("leaves chat.html with no sign-in of any kind", () => {
    // A client is not, and must never need to be, signed into a Hootsuite Google
    // account. This is the assertion that would catch a copy-paste of the hub's
    // gate onto the one page every client link opens.
    expect(chat).not.toMatch(/google-gate\.js/);
    expect(chat).not.toMatch(/LumenGoogleGate/);
    expect(chat).not.toMatch(/gate-check|gate-locked/);
    expect(chat).not.toMatch(/accounts\.google\.com/);
  });

  it("keeps /chat and the personalised link on a page the gate never touches", () => {
    // /chat?s=<seedId> is the client's link; the query string rides along to the
    // same static file. Nothing in the hub's gate is scoped by path, so the only
    // thing keeping clients out of it is that it lives in a different file.
    expect(toml).toMatch(/from = "\/chat"\n {2}to = "\/chat\.html"/);
    expect(hub).toMatch(/href="\/chat"/); // the hub still links to it, for demos
  });

  it("leaves every client-facing function ungated", () => {
    for (const f of ["chat.js", "chat-background.js", "chat-status.js", "draft.js"]) {
      expect(read("netlify/functions/" + f), `${f} must not require Google auth`)
        .not.toMatch(/verifyGoogleAuth/);
    }
    // session.js is the sharp edge: the client POSTs their own session to it, and
    // only the dashboard's GET is gated. Asserted in google-gate-wiring.test.js.
  });
});
