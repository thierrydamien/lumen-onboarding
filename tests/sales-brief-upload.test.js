// The Sales "Upload completed brief" path. Entirely separate code from the
// client's attachment reader: the rep's .xlsx is base64'd to
// netlify/functions/parse-brief.js and parsed SERVER-side, so nothing the
// client-side tests cover applies here.
//
// Uses the REAL template shipped in public/, not a mock — the parser keys on
// that file's exact labels, so a mock would prove nothing about the file reps
// actually download and fill in.

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";
import { parseMediaBrief, readWorkbook } from "../netlify/functions/parse-brief.js";

const TEMPLATE = readFileSync(new URL("../public/media-brief-template.xlsx", import.meta.url));
const wbOf = (buf) => XLSX.read(buf, { type: "buffer" });

/** Fill a labelled row in the template's first sheet, as a rep would. */
function fill(pairs) {
  const wb = wbOf(TEMPLATE);
  const name = wb.SheetNames[0];
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
  for (const [label, value] of Object.entries(pairs)) {
    const idx = rows.findIndex((r) => r.some((c) => String(c || "").toLowerCase().includes(label.toLowerCase())));
    if (idx === -1) throw new Error(`label not found in template: ${label}`);
    rows[idx][2] = value;                       // value column
  }
  const rebuilt = XLSX.utils.aoa_to_sheet(rows);
  wb.Sheets[name] = rebuilt;
  return XLSX.read(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
}

describe("the real template is still the file the parser expects", () => {
  it("carries the signature the parser keys on", () => {
    // If the template is ever re-exported and loses this, EVERY upload starts
    // failing as "not_template" with nothing else changing.
    const rows = XLSX.utils.sheet_to_json(wbOf(TEMPLATE).Sheets[wbOf(TEMPLATE).SheetNames[0]], { header: 1, defval: "" });
    expect(/media brief form/i.test(rows.flat().join(" "))).toBe(true);
  });

  it("reports an untouched template as empty rather than importing nothing", () => {
    expect(parseMediaBrief(wbOf(TEMPLATE)).error).toBe("template_empty");
  });
});

describe("a filled template", () => {
  it("extracts what the rep typed", () => {
    const out = parseMediaBrief(fill({
      "Company name": "Nordlicht Brauerei",
      "Key brands": "Nordlicht Pils, Nordlicht IPA",
    }));
    expect(out.error).toBeUndefined();
    const text = JSON.stringify(out);
    expect(text).toContain("Nordlicht Brauerei");
    expect(text).toContain("Nordlicht IPA");
  });

  it("keeps non-ASCII values intact", () => {
    const out = parseMediaBrief(fill({ "Company name": "Brasserie Père & Fils — Zürich" }));
    expect(JSON.stringify(out)).toContain("Père & Fils");
  });
});

describe("a rep uploads the wrong file", () => {
  it("rejects a workbook that is not the template", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Some", "other"], ["spread", "sheet"]]), "Sheet1");
    expect(parseMediaBrief(wb).error).toBe("not_template");
  });

  it("rejects junk bytes rather than importing gibberish", () => {
    // XLSX.read does not throw on junk — it sniffs the bytes as text. Server-side
    // the template SIGNATURE is what stops it, where the client relies on a
    // magic-byte check. Different guard, same outcome: a clear refusal.
    const junk = readWorkbook(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])); // %PDF-1.7
    if (junk.error) { expect(junk.error).toBe("unreadable"); return; }
    expect(parseMediaBrief(junk.wb).error).toBe("not_template");
  });

  it("rejects an empty workbook", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
    expect(parseMediaBrief(wb).error).toBeTruthy();
  });

  it("never throws on anything a rep could actually upload", () => {
    // Deliberately REACHABLE inputs only. parseMediaBrief does throw on a
    // hand-made malformed workbook object, but readWorkbook cannot produce one —
    // XLSX.read always returns a real workbook — so guarding that would be
    // defending against a state the handler cannot reach. These are the shapes a
    // rep genuinely produces: a truncated download, a renamed PDF, a CSV saved
    // with the wrong extension, a corrupted file. A throw here is a dead page for
    // the rep; an error string is a message they can act on.
    const cases = {
      "1 byte": Buffer.from([0x41]),
      "truncated xlsx": Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
      "PDF renamed": Buffer.from("%PDF-1.7\n%junk"),
      "plain text": Buffer.from("company,market\nAcme,DE"),
      "random binary": Buffer.from([...Array(64)].map((_, i) => (i * 7) % 256)),
    };
    for (const [name, buf] of Object.entries(cases)) {
      const r = readWorkbook(buf);
      if (r.error) { expect(r.error, name).toBe("unreadable"); continue; }
      let out;
      expect(() => { out = parseMediaBrief(r.wb); }, name).not.toThrow();
      expect(out.error, name).toBeTruthy();   // refused, never silently "imported"
    }
  });
});
