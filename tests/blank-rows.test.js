// Blank rows must not count as content, anywhere.
//
// Every "+ Add …" control appends a fully empty object. Two problems followed:
//
//   1. Readiness. Clicking "+ Add topic" and typing nothing satisfied BOTH "At least one
//      topic" and "All topics confirmed" (emptyTopic is created confirmed:true).
//      Measured in the review modal: 38% -> 63% for zero information.
//   2. Delivery. `merged` and the separate `users` argument passed the rows straight
//      through, so blanks reached the brief, the generated Sheet and the dashboard
//      counts — a consultant opening a setup form padded with empty rows.
//
// Also covered: the UserForm widget had no way to delete a row. The fully-empty guard
// stopped an untouched row blocking Confirm, but a row the client STARTED and abandoned
// counted as filled, failed validation, and could only be undone by blanking each field.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
const modal = src.slice(src.indexOf("const emptyUser  ="), src.indexOf("const emptyUser  =") + 6000);

describe("readiness ignores empty rows", () => {
  it("defines a shared content test rather than per-field ad hoc checks", () => {
    expect(src).toMatch(/const hasContent = \(o, keys\) =>/);
  });

  it("scores topics and users on rows that carry something", () => {
    expect(modal).toMatch(/\["expReqTopic", realTopics\.length>0\]/);
    expect(modal).toMatch(/\["expReqUser", realUsers\.length>0\]/);
  });

  it("counts unconfirmed topics over the real ones only", () => {
    // Otherwise a blank row created confirmed:true silently satisfies the confirm check.
    expect(modal).toMatch(/const unconfirmed = realTopics\.filter\(t=>!t\.confirmed\)\.length;/);
  });

  it("does not accept a whitespace-only company name", () => {
    expect(modal).toMatch(/\["expReqCompany", !!String\(co\.name\|\|""\)\.trim\(\)\]/);
  });
});

describe("blank rows never reach the brief", () => {
  it("filters every repeated section when building merged", () => {
    const m = src.slice(src.indexOf("const merged = { company:"), src.indexOf("const merged = { company:") + 500);
    expect(m).toContain("topics:realTopics.map");
    expect(m).toContain("channels:realChans.map");
    expect(m).toContain("reports:realReports.map");
    expect(m).toContain("alerts:realAlerts.map");
  });

  it("filters the user list too, which travels as its own argument", () => {
    // Filtering only inside `merged` would still have sent blank people, because the
    // send and download call sites pass users separately.
    expect(src).toMatch(/onSend\(merged, realUsers,/);
    expect(src).toMatch(/onExport\(merged,realUsers\)/);
  });
});

describe("a mistaken user row can be removed", () => {
  it("offers a delete control on the widget's rows", () => {
    const uf = src.slice(src.indexOf("function UserForm"), src.indexOf("function UserForm") + 4200);
    expect(uf).toMatch(/setUsers\(us=>us\.filter\(\(_,j\)=>j!==i\)\)/);
    expect(uf).toMatch(/L\("expRemoveUser",lang/);
  });

  it("hides it when only one row remains", () => {
    // There always has to be someone to enter details for.
    const uf = src.slice(src.indexOf("function UserForm"), src.indexOf("function UserForm") + 4200);
    expect(uf).toMatch(/users\.length>1 && <button/);
  });

  it("clears validation state on removal", () => {
    // Errors are keyed by row index, so deleting a row would otherwise leave a stale
    // message attached to whichever row shifted into that slot.
    const uf = src.slice(src.indexOf("function UserForm"), src.indexOf("function UserForm") + 4200);
    expect(uf).toMatch(/setUsers\(us=>us\.filter\(\(_,j\)=>j!==i\)\); setErrors\(\{\}\);/);
  });
});
