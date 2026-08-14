// Draft resumability and the side-panel breakpoint.
//
// Both of these were found by driving the real app in a browser, and both are silent:
// nothing throws, nothing logs, the UI just quietly does the wrong thing. That is
// exactly the kind of regression a source-level test is worth having.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");

// Strip comments, so an explanatory note ABOUT the old predicate can't be mistaken for
// the predicate itself. (This test failed on its own comment before this was added.)
const decomment = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

// Pull a top-level function body out of the module so its predicate can be inspected.
function fnBody(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`${name} not found`);
  let d = 0, start = src.indexOf("{", i);
  for (let j = start; j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (!d) return decomment(src.slice(start, j + 1)); }
  }
  throw new Error(`${name} unbalanced`);
}

describe("a finished but unsent brief stays resumable", () => {
  // The bug: a client answers everything (percent hits 100), sees "One last step:
  // send your brief", and closes the tab. On return both draft loaders rejected the
  // draft because it was at 100%, so no Resume was offered — and clicking Start then
  // overwrote it. Reproduced in a browser: 28 messages -> 1, unrecoverable.
  it("the local loader does not reject a draft for being at 100%", () => {
    const body = fnBody("lsLoadDraft");
    // NB the pattern must be able to cross the ")" in "(o.progress.percent || 0) < 100"
    expect(body).not.toMatch(/percent[\s\S]{0,24}<\s*100/);
  });

  it("the server loader does not reject a draft for being at 100%", () => {
    const body = fnBody("srvLoadDraft");
    // NB the pattern must be able to cross the ")" in "(o.progress.percent || 0) < 100"
    expect(body).not.toMatch(/percent[\s\S]{0,24}<\s*100/);
  });

  it("both still require a real conversation, not just any stored blob", () => {
    for (const fn of ["lsLoadDraft", "srvLoadDraft"]) {
      const body = fnBody(fn);
      expect(body, fn).toMatch(/Array\.isArray\((?:o|d)\.messages\)/);
      expect(body, fn).toMatch(/messages\.length/);
      expect(body, fn).toMatch(/\.progress/);
    }
  });

  it("sent-ness is still handled, by the autosave bailing once sent", () => {
    // This is what makes the percent ceiling unnecessary: no draft is ever written
    // after a send, so a surviving draft means the send did not fully land.
    expect(src).toMatch(/if \(!started \|\| sent \|\| messages\.length === 0\) return;/);
  });

  it("a send that fully succeeded still clears both copies", () => {
    expect(src).toMatch(/if \(saveOk\) \{ lsClearDraft\(seedId\); srvClearDraft\(seedId\); \}/);
  });
});

describe("a send that failed is still recoverable after a refresh", () => {
  // The bug: on a failed send the user turn is popped off histRef (so a dead turn never
  // reaches the model) and its text survives only in `retryMsg`. That was not in the
  // draft, so a client who refreshed at the retry card came back to their own message
  // still in the transcript, absent from history, with no Try again anywhere. Verified
  // in a browser: transcript showed it, the model never received it, no way to resend.
  it("persists retryMsg in the debounced snapshot", () => {
    // Sliced, not regexed: the snapshot contains a nested `tokens: { ... }`, so a
    // [^}]* pattern cannot reach the end of the literal.
    const i = src.indexOf("const snap = {");
    expect(i, "autosave snapshot literal not found").toBeGreaterThan(-1);
    expect(src.slice(i, i + 400)).toContain("retryMsg");
  });

  it("persists retryMsg in the flush-on-hide snapshot too", () => {
    // The close/background path writes snapRef.current, which is a separate object
    // literal. Missing it there loses exactly the tab-close case.
    const ref = src.slice(src.indexOf("snapRef.current = {"), src.indexOf("snapRef.current = {") + 400);
    expect(ref).toContain("retryMsg");
  });

  it("re-saves the draft when a send fails", () => {
    // A failure changes nothing else the autosave effect watches, so without retryMsg
    // in the deps the draft would never learn there is a pending unsent turn.
    const deps = /\}, \[messages, progress, wState, cdata, started, sent, uiLang, seedId, seed[^\]]*\]\);/.exec(src);
    expect(deps, "autosave dep array not found").toBeTruthy();
    expect(deps[0]).toContain("retryMsg");
  });

  // These match on behaviour, not on the identifier holding the draft: that variable
  // was renamed once already (saved -> s, when resume began re-reading the draft) and
  // pinning the name made the tests fail on a change that altered nothing.
  const RESUME = src.slice(src.indexOf("const resumeConvo"), src.indexOf("const resumeConvo") + 3200);

  it("restores the retry affordance on resume", () => {
    expect(RESUME).toMatch(/if \([A-Za-z_$][\w$]*\.retryMsg\)/);
    expect(RESUME).toMatch(/setRetryMsg\([A-Za-z_$][\w$]*\.retryMsg\)/);
  });

  it("does not ask the model for a welcome-back reply when a retry is pending", () => {
    // Otherwise a fresh assistant message lands on top of the failed answer and talks
    // straight past it, while the client can still see their own text above.
    const guard = RESUME.search(/if \([A-Za-z_$][\w$]*\.retryMsg\)/);
    const call = RESUME.indexOf("callAPILive");
    expect(guard, "retryMsg guard not found in resumeConvo").toBeGreaterThan(-1);
    expect(call, "callAPILive not found in resumeConvo").toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard); // the early return precedes any model call
    expect(RESUME.slice(guard, call)).toContain("return;");
  });
});

