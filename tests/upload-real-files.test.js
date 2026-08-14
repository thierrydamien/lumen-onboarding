// Real bytes through the real reader.
//
// extractFileText is the shared entry point for BOTH client upload paths — the
// composer paperclip and the QUERIES widget — so anything wrong here is wrong in
// both. The .docx branch is the risky one: it parses the ZIP container itself
// (end-of-central-directory scan, central directory walk, local header, raw
// inflate) rather than using a library, so it meets malformed input from real
// clients with hand-written code. tests/upload.test.js covers the surrounding
// UI rules; this covers the bytes.

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { extractFileText } from "../src/lumen.jsx";
import { docx, docxWithoutBody, makeZip, asFile } from "./fixtures/make-files.mjs";

const xlsxBytes = (aoa, opts = {}) => {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (opts.ref) ws["!ref"] = opts.ref;              // a stretched used-range
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, opts.sheetName || "Sheet1");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
};

describe(".docx — hand-rolled ZIP parsing", () => {
  it("reads a normal deflate-compressed document", async () => {
    const f = asFile("brief.docx", "", docx(["Markets: Germany, Austria", "Competitors: Acme, Globex"]));
    const r = await extractFileText(f);
    expect(r.error).toBeUndefined();
    expect(r.text).toContain("Markets: Germany, Austria");
    expect(r.text).toContain("Competitors: Acme, Globex");
  });

  it("reads a STORED (uncompressed) document too", async () => {
    // Separate branch in the reader (method 0), and some tools emit it.
    const f = asFile("brief.docx", "", docx(["Stored not deflated"], { method: 0 }));
    const r = await extractFileText(f);
    expect(r.text).toContain("Stored not deflated");
  });

  it("keeps paragraphs apart rather than running words together", async () => {
    const r = await extractFileText(asFile("b.docx", "", docx(["First line", "Second line"])));
    expect(r.text).not.toMatch(/First lineSecond line/);
  });

  it("reports a readable error for a renamed non-Word zip", async () => {
    // e.g. a client renames a .pptx. Must not crash the tab.
    const r = await extractFileText(asFile("deck.docx", "", docxWithoutBody()));
    expect(r.error).toBe("readError");
  });

  it("reports a readable error for a corrupt zip", async () => {
    const r = await extractFileText(asFile("bad.docx", "", docx(["x"], { corruptEOCD: true })));
    expect(r.error).toBe("readError");
  });

  it("reports a readable error for a truncated file", async () => {
    const full = docx(["some content here"]);
    const r = await extractFileText(asFile("cut.docx", "", full.slice(0, Math.floor(full.length / 2))));
    expect(r.error).toBe("readError");
  });

  it("does not hang or throw on an empty file", async () => {
    const r = await extractFileText(asFile("empty.docx", "", new Uint8Array(0)));
    expect(r.error).toBe("readError");
  });

  it("strips XML tags instead of dumping markup at the model", async () => {
    const r = await extractFileText(asFile("b.docx", "", docx(["Plain text please"])));
    expect(r.text).not.toContain("<w:");
    expect(r.text).not.toContain("xmlns");
  });
});

