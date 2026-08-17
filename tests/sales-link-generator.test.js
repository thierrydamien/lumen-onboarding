// public/sales.html — the AE-facing link generator.
//
// This is the entry point to the whole funnel and had no tests at all. Everything
// below was first reproduced by driving the real page in a browser with the seed /
// parse-brief / preview-brief endpoints stubbed, then pinned here.
//
// Matching is deliberately behavioural, not identifier-pinned: an earlier round of
// tests in this repo broke on a pure rename that changed nothing.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/sales.html", import.meta.url), "utf8");

// Strip comments before matching. A previous test in this repo failed against an
// explanatory comment ABOUT the old code rather than the code, and another PASSED
// against broken code for the same reason.
function decomment(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = decomment(src);
const generateFn = code.slice(code.indexOf("async function generate()"), code.indexOf("function fillExample"));

describe("a revealed link always matches what is on screen", () => {
  it("treats a package change during the round trip as a change", () => {
    // The package scopes the entire client conversation (topic/channel/dashboard
    // allowances). Measured before this: posted core-plus, dropdowns and the green
    // allowance panel both read business-elite, and the link was revealed with no
    // warning — so the rep hands over a link that gathers 5 topics for a client the
    // screen just told them gets 40.
    expect(generateFn).toMatch(/changed\s*=[\s\S]*pkgCode\(\)\s*!==\s*seed\.package/);
  });

  it("treats a change to the confidential notes as a change", () => {
    // Same defect class as the package, for the field with the worse payload:
    // `notes` is injected into the assistant's system prompt server-side, so a rep
    // who corrects or removes a note during the round trip would otherwise hand
    // over a link still carrying the original text.
    expect(generateFn).toMatch(/changed\s*=[\s\S]*\$\("notes"\)\.value\.trim\(\) !== seed\.notes/);
  });

  it("checks every field the seed actually carries", () => {
    // The guard has now been missed twice, for two different fields. Anything the
    // seed carries and the rep can edit has to appear here.
    const seedObj = code.slice(code.indexOf("var seed = {"), code.indexOf("var seed = {") + 700);
    const carried = [...seedObj.matchAll(/^\s*(\w+):/gm)].map(m => m[1]);
    const guard = generateFn.slice(generateFn.indexOf("var changed"), generateFn.indexOf("if (myGen !== _genSeq"));
    // `package` is compared via pkgCode(), `brief` via the briefText input.
    const alias = { package: "pkgCode", brief: "briefText" };
    for (const f of carried) {
      const needle = alias[f] || f;
      expect(guard, `seed field "${f}" is not covered by the stale-link guard`).toContain(needle);
    }
  });

  it("records the package it actually posted, so the comparison has a baseline", () => {
    expect(code).toMatch(/var seed = \{[\s\S]*package: pkg[\s\S]*\};/);
  });
});

describe("only one link is generated at a time", () => {
  it("refuses a second generate while one is in flight", () => {
    // The button is disabled during flight, but the Enter handler calls generate()
    // directly and never checked that. Three Enters produced THREE seed records,
    // each holding client data, each its own dashboard row, and each a false hit
    // for the server-side duplicate-client scan.
    expect(code).toMatch(/if \(_generating\) return;/);
    expect(code).toMatch(/_generating = true;/);
    expect(code).toMatch(/finally \{[\s\S]{0,80}_generating = false;/);
  });

  it("guards before the request is built, not after", () => {
    const guard = generateFn.indexOf("if (_generating) return;");
    const post = generateFn.indexOf("postSeed(");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(post);
  });

  it("restores the button label from a constant, not from the live button", () => {
    // Reading btn.textContent inside generate() meant an overlapping call captured
    // "Generating…" as the label to restore. The button then read "Generating…" for
    // the rest of the session, while idle and fully enabled, and never recovered.
    expect(code).toMatch(/var GEN_IDLE_LABEL = \$\("gen"\)\.textContent;/);
    expect(code).toMatch(/textContent = GEN_IDLE_LABEL;/);
    expect(generateFn).not.toMatch(/label\s*=\s*btn\.textContent/);
  });
});

describe("the brief upload is reachable without a mouse", () => {
  it("triggers the file picker from a real button", () => {
    // It was a <label for> pointing at a display:none input. A label is not
    // focusable and the input was out of the tab order, so there was NO keyboard
    // path to the file picker — every other control in that box was reachable.
    expect(src).toMatch(/<button type="button" class="btn alt" id="briefFileBtn">/);
    expect(code).toMatch(/\$\("briefFileBtn"\)\.addEventListener\("click", function \(\) \{ \$\("briefFile"\)\.click\(\); \}\);/);
  });

  it("keeps the raw input out of the tab order and the a11y tree", () => {
    const input = src.slice(src.indexOf('id="briefFile"'), src.indexOf('id="briefFile"') + 260);
    expect(input).toMatch(/tabindex="-1"/);
    expect(input).toMatch(/aria-hidden="true"/);
  });
});

describe("the generated-link panel is only present once a link exists", () => {
  it("is inert in the markup, from first paint", () => {
    // Collapsing with max-height/opacity alone left it display:block and in the
    // a11y tree: on a FRESH load a screen reader read "✓ Link ready … Copy … Email
    // to client" before anything was generated, and a keyboard user hit four dead
    // tab stops on invisible controls.
    expect(src).toMatch(/<div class="out" id="out" inert aria-hidden="true">/);
  });

  it("routes every show/hide through one helper", () => {
    // Eight call sites toggled the class directly. Any one of them forgetting the
    // a11y half is the bug coming straight back.
    expect(code).toMatch(/function showOut\(on\)/);
    expect(code).not.toMatch(/\$\("out"\)\.classList\.(add|remove)\("show"\)/);
    expect(code.match(/showOut\((true|false)\)/g).length).toBeGreaterThanOrEqual(8);
  });

  it("sets inert and aria-hidden together, in both directions", () => {
    const fn = code.slice(code.indexOf("function showOut(on)"), code.indexOf("function showOut(on)") + 700);
    expect(fn).toMatch(/removeAttribute\("inert"\)/);
    expect(fn).toMatch(/removeAttribute\("aria-hidden"\)/);
    expect(fn).toMatch(/setAttribute\("inert", ""\)/);
    expect(fn).toMatch(/setAttribute\("aria-hidden", "true"\)/);
  });

  it("moves focus out before making the panel inert", () => {
    // Generate auto-selects the link, so focus is normally INSIDE the panel when an
    // edit retracts it. inert does not blur an element that already holds focus, so
    // without this the caret is stranded in a region nothing can tab back into.
    const fn = code.slice(code.indexOf("function showOut(on)"), code.indexOf("function showOut(on)") + 700);
    expect(fn).toMatch(/if \(el\.contains\(document\.activeElement\)\)[\s\S]{0,90}blur\(\)/);
    const blur = fn.indexOf("blur()");
    const inert = fn.indexOf('setAttribute("inert"');
    expect(blur).toBeLessThan(inert);
  });
});

describe("an import cannot silently destroy typed-in details", () => {
  it("snapshots the fields it is about to replace", () => {
    // Company, contact, email and industry were overwritten outright with no
    // warning and no way back. Note the original code deliberately APPENDED the
    // brief text to preserve typing, then clobbered these four.
    expect(code).toMatch(/var snap = \{ briefText: \$\("briefText"\)\.value \};/);
    expect(code).toMatch(/FORM_FIELDS\.forEach\(function \(id\) \{ snap\[id\] = \$\(id\)\.value; \}\);/);
  });

  it("only reports fields that actually held something different", () => {
    // Importing onto an empty form is the normal flow and must stay silent.
    expect(code).toMatch(/if \(had && had !== String\(incoming\)\.trim\(\)\) replaced\.push\(id\);/);
    expect(code).toMatch(/if \(replaced\.length\) \{/);
  });

  it("offers an undo that restores the brief text too", () => {
    const undo = code.slice(code.indexOf("function undoImport()"), code.indexOf("function undoImport()") + 500);
    expect(undo).toMatch(/FORM_FIELDS\.forEach\(function \(id\) \{ \$\(id\)\.value = _preImport\[id\]; \}\);/);
    expect(undo).toMatch(/\$\("briefText"\)\.value = _preImport\.briefText;/);
  });

  it("builds the undo control without innerHTML", () => {
    // The status line carries field labels; keep it out of the string-HTML path
    // entirely rather than relying on escaping being remembered later.
    const apply = code.slice(code.indexOf("function applyBriefData"), code.indexOf("function applyBriefData") + 2600);
    expect(apply).toMatch(/createElement\("button"\)/);
    expect(apply).not.toMatch(/innerHTML/);
  });
});

describe("the write-token gate behaves like a dialog", () => {
  it("is announced as one", () => {
    expect(src).toMatch(/role="dialog"/);
    expect(src).toMatch(/aria-modal="true"/);
    expect(src).toMatch(/aria-labelledby="wtTitle"/);
  });

  it("can be dismissed with Escape and with a backdrop click", () => {
    expect(code).toMatch(/if \(e\.key === "Escape"\)[\s\S]{0,60}_wtClose\(false\)/);
    expect(code).toMatch(/if \(e\.target === \$\("wtGate"\)\) _wtClose\(false\)/);
  });

  it("keeps Tab inside it", () => {
    // 21 controls behind the gate stayed tabbable while it covered the page, and
    // none of them were reachable by mouse.
    expect(code).toMatch(/e\.shiftKey && document\.activeElement === first/);
    expect(code).toMatch(/!e\.shiftKey && document\.activeElement === last/);
  });

  it("returns focus to whatever opened it", () => {
    expect(code).toMatch(/_wtReturnFocus = document\.activeElement;/);
    expect(code).toMatch(/_wtReturnFocus\.focus\(\)/);
  });

  it("closes the backdrop only on the backdrop, never through the card", () => {
    // A mousedown that starts on the card must not cancel the dialog.
    expect(code).toMatch(/\$\("wtGate"\)\.addEventListener\("mousedown"/);
  });
});

describe("the page does not promise privacy it no longer provides", () => {
  it("no longer claims internal notes are kept out of the link", () => {
    // There is no internal notes field: the form posts `brief`, and the brief box
    // is labelled "The client sees this". A rep who read the old reassurance could
    // have typed something confidential into a box the assistant reads back.
    expect(code).not.toMatch(/internal notes are never part of the link/);
  });

  it("names what is actually internal", () => {
    // package and preparedBy are excluded from CLIENT_SAFE in netlify/functions/seed.js.
    expect(src).toMatch(/product, service package and your name stay internal/i);
  });
});

describe("tap targets clear the minimum size", () => {
  it("gives the text-style buttons a 24px minimum height", () => {
    // WCAG 2.5.8. These rendered 15px tall on their text alone.
    const rule = src.slice(src.indexOf(".linklike {"), src.indexOf(".linklike {") + 320);
    expect(rule).toMatch(/min-height:24px/);
  });
});
