// "Stalled" is defined in two places that must agree:
//   public/dashboard.html          STALE_MS  — what a consultant SEES on the row
//   netlify/functions/stalled-check.js  STALLED_HOURS — when Slack NUDGES
//
// They drifted: the nudge defaulted to 24h while the dashboard used 48h, so the
// Slack alert fired a full day early and deep-linked to a session the dashboard
// still labelled "in progress" — the alert and the page disagreeing about the
// same session. Same shape as the chat/background timeout pair in timeouts.test.js:
// a cross-file constant nobody would think to re-check, so the build checks it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const dash = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");
const check = readFileSync(new URL("../netlify/functions/stalled-check.js", import.meta.url), "utf8");

describe("the stalled threshold", () => {
  it("is the same on the dashboard and in the Slack nudge", () => {
    const m = dash.match(/var STALE_MS = (\d+) \* 3600 \* 1000;/);
    expect(m, "STALE_MS not found in dashboard.html").not.toBeNull();
    const dashHours = Number(m[1]);

    const n = check.match(/Number\(process\.env\.STALLED_HOURS\) \|\| (\d+);/);
    expect(n, "STALLED_HOURS default not found in stalled-check.js").not.toBeNull();
    const nudgeHours = Number(n[1]);

    expect(nudgeHours, `dashboard says ${dashHours}h, nudge says ${nudgeHours}h`).toBe(dashHours);
    expect(dashHours).toBe(48);
  });

  it("says the same number in the docs a operator reads when setting the env var", () => {
    // The header comment is the only place an operator learns the default.
    expect(check).toMatch(/STALLED_HOURS\s+idle threshold in hours \(default 48\)/);
    expect(check).toMatch(/longer than STALLED_HOURS \(default 48\)/);
  });

  it("still fires at most once per session", () => {
    // nudgedAt is what stops an hourly cron re-alerting the same stalled session
    // every hour for days; widening the window makes that more important, not less.
    expect(check).toMatch(/nudgedAt/);
    expect(check).toMatch(/schedule: "0 \* \* \* \*"/);
  });
});
