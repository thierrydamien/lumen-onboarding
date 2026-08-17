// The two P0s from the design critique of the client chat.
//
// Both were found by driving the real bundle, and both were verified by
// INSTRUMENTING scrollIntoView / reading the panel rather than by watching pixels
// move. That distinction is the whole reason these tests exist in this shape — see
// the note on the scroll test below.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");

function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = decomment(src);

describe("the transcript follows a new turn", () => {
  // The defect: the near-bottom guard measured the DOM inside the [messages] effect,
  // i.e. after React had already appended the reply. `scrollHeight - scrollTop -
  // clientHeight` was then the height of the new content itself — over 200 for every
  // widget turn — so the guard concluded the client had scrolled away when they had
  // not moved. Proven by A/B on identical scenarios with scrollIntoView instrumented:
  // original code produced a send-phase call and NO reply-phase call; fixed code
  // produced both. Measured consequence before the fix, at 1280x720: scrollTop 0,
  // 1,152px unseen, the widget's Confirm at y=1723 in a 720px viewport.

  it("does not decide from a measurement taken after the new turn landed", () => {
    const eff = code.slice(code.indexOf("if (nearBottomRef.current || loading)"));
    expect(eff.slice(0, 200)).toMatch(/\}, \[messages, loading\]\);/);
    // The old inline measurement must be gone from that effect.
    const effBody = code.slice(code.indexOf("useEffect(() => {\n    if (nearBottomRef.current"), code.indexOf("}, [messages, loading]);"));
    expect(effBody).not.toMatch(/scrollHeight - .*scrollTop - .*clientHeight/);
  });

  it("tracks the client's intent from input events, never from scroll", () => {
    // A plain `scroll` listener is the trap: this component scrolls the transcript
    // itself on every send, and a smooth scroll emits scroll events whose
    // mid-animation position reads as "far from the bottom". The first attempt at
    // this fix used `scroll` and reproduced the original bug exactly.
    const bind = code.slice(code.indexOf("const nearBottomRef = useRef(true)"), code.indexOf("}, [checked, started]);"));
    expect(bind).toMatch(/addEventListener\("wheel", measure/);
    expect(bind).toMatch(/addEventListener\("touchmove", measure/);
    expect(bind).toMatch(/addEventListener\("keydown", onKey\)/);
    expect(bind).not.toMatch(/addEventListener\("scroll"/);
  });

  it("defaults to following, so the very first turn is never missed", () => {
    expect(code).toMatch(/const nearBottomRef = useRef\(true\)/);
  });

  it("binds once the transcript actually exists", () => {
    // msgRef.current is null until the conversation renders; an effect with [] deps
    // would silently never attach. This exact mistake has been made in this file
    // before, with the panel's header-height observer.
    const bind = code.slice(code.indexOf("const nearBottomRef = useRef(true)"));
    expect(bind.slice(0, 900)).toMatch(/\}, \[checked, started\]\);/);
    expect(bind).toMatch(/if \(!el\) return;/);
  });

  it("still honours reduced motion", () => {
    expect(code).toMatch(/scrollIntoView\(\{behavior:REDUCE_MOTION\?"auto":"smooth"\}\)/);
  });

  it("covers keyboard scrolling, not just wheel and touch", () => {
    const bind = code.slice(code.indexOf("const nearBottomRef = useRef(true)"), code.indexOf("}, [checked, started]);"));
    for (const k of ["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown"]) {
      expect(bind).toContain(k);
    }
  });
});

describe("reopening an answer does not remove it from the brief", () => {
  // "Edit" sets submitted:false and keeps data. Both readers gated on `submitted`,
  // so pressing Edit dropped the answer out of "Captured so far" AND out of the
  // delivered brief, the Sheet and the dashboard — before the client had changed
  // anything, with no warning and no way back. Interruption is the normal case for
  // this product, so an abandoned half-edit is a path real clients take.

  it("the panel reader counts a reopened widget that still holds data", () => {
    const gwp = code.slice(code.indexOf("const gwp = type =>"), code.indexOf("const gwp = type =>") + 320);
    expect(gwp).toMatch(/v\?\.data!==undefined/);
  });

  it("the export reader counts it too, so the brief matches the panel", () => {
    // Fixing only the panel would be worse than not fixing it: the client would see
    // their answer listed as captured while it was silently absent from the send.
    const gw = code.slice(code.indexOf("const gw = type =>"), code.indexOf("const gw = type =>") + 320);
    expect(gw).toMatch(/v\?\.data!==undefined/);
  });

  it("both readers still ignore a widget that was never answered", () => {
    // An untouched widget has no `data`, so it must not count as captured.
    for (const fn of ["const gwp = type =>", "const gw = type =>"]) {
      const body = code.slice(code.indexOf(fn), code.indexOf(fn) + 320);
      expect(body).toMatch(/v===true\|\|v\?\.submitted\|\|v\?\.data!==undefined/);
    }
  });

  it("a skip still reads as no answer rather than as content", () => {
    const gw = code.slice(code.indexOf("const gw = type =>"), code.indexOf("const gw = type =>") + 320);
    expect(gw).toMatch(/d==="__skip__"\?null:d/);
  });

  it("offers a non-destructive way out of an edit", () => {
    // Before this the only exits were Confirm (re-submit) or Skip, and Skip DESTROYS
    // the answer. A client who opened Edit just to look had no way to say never mind.
    expect(code).toMatch(/const reopened = !sub && ws && ws !== true && ws\.data !== undefined/);
    expect(code).toMatch(/setWState\(p=>\(\{\.\.\.p,\[key\]:\{\.\.\.p\[key\],submitted:true\}\}\)\)/);
    expect(code).toMatch(/WL\("cancelEdit",uiLang\)/);
  });

  it("localises that control in all six languages", () => {
    const hits = src.match(/"cancelEdit":"[^"]+"/g) || [];
    expect(hits).toHaveLength(6);
    // and none left as the English string by accident
    expect(hits.filter(h => h.includes("Cancel editing"))).toHaveLength(1);
  });

  it("gives it a large enough target", () => {
    const block = code.slice(code.indexOf("const reopened ="), code.indexOf("const reopened =") + 900);
    expect(block).toMatch(/minHeight:24/);
  });
});
