// Dashboard scanning and filter-state behaviour.
//
// fmtRelative is a pure function, so it is extracted from the page's inline script and
// EXERCISED rather than pattern-matched: its boundaries (a minute, an hour, a day, a
// week, the point where it gives up and prints a date) are exactly where an off-by-one
// hides, and none of them would be visible in a regex assertion.
//
// The rest is source-parsed, in the same style as the other dashboard tests, because it
// lives in DOM wiring rather than in an extractable function.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const dash = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");

// Pull a top-level function (2-space indented) out of the inline script and evaluate it.
function loadFn(name) {
  const m = dash.match(new RegExp("function " + name + "\\([\\s\\S]*?\\n  \\}"));
  if (!m) throw new Error(name + " not found in dashboard.html");
  return new Function(m[0] + "; return " + name + ";")();
}

const fmtRelative = loadFn("fmtRelative");
const ago = (ms) => fmtRelative(new Date(Date.now() - ms).toISOString());
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR, WEEK = 7 * DAY;

describe("relative timestamps", () => {
  it("reads as 'just now' under a minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59 * SEC)).toBe("just now");
  });

  it("switches unit exactly on each boundary, never a step early", () => {
    expect(ago(60 * SEC)).toBe("1 min ago");
    expect(ago(59 * MIN)).toBe("59 min ago");
    expect(ago(60 * MIN)).toBe("1h ago");
    expect(ago(23 * HOUR)).toBe("23h ago");
    expect(ago(24 * HOUR)).toBe("1d ago");
    expect(ago(6 * DAY)).toBe("6d ago");
    expect(ago(7 * DAY)).toBe("1w ago");
  });

  it("rounds down, so it never overstates how recent something is", () => {
    // "2 min ago" on something 119s old would read as fresher than it is.
    expect(ago(119 * SEC)).toBe("1 min ago");
    expect(ago(47 * HOUR)).toBe("1d ago");
  });

  it("gives up on weeks past a month and prints a date", () => {
    expect(ago(4 * WEEK)).toBe("4w ago");
    // Nobody counts back nine weeks; an absolute date is more useful there.
    expect(ago(9 * WEEK)).not.toMatch(/ago$/);
    expect(ago(9 * WEEK)).toMatch(/\d/);
  });

  it("survives missing and unparseable values", () => {
    expect(fmtRelative(null)).toBe("—");
    expect(fmtRelative("")).toBe("—");
    expect(fmtRelative("not a date")).toBe("—");
  });

  it("does not print a negative age when the client clock runs behind", () => {
    // Sessions are stamped by the client, so a viewer whose clock is behind can see a
    // future timestamp. "-3 min ago" would look broken.
    expect(fmtRelative(new Date(Date.now() + 5 * MIN).toISOString())).toBe("just now");
  });

  it("keeps the exact timestamp reachable on the row", () => {
    // Relative is for scanning; the precise value must not be lost.
    expect(dash).toMatch(/title="'\s*\+\s*esc\(fmtDate\(s\.lastActiveAt/);
  });

  it("leaves sorting and export on the raw value", () => {
    // Both must key off the ISO string, not the rendered label, or "1w ago" sorts
    // alphabetically and the CSV becomes useless for analysis.
    expect(dash).toMatch(/key === "lastActive"\) return Date\.parse/);
    const csv = dash.slice(dash.indexOf("function exportCsv"));
    expect(csv).toContain("s.lastActiveAt || s.sentAt || s.savedAt");
    expect(csv).not.toContain("fmtRelative");
  });
});

describe("filter state has a single source of truth", () => {
  it("chips, the More-filters badge and the empty state all read one function", () => {
    // These three previously would have needed three copies of "is this filter set?",
    // which is exactly how a chip shows a filter the badge does not count.
    expect(dash).toContain("function activeFilterDims()");
    const uses = dash.match(/activeFilterDims\(\)/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(4); // definition + chips + badge + empty state
  });

  it("repaints the badge on every table render, not on filter-bar rebuild", () => {
    // The secondary controls deliberately call only renderTable(), because rebuilding
    // the bar would destroy the <select> mid-change. So the badge must repaint from
    // there or the count silently never appears.
    expect(dash).toContain("function paintMoreBadge()");
    const raf = dash.slice(dash.indexOf("function renderActiveFilters"), dash.indexOf("function clearFilter"));
    expect(raf).toContain("paintMoreBadge()");
  });
});

describe("the More-filters disclosure", () => {
  it("keeps search and status in the bar", () => {
    const bar = dash.slice(dash.indexOf("box.innerHTML ="), dash.indexOf('<div class="morefilters'));
    expect(bar).toContain("fSearch");
    expect(bar).toContain("fstatus");
  });

  it("moves the six low-traffic filters behind it", () => {
    const panel = dash.slice(dash.indexOf('<div class="morefilters'));
    for (const id of ["fPct", "fOwner", "fPkg", "fLang", "fFrom", "fTo"]) {
      expect(panel.slice(0, panel.indexOf("</div>")), id).toContain(id);
    }
  });

  it("does not collapse under the user when the table re-renders", () => {
    // Deriving open/closed from FILTER would snap it shut on every status-pill click.
    expect(dash).toMatch(/var MOREOPEN = false;/);
    const toggle = dash.slice(dash.indexOf('$("fMore").addEventListener'));
    expect(toggle.slice(0, 400)).toContain("classList.toggle");
    expect(toggle.slice(0, 400)).not.toContain("renderFilters()");
  });

  it("reports its state to assistive tech", () => {
    expect(dash).toMatch(/aria-expanded="'\s*\+/);
    expect(dash).toContain('aria-controls="moreBox"');
  });
});

describe("the no-match empty state", () => {
  it("says how many filters are responsible", () => {
    const empty = dash.slice(dash.indexOf("var nDims = activeFilterDims().length;"));
    expect(empty.slice(0, 700)).toContain("narrowing the list");
  });

  it("offers a way out, and only when a filter is actually the cause", () => {
    const empty = dash.slice(dash.indexOf("var nDims = activeFilterDims().length;"));
    expect(empty.slice(0, 700)).toMatch(/nDims \?[\s\S]{0,120}emptyClear/);
  });

  it("defers to the real Clear button rather than resetting state itself", () => {
    // Two reset paths drift; this one delegates.
    expect(dash).toMatch(/emptyClear[\s\S]{0,200}\$\("fClear"\)[\s\S]{0,40}\.click\(\)/);
  });
});
