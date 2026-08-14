// The captured-answers panel must start below the header, not on top of it.
//
// The panel is position:fixed and its top was the literal 56 — which is only the
// header's minHeight. On mobile the header is height:auto with flexWrap, so a longer
// wordmark or tagline (any non-English language will do it) pushes it taller. Measured
// on a 375px phone: header 94px, panel top 56, all three header controls 91% covered,
// and a hit-test at each button's centre returned the panel. The sound, dark-mode and
// panel toggles were simply dead.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");

describe("the panel offset follows the real header height", () => {
  it("does not hardcode the panel's top", () => {
    expect(src).not.toMatch(/position:"fixed",top:56/);
  });

  it("uses the measured height instead", () => {
    expect(src).toMatch(/position:"fixed",top:headerH/);
  });

  it("measures a real element rather than trusting a constant", () => {
    expect(src).toMatch(/const headerRef = useRef\(null\)/);
    expect(src).toMatch(/<div ref=\{headerRef\}/);
    expect(src).toMatch(/getBoundingClientRect\(\)\.height\) \|\| 56/);
  });

  it("keeps measuring as the header reflows", () => {
    // Wrapping, rotation and language changes all resize the header without remounting
    // it, so a one-shot measurement would go stale.
    expect(src).toMatch(/new ResizeObserver\(measure\)/);
    expect(src).toMatch(/ro\.observe\(el\)/);
    expect(src).toMatch(/ro\.disconnect\(\)/);
  });

  it("re-runs once the real tree has mounted", () => {
    // The component returns <BootScreen/> until `checked`, so on the first run the
    // header does not exist and the ref is null. With empty deps the effect never ran
    // again, the observer was never attached, and the panel silently kept the 56
    // default — reintroducing the exact bug. This dep is load-bearing.
    const eff = src.slice(src.indexOf("const headerRef = useRef(null)"));
    expect(eff.slice(0, 1400)).toMatch(/\}, \[checked\]\);/);
  });

  it("degrades to the old constant where ResizeObserver is unavailable", () => {
    expect(src).toMatch(/typeof ResizeObserver === "undefined"/);
    expect(src).toMatch(/useState\(56\)/);
  });
});
