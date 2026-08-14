// The mobile progress percentage.
//
// Found by using the app on a real iPhone: the number sat on 17% across half a
// dozen messages. Cause: the compact (mobile) stepper computed the percentage as
// sectionsCompleted/6, so it could only ever read 0/17/33/50/67/83/100 — while
// the model was already reporting a much finer value every turn (measured live
// against the deployed build: 0, 5, 8, 12, 15, 18, 22). That value was discarded.
//
// Section 1 alone covers company, email, industry, goal and the experience
// question, so a client can send five or six messages inside it. Desktop shows no
// percentage at all, which is why this only ever appeared on mobile — where most
// of these clients are.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { Stepper } from "../src/lumen.jsx";

const render = (progress, compact = true) =>
  renderToStaticMarkup(React.createElement(Stepper, { progress, compact, lang: "English", dark: false }));

/** The percentage as a client reads it off the screen. */
const shownPct = (html) => {
  const m = html.match(/>(\d+)%</);
  return m ? Number(m[1]) : null;
};

describe("mobile progress percentage", () => {
  it("follows the model's finer number instead of jumping in sixths", () => {
    // The exact sequence captured from a live German conversation.
    const seen = [0, 5, 8, 12, 15, 18, 22].map((percent) =>
      shownPct(render({ section: "company", percent, collected: {} })));
    expect(seen).toEqual([0, 5, 8, 12, 15, 18, 22]);
    // The bug: every one of these used to render as the same number.
    expect(new Set(seen).size).toBeGreaterThan(1);
  });

  it("never reads lower than the step beside it implies", () => {
    // "Step 3 of 6" next to 15% would look broken, so the section count is a floor.
    const html = render({ section: "channels", percent: 15, collected: { company: true, path: true, topics: true } });
    expect(shownPct(html)).toBeGreaterThanOrEqual(50);
  });

  it("still works when the model sends no percent at all", () => {
    // Falls back to the old section maths. Being ON a section means the ones
    // before it are behind you, so "topics" (index 2) counts as 2 of 6 done.
    expect(shownPct(render({ section: "company", collected: {} }))).toBe(0);
    expect(shownPct(render({ section: "topics", collected: { company: true } }))).toBe(33);
    expect(shownPct(render({ section: "path", collected: { company: true } }))).toBe(17);
  });

  it("ignores a malformed or out-of-range percent rather than rendering nonsense", () => {
    for (const percent of [null, undefined, "", "abc", NaN, -40, 900, Infinity]) {
      const p = shownPct(render({ section: "company", percent, collected: {} }));
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });

  it("reaches 100 at the end", () => {
    const all = Object.fromEntries(["company", "path", "topics", "channels", "reports", "users"].map((k) => [k, true]));
    expect(shownPct(render({ section: "users", percent: 100, collected: all }))).toBe(100);
  });

  it("drives the progress bar with the same value", () => {
    // Bar and number are read together; if they disagree the UI looks broken.
    const html = render({ section: "company", percent: 22, collected: {} });
    expect(html).toContain("width:22%");
  });

  it("leaves the desktop stepper alone", () => {
    // Desktop renders six dots and no percentage; this change must not add one.
    const html = render({ section: "company", percent: 22, collected: {} }, false);
    expect(shownPct(html)).toBeNull();
  });
});
