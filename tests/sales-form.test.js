// The Sales link generator's form wiring.
//
// Two defects this locks down, both found by driving the real page in Chromium:
//
// 1. Generate was disabled until every required field was filled. generate()
//    carries good click-time validation — it marks the offending field, writes a
//    specific message and scrolls to it — but a DISABLED button never fires a
//    click, so that validation was unreachable from the primary path. A rep who
//    clicked "Fill with example data" (which deliberately leaves "Prepared by"
//    empty) and then Generate got nothing at all: no message, no highlight.
//
// 2. Confidential consultant notes are stored by seed.js (returned only to a
//    token-holder), injected into the system prompt server-side by chat.js, and
//    rendered by the dashboard as "Consultant notes (from Sales)" — but the form
//    had no field to enter them, so every seed carried none and the whole path
//    was dead. The post-generate card even reassured reps that "your internal
//    notes are never part of the link", about a field that did not exist.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const sales = readFileSync(new URL("../public/sales.html", import.meta.url), "utf8");

// Slice generate() to its actual end rather than a magic character count. Both
// assertions below used to take a fixed window (1600 / 2400 chars) and broke the
// moment a guard was added at the top of the function — the code they check had
// simply moved to char 1624 and 2549. A test that fails on unrelated edits above
// it is noise, and the natural response to noise is to weaken the assertion.
const generateFn = (() => {
  const from = sales.indexOf("async function generate()");
  const rest = sales.slice(from);
  const end = rest.indexOf("\n  function fillExample");
  return end === -1 ? rest : rest.slice(0, end);
})();

