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

describe("Generate is never a dead control", () => {
  it("does not disable itself on an incomplete form", () => {
    // checkValid still REPORTS completeness (callers use the boolean); what it
    // must not do is gate the button, which is what swallowed the validation.
    const fn = sales.slice(sales.indexOf("function checkValid()"));
    expect(fn.slice(0, 400)).not.toMatch(/\$\("gen"\)\.disabled/);
  });

  it("still validates, names the field, and moves focus to it", () => {
    const gen = sales.slice(sales.indexOf("async function generate()"));
    const body = gen.slice(0, 1600);
    expect(body).toContain('classList.add("invalid")');
    expect(body).toContain("Your name is required.");
    expect(body).toMatch(/\$\(firstBad\)\.focus\(\)/);
    expect(body).toMatch(/scrollIntoView/);
  });

  it("reserves disabled for the in-flight state, so a double-click can't double-post", () => {
    const gen = sales.slice(sales.indexOf("async function generate()"));
    expect(gen.slice(0, 2400)).toMatch(/btn\.disabled = true;\s*btn\.textContent = "Generating/);
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