describe(".xlsx", () => {
  it("reads a normal sheet into pipe-joined rows", async () => {
    const bytes = xlsxBytes([["Market", "Priority"], ["Germany", "1"], ["Austria", "2"]]);
    const r = await extractFileText(asFile("markets.xlsx", "", bytes));
    expect(r.text).toContain("Germany | 1");
    expect(r.text).toContain("Austria | 2");
  });

  it("reads every sheet, not just the first", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["one"]]), "First");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["two"]]), "Second");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
    const r = await extractFileText(asFile("multi.xlsx", "", bytes));
    expect(r.text).toContain("one");
    expect(r.text).toContain("two");
  });

  it("survives a used-range stretched to a million rows", async () => {
    // Applying formatting to a whole column is enough to do this in real files.
    // Unclamped it materialises millions of rows and hard-freezes the tab, so
    // this must return quickly with the real content intact.
    const bytes = xlsxBytes([["Real", "Data"], ["still", "here"]], { ref: "A1:Z100000" });
    const t0 = Date.now();
    const r = await extractFileText(asFile("stretched.xlsx", "", bytes));
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.text).toContain("Real | Data");
  });

  it("drops empty rows rather than emitting blank lines", async () => {
    const r = await extractFileText(asFile("gaps.xlsx", "", xlsxBytes([["A"], [""], [""], ["B"]])));
    expect(r.text).not.toMatch(/\n\s*\n/);
  });

  it("rejects a file that is not really a workbook", async () => {
    // XLSX.read does NOT throw on junk: it sniffs unknown bytes as text and
    // returns them as a one-cell sheet. So before the magic-byte check, a
    // truncated download or a renamed .pdf reported a SUCCESSFUL import and sent
    // raw control characters to the model as the client's requirements doc.
    const r = await extractFileText(asFile("bad.xlsx", "", new Uint8Array([1, 2, 3, 4, 5])));
    expect(r.error).toBe("readError");
    expect(r.text).toBeUndefined();
  });

  it("rejects a PDF renamed to .xlsx", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
    expect((await extractFileText(asFile("brief.xlsx", "", pdf))).error).toBe("readError");
  });

  it("still accepts a genuine workbook after the check", async () => {
    const r = await extractFileText(asFile("ok.xlsx", "", xlsxBytes([["Germany", "1"]])));
    expect(r.error).toBeUndefined();
    expect(r.text).toContain("Germany | 1");
  });
});

describe("plain text and the allowlist", () => {
  it("reads .txt and .csv", async () => {
    expect((await extractFileText(asFile("q.txt", "text/plain", "alpha\nbeta"))).text).toBe("alpha\nbeta");
    expect((await extractFileText(asFile("q.csv", "text/csv", "a,b\n1,2"))).text).toBe("a,b\n1,2");
  });

  it("reads a text file whose extension is missing", async () => {
    expect((await extractFileText(asFile("queries", "text/plain", "boolean AND query"))).text).toBe("boolean AND query");
  });

  it("still refuses other text/* types", async () => {
    for (const [n, t] of [["p.html", "text/html"], ["s.js", "text/javascript"], ["d.xml", "text/xml"]]) {
      expect((await extractFileText(asFile(n, t, "<b>x</b>"))).error).toBe("unsupported");
    }
  });

  it("refuses formats the UI never promised", async () => {
    for (const [n, t] of [["scan.pdf", "application/pdf"], ["old.doc", "application/msword"], ["photo.jpg", "image/jpeg"], ["data.zip", "application/zip"]]) {
      expect((await extractFileText(asFile(n, t, new Uint8Array([0, 1, 2])))).error).toBe("unsupported");
    }
  });

  it("rejects an oversized file before reading it into memory", async () => {
    const boom = { name: "huge.xlsx", type: "", size: 5 * 1024 * 1024,
      arrayBuffer: async () => { throw new Error("must not read"); }, text: async () => { throw new Error("must not read"); } };
    const r = await extractFileText(boom);
    expect(r.error).toBe("tooLarge");
    expect(Number(r.mb)).toBeGreaterThan(2);
  });

  it("handles an empty .txt without claiming success on nothing", async () => {
    const r = await extractFileText(asFile("empty.txt", "text/plain", ""));
    expect(r.text).toBe("");
  });

  it("reads non-ASCII content correctly", async () => {
    const r = await extractFileText(asFile("de.txt", "text/plain", "Märkte: Deutschland, Österreich — Grüße"));
    expect(r.text).toContain("Märkte");
    expect(r.text).toContain("Grüße");
  });

  it("reads right-to-left content correctly", async () => {
    const r = await extractFileText(asFile("ar.csv", "text/csv", "الإمارات,السعودية"));
    expect(r.text).toContain("الإمارات");
  });
});

describe("a zip bomb cannot be used to freeze the tab", () => {
  it("bounds how much it inflates from a small .docx", async () => {
    // 8MB of repeated text compresses to well under the 2MB gate, so the size
    // cap alone does not protect the main thread — the inflate has to stop.
    const huge = "A".repeat(8 * 1024 * 1024);
    const bytes = docx([huge]);
    expect(bytes.length).toBeLessThan(2 * 1024 * 1024); // passes the size gate
    const t0 = Date.now();
    const r = await extractFileText(asFile("bomb.docx", "", bytes));
    expect(Date.now() - t0).toBeLessThan(10000);
    expect(r.error === "readError" || (r.text && r.text.length < huge.length)).toBe(true);
  });
});
