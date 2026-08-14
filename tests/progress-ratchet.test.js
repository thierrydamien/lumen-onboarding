// Progress must only move forward.
//
// Found by fuzzing the UI through the browser stub: the stepper obeys every
// %%PROGRESS%% marker verbatim, so a marker that went backwards (a retry
// re-emitting "intro" at 10%) erased all six checkmarks mid-session, and a
// 100% marker whose collected map was sparse put a step-1 stepper directly
// above a "your brief is done" finish card. The live transcripts show the
// model normally emits cumulative, monotonic markers — the ratchet exists for
// the one turn where it doesn't.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ratchetProgress, Stepper } from "../src/lumen.jsx";

const FULL = {
  section: "users", percent: 80,
  collected: { intro: "done", objectives: "done", topics: "done", channels: "done", reports: "done" },
};

describe("ratchetProgress", () => {
  it("never lets percent decrease", () => {
    const r = ratchetProgress(FULL, { section: "intro", percent: 10, collected: {} });
    expect(r.percent).toBe(80);
  });

  it("keeps collected keys a sparse re-emit dropped", () => {
    const r = ratchetProgress(FULL, { section: "complete", percent: 100, collected: {} });
    expect(Object.keys(r.collected)).toEqual(Object.keys(FULL.collected));
    expect(r.percent).toBe(100);
  });

  it("still takes the NEW value for a re-emitted key, and new keys accumulate", () => {
    const r = ratchetProgress(FULL, { section: "users", percent: 85, collected: { topics: "5 topics", users: "done" } });
    expect(r.collected.topics).toBe("5 topics");
    expect(r.collected.users).toBe("done");
    expect(r.collected.intro).toBe("done");
  });

  it("passes the section through so a legitimate revisit can point at it", () => {
    const r = ratchetProgress(FULL, { section: "topics", percent: 80, collected: {} });
    expect(r.section).toBe("topics");
  });

  it("tolerates malformed inputs (missing fields, non-numeric percent)", () => {
    expect(ratchetProgress(undefined, { percent: 30 }).percent).toBe(30);
    expect(ratchetProgress({ percent: 40 }, { percent: "nonsense" }).percent).toBe(40);
    expect(ratchetProgress({ percent: 40, collected: { intro: "x" } }, {}).collected.intro).toBe("x");
  });
});

describe("the stepper, fed a ratcheted regression", () => {
  const render = (progress) =>
    renderToStaticMarkup(React.createElement(Stepper, { progress, compact: false, lang: "English", dark: false }));
  const ticks = (html) => (html.match(/✓/g) || []).length;

  it("keeps its checkmarks when a marker goes backwards", () => {
    const before = ticks(render(FULL));
    expect(before).toBeGreaterThanOrEqual(4);
    // Raw regressed marker: the stepper un-ticks (this is the defect the ratchet
    // guards; if this ever starts passing, the Stepper grew its own guard and
    // the ratchet is redundant).
    const raw = { section: "intro", percent: 10, collected: {} };
    expect(ticks(render(raw))).toBeLessThan(before);
    // Ratcheted, the same marker keeps every tick.
    expect(ticks(render(ratchetProgress(FULL, raw)))).toBe(before);
  });

  it("keeps its checkmarks on a sparse 100% close", () => {
    const raw = { section: "complete", percent: 100, collected: {} };
    expect(ticks(render(ratchetProgress(FULL, raw)))).toBe(ticks(render(FULL)));
  });
});
