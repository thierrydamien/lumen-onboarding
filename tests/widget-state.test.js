// Regression tests for the skip sentinel.
//
// THE BUG THIS GUARDS: onWSkip records { submitted: true, data: "__skip__" } so the
// collapsed row can say "Skipped". Tapping "Edit" flipped only `submitted`, leaving
// the sentinel in `data`, which renderWidget then passed straight to the widget as
// initialData. UserForm does users.map() and ChipSelector does sel.filter(); a string
// has neither, so the render threw, and because the throw happened during render the
// error boundary in chat-main.jsx replaced the ENTIRE app with the failure screen.
// Skip a widget, tap Edit, lose your session.

import { describe, it, expect } from "vitest";
import { SKIP, widgetInitialData } from "../src/lumen.jsx";

describe("widgetInitialData", () => {
  it("maps the skip sentinel to undefined so widgets take their fresh-state default", () => {
    expect(widgetInitialData({ submitted: false, data: SKIP })).toBeUndefined();
    expect(widgetInitialData({ submitted: true, data: SKIP })).toBeUndefined();
  });

  it("passes real captured data through untouched", () => {
    const markets = ["United Kingdom", "France"];
    expect(widgetInitialData({ submitted: false, data: markets })).toBe(markets);

    const users = [{ firstName: "Ada", email: "ada@example.com" }];
    expect(widgetInitialData({ submitted: false, data: users })).toBe(users);
  });

  it("tolerates every shape wState can legitimately hold", () => {
    // `true` is the legacy submitted marker; undefined is a widget never interacted with.
    expect(widgetInitialData(true)).toBeUndefined();
    expect(widgetInitialData(undefined)).toBeUndefined();
    expect(widgetInitialData(null)).toBeUndefined();
    expect(widgetInitialData({})).toBeUndefined();
  });

  it("never returns a value that would crash a .map or .filter widget", () => {
    // The precise failure mode: a bare string reaching UserForm / ChipSelector.
    for (const ws of [{ data: SKIP }, { data: "__skip__" }, true, null, undefined, {}]) {
      const out = widgetInitialData(ws);
      expect(typeof out === "string").toBe(false);
    }
  });
});
