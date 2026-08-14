// The "Completed per week" sparkline.
//
// It used to bucket ONLY the weeks that had completions and take the last 10 of
// those, which silently deleted time: three completions, a dead month, then two
// more rendered as five adjacent evenly-spaced columns reading "steady, about one
// a week". And if completions stopped entirely a month ago the chart still ENDED
// on a healthy-looking bar, because the recent empty weeks were never buckets —
// the one signal a manager most needs (it just went quiet) was the one signal the
// chart structurally could not show.
//
// weeklyCompletions is pure, so it is EXTRACTED and exercised rather than
// pattern-matched: the bug lived in which weeks exist, which no regex would see.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const dash = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");

// weeklyCompletions leans on WEEK_MS/mondayOf/weekKey, so pull the whole cluster.
function loadWeekly() {
  const grab = (re) => { const m = dash.match(re); if (!m) throw new Error("not found: " + re); return m[0]; };
  const src = [
    grab(/var WEEK_MS = [^\n]+/),
    grab(/function mondayOf\([\s\S]*?\n  \}/),
    grab(/function weekKey\([\s\S]*?\n  \}/),
    grab(/function weeklyCompletions\([\s\S]*?\n  \}/),
  ].join("\n");
  return new Function(src + "; return weeklyCompletions;")();
}
const weeklyCompletions = loadWeekly();

const DAY = 24 * 60 * 60 * 1000, WEEK = 7 * DAY;
// Anchor fixtures to the CURRENT WEEK'S MONDAY, not to "N weeks and a day ago".
// A plain now-minus-8-days lands in different weeks depending on which weekday
// the suite runs — on a Monday it falls into the week before the one intended —
// so index assertions would fail one day in seven. Monday itself is always in the
// past-or-present, which keeps the n=0 (current week) case valid too.
const thisMonday = (() => { const d = new Date(); const day = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); })();
/** A completion sitting squarely inside the week that began `weeksAgo` weeks back. */
const done = (weeksAgo) => ({
  status: "completed",
  savedAt: new Date(thisMonday.getTime() - weeksAgo * WEEK + (weeksAgo === 0 ? 0 : DAY)).toISOString(),
});

describe("the weekly completions series", () => {
  it("always spans ten calendar weeks, ending with the current one", () => {
    const s = weeklyCompletions([done(1)]);
    expect(s).toHaveLength(10);
    expect(s[9].current).toBe(true);
    expect(s.filter((x) => x.current)).toHaveLength(1);
  });

  it("renders a gap as a gap instead of closing it up", () => {
    // Completions in weeks 9, 8, 7 and 2, 1 — a four-week dry spell between.
    const s = weeklyCompletions([done(9), done(8), done(8), done(7), done(2), done(1)]);
    const values = s.map((x) => x.value);
    // Ten columns, and the dry weeks are real zeros sitting between the bursts.
    expect(values).toHaveLength(10);
    const firstHit = values.findIndex((v) => v > 0);
    const lastHit = values.length - 1 - [...values].reverse().findIndex((v) => v > 0);
    expect(values.slice(firstHit, lastHit + 1).filter((v) => v === 0).length).toBeGreaterThanOrEqual(4);
    // The old implementation dropped empty weeks entirely, so every column was
    // non-zero and the series was shorter than the span it claimed to cover.
    expect(values.every((v) => v > 0)).toBe(false);
  });

  it("ends on zeros when completions have stopped — the alarm the old chart hid", () => {
    const s = weeklyCompletions([done(9), done(8), done(7)]);
    expect(s).toHaveLength(10);
    expect(s.slice(-4).every((x) => x.value === 0)).toBe(true);
    expect(s[9].value).toBe(0);
  });

  it("counts each completion into its own week, once", () => {
    const s = weeklyCompletions([done(3), done(3), done(1)]);
    expect(s.reduce((a, x) => a + x.value, 0)).toBe(3);
    expect(s[6].value).toBe(2); // 10 columns, index 9 = this week -> 3 weeks ago = 6
    expect(s[8].value).toBe(1);
  });

  it("ignores link-sent rows, unfinished sessions and unparseable dates", () => {
    const rows = [
      { status: "completed", savedAt: new Date(Date.now() - WEEK).toISOString(), _linkSent: true },
      { status: "in_progress", savedAt: new Date(Date.now() - WEEK).toISOString() },
      { status: "completed", savedAt: "not a date" },
    ];
    expect(weeklyCompletions(rows)).toEqual([]);
  });

  it("shows the friendly empty state only when nothing has EVER completed", () => {
    expect(weeklyCompletions([])).toEqual([]);
    // A completion outside the 10-week window still means "we have completions",
    // so the chart shows ten honest zero weeks rather than "none yet".
    const old = weeklyCompletions([done(30)]);
    expect(old).toHaveLength(10);
    expect(old.every((x) => x.value === 0)).toBe(true);
  });

  it("labels every column and keeps them in chronological order", () => {
    const s = weeklyCompletions([done(1)]);
    expect(s.every((x) => /^[A-Z][a-z]{2} \d{1,2}$/.test(x.label))).toBe(true);
    expect(new Set(s.map((x) => x.label)).size).toBe(10); // no duplicate weeks
  });
});

describe("the sparkline's rendering of an empty week", () => {
  it("draws a flat baseline, not a stub bar that reads as activity", () => {
    const fn = dash.slice(dash.indexOf("function sparkHtml("));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    expect(body).toMatch(/var zero = !s\.value;/);
    expect(body).toMatch(/zero \? 0 :/);          // no minimum height for a zero
    expect(body).toMatch(/czero/);                // its own flat element
    expect(body).not.toMatch(/Math\.max\(3,/);    // the old 3% floor is gone
  });

  it("marks the current, still-filling week so a short final bar isn't read as a drop", () => {
    expect(dash).toMatch(/\.scol\.cur \.clbl/);
    expect(dash).toContain("this week, so far");
  });
});
