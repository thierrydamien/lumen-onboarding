// A client must be able to fix the language after starting.
//
// The seeded language comes from Sales, who does not always know it. Before this the
// picker existed ONLY on the first-visit screen: once a client had started, setUiLang was
// unreachable from the UI, so a wrong language was permanent. The only escape was
// "Start over", which erases every answer given so far to correct a dropdown.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
const savedBranch = src.slice(src.indexOf("{!started && saved && ("), src.indexOf("{!started && saved && (") + 3000);

describe("the Welcome-back screen can change language", () => {
  it("renders a picker over the supported languages", () => {
    expect(savedBranch).toMatch(/UI_LANGS\.map\(l =>/);
    expect(savedBranch).toMatch(/L\("chooseLang",uiLang\)/);
  });

  it("reports the current selection to assistive tech", () => {
    expect(savedBranch).toMatch(/aria-pressed=\{on\}/);
  });
});

describe("an explicit choice survives the resume", () => {
  it("marks the change as client-initiated", () => {
    expect(src).toMatch(/const langOverrideRef = useRef\(false\)/);
    expect(savedBranch).toMatch(/langOverrideRef\.current = true; setUiLang\(l\.code\)/);
  });

  it("resumeConvo does not overwrite it with the saved language", () => {
    // Without the guard the restore runs immediately after and silently undoes the fix,
    // which would make the new picker look broken.
    expect(src).toMatch(/if \(s\.uiLang && !langOverrideRef\.current\) setUiLang\(s\.uiLang\)/);
  });

  it("still restores the saved language when the client did not choose", () => {
    // The guard must be an override, not a removal: an untouched picker has to keep
    // honouring whatever language the draft was saved in.
    const line = /if \(s\.uiLang && !langOverrideRef\.current\) setUiLang\(s\.uiLang\)/.exec(src);
    expect(line).toBeTruthy();
    expect(src).toMatch(/const langOverrideRef = useRef\(false\)/); // defaults to false
  });

  it("the first-visit picker still exists", () => {
    const firstVisit = src.slice(src.indexOf("{!started && !saved && ("), src.indexOf("{!started && !saved && (") + 6000);
    expect(firstVisit).toMatch(/UI_LANGS\.map\(l =>/);
  });
});