describe("the captured-answers panel cannot open where it would cover the chat", () => {
  // The bug: the default-open test (>1080) and the transform that makes room for the
  // panel (>=1280) were separate numbers. On any 1081-1279px window the panel opened
  // by default and overlaid the conversation, truncating right-aligned client answers
  // mid-word. Measured 65px of overlap at 1270px, far worse at 1120px.
  it("defines the breakpoint exactly once", () => {
    expect(src).toMatch(/const SIDE_COL_MIN = \d+;/);
    const literals = src.match(/\b(1080|1280)\b/g) || [];
    // 1080 may legitimately survive as an unrelated max-width elsewhere; what must not
    // exist is a second breakpoint literal in the panel/sideCol logic.
    expect(src).not.toMatch(/innerWidth\s*>=?\s*(1080|1280)/);
    expect(src).not.toMatch(/ww\s*>=\s*(1080|1280)/);
  });

  it("the panel's default-open test uses the shared constant", () => {
    expect(src).toMatch(/innerWidth >= SIDE_COL_MIN/);
  });

  it("the side-column layout uses the same constant", () => {
    expect(src).toMatch(/const sideCol = ww >= SIDE_COL_MIN;/);
  });

  it("opens by default only where the layout compensates for it", () => {
    // The two must agree, or the panel is open in a range where nothing shifts.
    const openTest = /innerWidth\s*(>=?)\s*SIDE_COL_MIN/.exec(src);
    const colTest = /ww\s*(>=?)\s*SIDE_COL_MIN/.exec(src);
    expect(openTest, "default-open test not found").toBeTruthy();
    expect(colTest, "sideCol test not found").toBeTruthy();
    expect(openTest[1]).toBe(colTest[1]);
  });
});

describe("a second tab cannot resume from a stale snapshot", () => {
  // `saved` is captured once at mount. A second tab opened on the same link therefore
  // holds the draft as it looked when THAT tab loaded. Resuming there restored the old
  // copy and the next autosave overwrote everything the first tab had done since.
  // Verified across two real tabs: the draft went from 5 messages including the client's
  // answer to 4 with that answer permanently gone.
  const RESUME = src.slice(src.indexOf("const resumeConvo"), src.indexOf("const resumeConvo") + 3200);

  it("re-reads the on-device draft at resume time", () => {
    expect(RESUME).toMatch(/pickDraft\(lsLoadDraft\(seedId\)/);
  });

  it("resolves it before any state is restored from the snapshot", () => {
    const pick = RESUME.indexOf("pickDraft(lsLoadDraft(seedId)");
    const firstRestore = RESUME.indexOf("setMessages(");
    expect(pick).toBeGreaterThan(-1);
    expect(firstRestore).toBeGreaterThan(pick);
  });

  it("restores from the resolved draft, never the mount-time snapshot", () => {
    // Any surviving `saved.<field>` read would silently reintroduce the stale copy.
    const reads = RESUME.match(/\bsaved\.(?!savedAt)[A-Za-z]+/g) || [];
    expect(reads, `stale reads still present: ${reads.join(", ")}`).toHaveLength(0);
  });

  it("can only ever move forward, never to an older draft", () => {
    // pickDraft picks the newer savedAt, so this cannot regress state.
    expect(src).toMatch(/function pickDraft[\s\S]{0,220}at\(remote\) > at\(local\)/);
  });
});
