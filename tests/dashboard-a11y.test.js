// Dashboard keyboard operability and text contrast.
//
// These are the failures that don't announce themselves: the dashboard looked and
// worked fine with a mouse while the two primary actions (open a session, sort the
// table) were unreachable without one, and two text colours sat under the WCAG AA
// floor. Both regress silently, so they are pinned against the shipped source.
//
// Contrast is COMPUTED here rather than compared to a known-good hex, so the test
// still holds if someone re-tunes the palette: any colour that clears the ratio passes.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const dash = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");

// WCAG relative luminance / contrast ratio (same maths the browser check used).
function luminance(hex) {
  const c = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = ch.map((x) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function token(name) {
  const m = dash.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})"));
  if (!m) throw new Error("token --" + name + " not found");
  return m[1];
}

describe("text contrast clears WCAG AA", () => {
  it("--muted is readable on both surfaces it is used on", () => {
    // It carries the table footnote, the filter labels and every .sub2, on the page
    // background AND on white cards. It previously measured 4.39:1 on --bg.
    const muted = token("muted");
    expect(contrast(muted, token("bg")), "muted on --bg").toBeGreaterThanOrEqual(4.5);
    expect(contrast(muted, "#ffffff"), "muted on card white").toBeGreaterThanOrEqual(4.5);
  });

  it("the chart 'click to filter' hint is not its own faint colour", () => {
    // It was #a9b0bd at 2.18:1 and 10px: a real instruction, effectively unreadable.
    // Requiring the token (not a literal) keeps it tied to the checked value above.
    const rule = dash.match(/\.chint\s*\{[^}]*\}/);
    expect(rule, ".chint rule not found").toBeTruthy();
    expect(rule[0]).toContain("color:var(--muted)");
  });
});

describe("the table is operable without a mouse", () => {
  it("sorting is a real button, not a click handler on the th", () => {
    // A bare <th onclick> can't be tabbed to or activated by keyboard at all.
    expect(dash).toMatch(/<button type="button" class="sortbtn" data-sort="/);
    expect(dash).toMatch(/querySelectorAll\("\.sortbtn"\)/);
    // The old th-level binding must be gone, or sorting silently fires twice.
    expect(dash).not.toMatch(/querySelectorAll\("th\.sortable"\)/);
  });

  it("each sortable header reports its sort state", () => {
    expect(dash).toMatch(/aria-sort="'\s*\+\s*aSort/);
    expect(dash).toMatch(/ascending/);
    expect(dash).toMatch(/descending/);
  });

  it("keeps focus on the column after a sort rebuilds the table", () => {
    // renderTable() replaces the whole table, so focus would otherwise fall to <body>
    // and a keyboard user would lose their place mid-sort.
    const handler = dash.slice(dash.indexOf('querySelectorAll(".sortbtn")'));
    expect(handler).toMatch(/\.sortbtn\[data-sort="'\s*\+\s*k/);
    expect(handler).toContain(".focus()");
  });

  it("opening a session is reachable: the client name is a button", () => {
    expect(dash).toMatch(/class="rowopen" data-link="1" data-open="/);
    expect(dash).toMatch(/querySelectorAll\("\.rowopen"\)/);
  });

  it("does not offer that button on rows with nothing to open", () => {
    // "Link sent" rows are seeds with no session behind them; a keyboard affordance
    // there would promise a detail view that does not exist.
    const cell = dash.slice(dash.indexOf("var nameCell ="), dash.indexOf("return '<tr class=\"row\""));
    expect(cell).toMatch(/s\._linkSent\s*\?/);
    expect(cell.slice(0, cell.indexOf(":"))).not.toContain("rowopen");
  });
});

describe("the session dialog keeps the keyboard inside it", () => {
  it("traps Tab while the modal is open", () => {
    // aria-modal="true" tells assistive tech the page behind is inert, but it does NOT
    // change the browser's tab order — without an explicit trap, Tab walks out of the
    // dialog into a table the user can no longer see.
    const trap = dash.slice(dash.indexOf("var FOCUSABLE ="));
    expect(trap).toMatch(/e\.key !== "Tab"/);
    expect(trap).toContain('classList.contains("show")');
    expect(trap).toContain("e.preventDefault()");
  });

  it("wraps in both directions and reclaims focus from outside", () => {
    const trap = dash.slice(dash.indexOf("var FOCUSABLE ="));
    expect(trap, "shift+tab off the first must wrap to the last").toMatch(/e\.shiftKey && here === first[\s\S]{0,80}last\.focus\(\)/);
    expect(trap, "tab off the last must wrap to the first").toMatch(/!e\.shiftKey && here === last[\s\S]{0,80}first\.focus\(\)/);
    expect(trap, "focus parked outside must be pulled back").toMatch(/!sheet\.contains\(here\)/);
  });

  it("ignores controls that are not rendered", () => {
    // The brief omits sections with no content; a zero-size control must not become an
    // invisible tab stop that focus appears to vanish into.
    const trap = dash.slice(dash.indexOf("var FOCUSABLE ="));
    expect(trap).toMatch(/offsetWidth > 0 \|\| n\.offsetHeight > 0/);
  });
});

describe("bulk selection feedback", () => {
  it("the bulk bar sticks instead of scrolling away", () => {
    // Clearing test rows means scrolling down and ticking a run of them; in flow the
    // bar ended up ~1300px above the viewport, so ticking a box showed nothing.
    expect(dash).toMatch(/#bulkSlot\s*\{[^}]*position:sticky/);
  });

  it("a partial selection does not look like an empty one", () => {
    const paint = dash.slice(dash.indexOf("function paintSelection"), dash.indexOf("function syncBoxes"));
    expect(paint).toContain("selAll.indeterminate");
    expect(paint).toMatch(/picked > 0 && picked < shown\.length/);
  });
});