describe("Generate is never a dead control", () => {
  it("does not disable itself on an incomplete form", () => {
    // checkValid still REPORTS completeness (callers use the boolean); what it
    // must not do is gate the button, which is what swallowed the validation.
    const fn = sales.slice(sales.indexOf("function checkValid()"));
    expect(fn.slice(0, 400)).not.toMatch(/\$\("gen"\)\.disabled/);
  });

  it("still validates, names the field, and moves focus to it", () => {
    expect(generateFn).toContain('classList.add("invalid")');
    expect(generateFn).toContain("Your name is required.");
    expect(generateFn).toMatch(/\$\(firstBad\)\.focus\(\)/);
    expect(generateFn).toMatch(/scrollIntoView/);
  });

  it("reserves disabled for the in-flight state, so a double-click can't double-post", () => {
    expect(generateFn).toMatch(/btn\.disabled = true;\s*btn\.textContent = "Generating/);
  });

  it("lets Enter reach the same validation instead of silently doing nothing", () => {
    expect(sales).toMatch(/if \(e\.key === "Enter"\) \{ e\.preventDefault\(\); generate\(\); \}/);
  });
});

describe("confidential consultant notes", () => {
  it("has a field, in the internal section, capped to what chat.js accepts", () => {
    expect(sales).toMatch(/<textarea id="notes"/);
    // chat.js slices notes to 4000 chars; the box should not silently over-collect.
    expect(sales).toMatch(/id="notes"[^>]*maxlength="4000"/);
    // It must sit AFTER the "never shown to the client" divider.
    const divider = sales.indexOf("Internal — never shown to the client");
    expect(divider).toBeGreaterThan(-1);
    expect(sales.indexOf('id="notes"')).toBeGreaterThan(divider);
  });

  it("travels in the seed payload, separate from the client-visible brief", () => {
    const seed = sales.slice(sales.indexOf("var seed = {"));
    const body = seed.slice(0, seed.indexOf("};"));
    expect(body).toMatch(/notes: \$\("notes"\)\.value\.trim\(\)/);
    // brief and notes are different fields with different audiences.
    expect(body).toMatch(/brief: \$\("briefText"\)\.value\.trim\(\)/);
  });

  it("is cleared for the next client", () => {
    // Per-client and confidential: carrying them into the next rep's link would
    // feed the wrong context to the assistant and show it to the wrong team.
    const reset = sales.slice(sales.indexOf("function resetForNext()"));
    expect(reset.slice(0, 600)).toMatch(/"briefUrl", "notes"/);
  });

  it("clears a stale link when edited, like every other field", () => {
    const watch = sales.match(/\["company", "contactName"[^\]]*\]\.forEach\(function \(id\) \{\s*var el = \$\(id\)/);
    expect(watch).not.toBeNull();
    expect(watch[0]).toContain('"notes"');
  });

  it("routes its shortcut chips to the notes box, never to the client-visible brief", () => {
    // One handler binds EVERY .chip on the page; sending a notes chip to the
    // brief box would publish a confidential line straight to the client.
    const chips = sales.slice(sales.indexOf("Array.prototype.forEach.call(document.querySelectorAll(\".chip\")"));
    const body = chips.slice(0, 800);
    expect(body).toMatch(/hasAttribute\("data-addnote"\)/);
    expect(body).toMatch(/\$\(isNote \? "notes" : "briefText"\)/);
    // And a chip with neither attribute must no-op rather than throw on null.
    expect(body).toMatch(/if \(!t \|\| !add\) return;/);
  });

  it("keeps the reassurance on the out-card truthful", () => {
    // This line promised notes stay out of the link. It is only true because the
    // link is built from nothing but the opaque seed id the server hands back —
    // assert against the actual construction, not a function name.
    expect(sales).toMatch(/internal notes are never part of the link/);
    expect(sales).toMatch(/\$\("link"\)\.value = CHAT_BASE \+ "\?s=" \+ encodeURIComponent\(data\.id\);/);
    // Nothing else may be appended to the client URL.
    expect(sales).not.toMatch(/CHAT_BASE \+[^\n]*notes/);
  });
});

// Round two, after watching a first-time rep persona walk the page: the optional
// brief import was the FIRST and LARGEST block on the page, so the required
// five-field path hid below the machinery; the out card never said WHO a link
// was for; and the write token lived in sessionStorage, greeting reps with a
// password wall on every fresh tab.
describe("the page leads with the required path", () => {
  it("collapses the brief import behind a disclosure, closed by default", () => {
    expect(sales).toMatch(/id="briefToggle"[^>]*aria-expanded="false"/);
    expect(sales).toMatch(/<div id="briefBox" hidden/);
  });

  it("never lets brief text hide silently", () => {
    // Fill-with-example writes into the box while it may be closed: it must open
    // it. A manual close with text inside shows the "filled" marker instead.
    // Bounded by the next function, not a guessed char count — the example data
    // strings make this function long, and a fixed window already bit once.
    const start = sales.indexOf("function fillExample()");
    const fill = sales.slice(start, sales.indexOf("function bindCopy", start));
    expect(fill).toContain("setBriefOpen(true)");
    expect(sales).toMatch(/briefFilledMark/);
    const mark = sales.slice(sales.indexOf("function updateBriefMark()"));
    expect(mark.slice(0, 300)).toMatch(/closed && \$\("briefText"\)\.value\.trim\(\)/);
  });

  it("returns to the quiet default for the next client", () => {
    const reset = sales.slice(sales.indexOf("function resetForNext()"));
    expect(reset.slice(0, 900)).toContain("setBriefOpen(false)");
  });
});

describe("the out card names its client", () => {
  it("echoes contact, company, language and package from the SENT seed", () => {
    // From the seed actually posted, not re-read from the form, which the rep may
    // have edited while the request was in flight.
    expect(sales).toMatch(/id="outFor"/);
    const gen = sales.slice(sales.indexOf('$("outFor").innerHTML'));
    const line = gen.slice(0, 400);
    expect(line).toContain("seed.contactName || seed.company");
    expect(line).toContain("seed.language");
    // Rep-entered values land in innerHTML: every one must pass through esc().
    expect(line.match(/esc\(/g).length).toBeGreaterThanOrEqual(4);
  });
});

describe("the write token", () => {
  it("is remembered on the device, not per tab", () => {
    // sessionStorage meant the password wall greeted a rep on every new tab —
    // the exact friction that makes an internal tool go unused.
    expect(sales).not.toMatch(/sessionStorage\.[gs]etItem\("sales_write_token"/);
    expect(sales).toMatch(/localStorage\.getItem\("sales_write_token"\)/);
    // And a server-side 401 still clears the stored copy so rotation works.
    expect(sales).toMatch(/localStorage\.removeItem\("sales_write_token"\)/);
  });
});
