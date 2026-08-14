// The .xlsx brief is what the consultant actually receives, and until now
// nothing tested it. Verified end to end in a real browser first — a complete
// session downloaded a 39KB workbook with five sheets and the right content —
// these tests pin the parts that can silently go wrong.
//
// "Preferred Onboarding Language" is the field the handover records as a past
// bug (it always read English). It is fed by the CLIENT'S UI language, which is
// a different thing from "Key Languages" (what Lumen should MONITOR). Confusing
// the two is what makes this field easy to break, so both are asserted here.

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { buildWorkbook } from "../src/lumen.jsx";

const BRIEF = {
  company: {
    name: "Nordlicht Brauerei", email: "k.hoffmann@nordlicht.de", industry: "Craft Beer",
    useCase: "Did the festival sponsorship pay off", contact: "Katrin Hoffmann",
    languages: "German, English",           // what Lumen MONITORS
    onboardingLanguage: "German",           // the language the CLIENT was onboarded in
    timezone: "CET (UTC+1)", objectives: "1. Reputation Management", markets: "Germany, Austria", teams: "Marketing",
  },
  topics: [{ type: "Topic", group: "Own brand", name: "Nordlicht", keywords: '"Nordlicht Brauerei" NOT Nordlichter', urls: "https://nordlicht.de", hashtags: "#nordlicht", comments: "main brand" }],
  channels: [{ author: "Nordlicht", type: "Instagram", url: "https://instagram.com/nordlicht" }],
  reports: [{ name: "Brand Health", kind: "Report", objective: "Reputation Management", details: "weekly, to the CMO", comments: "" }],
  alerts: [{ name: "Crisis spike", details: "negative spike, to comms", comments: "" }],
};
const USERS = [{ firstName: "Katrin", lastName: "Hoffmann", email: "k.hoffmann@nordlicht.de", role: "CMO", access: "Admin" }];

const textOf = (wb) => wb.SheetNames
  .map((sn) => XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: "" }).map((r) => r.join(" | ")).join("\n"))
  .join("\n");

/** The value cell of a labelled row, i.e. everything after label and example. */
function valueFor(wb, label) {
  for (const sn of wb.SheetNames) {
    for (const r of XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: "" })) {
      if (String(r[0] || "").trim() === label) return String(r[r.length - 1] || "").trim();
    }
  }
  return null;
}

describe("the consultant's workbook", () => {
  it("builds every sheet the template expects", () => {
    const { wb } = buildWorkbook(XLSX, BRIEF, USERS);
    expect(wb.SheetNames).toEqual([
      "About your business", "Users list", "Topics-Filters-Hashtags", "Social Channels", "Reports-Dashboards-Alerts",
    ]);
  });

  it("names the file after the company", () => {
    const { filename } = buildWorkbook(XLSX, BRIEF, USERS);
    expect(filename).toMatch(/Nordlicht_Brauerei/);
    expect(filename).toMatch(/\.xlsx$/);
  });

  it("carries the onboarding language the client actually used", () => {
    // The past bug: this cell always read "English". It must follow the client.
    const { wb } = buildWorkbook(XLSX, BRIEF, USERS);
    expect(valueFor(wb, "Preferred Onboarding Language")).toBe("German");
  });

  it("keeps monitoring languages separate from the onboarding language", () => {
    // "Key Languages" is what Lumen watches; the two are independent and
    // collapsing them is how this field broke before.
    const { wb } = buildWorkbook(XLSX, BRIEF, USERS);
    expect(valueFor(wb, "Key Languages")).toBe("German, English");
    expect(valueFor(wb, "Preferred Onboarding Language")).toBe("German");
  });

  it("falls back to English only when nothing was captured", () => {
    const { wb } = buildWorkbook(XLSX, { ...BRIEF, company: { ...BRIEF.company, onboardingLanguage: "" } }, USERS);
    expect(valueFor(wb, "Preferred Onboarding Language")).toBe("English");
  });

  it("carries the data a consultant needs to rebuild the setup", () => {
    const t = textOf(buildWorkbook(XLSX, BRIEF, USERS).wb);
    for (const needle of [
      "Nordlicht Brauerei",                   // company
      "k.hoffmann@nordlicht.de",              // contact
      "Reputation Management",                // ranked objective
      'NOT Nordlichter',                      // the boolean exclusion, not just the topic name
      "instagram.com/nordlicht",              // channel URL, not a bare handle
      "weekly, to the CMO",                   // report cadence AND audience
      "Katrin",                               // named user
    ]) expect(t).toContain(needle);
  });

  it("survives an empty brief rather than throwing mid-download", () => {
    // A client can reach Send with very little captured (the review modal warns
    // but allows it), so this must produce a file, not an exception.
    const { wb, filename } = buildWorkbook(XLSX, { company: {} }, []);
    expect(wb.SheetNames.length).toBeGreaterThan(0);
    expect(filename).toMatch(/\.xlsx$/);
  });
});
