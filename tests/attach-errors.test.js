// Attach-path error wording.
//
// The composer attach previously reported failures through the QUERIES string table,
// so a client attaching a requirements document was told to "export just the queries".
// The most likely trigger is an unsupported type, and the type clients most often try
// is PDF, so this was not a rare edge case. ATERR now resolves attach wording first
// and falls back to the queries table only for messages that read correctly in both.

import { describe, it, expect } from "vitest";
import { ATERR } from "../src/lumen.jsx";

const LANGS = ["English", "French", "German", "Spanish", "Italian", "Arabic"];
// Reworded for the attach context. noText and docxUnavailable are deliberately NOT
// here: they read correctly in both places and fall back to the queries table.
const ATTACH_KEYS = ["tooLarge", "unsupported", "readError", "staleVersion"];

describe("attach error strings", () => {
  it("exist in every supported language", () => {
    for (const lang of LANGS) {
      for (const key of ATTACH_KEYS) {
        const s = ATERR(key, lang, { mb: "3.4", name: "brief.pdf" });
        expect(s, `${key} / ${lang}`).toBeTruthy();
        expect(s.length, `${key} / ${lang}`).toBeGreaterThan(20);
      }
    }
  });

  it("never tells an attaching client to export their queries", () => {
    // The specific defect. "queries" in English, and its equivalent in each language.
    const banned = /\b(quer(y|ies)|requêtes?|Abfragen|consultas|query|استعلامات)\b/i;
    for (const lang of LANGS) {
      for (const key of ATTACH_KEYS) {
        expect(ATERR(key, lang, { mb: "3.4" }), `${key} / ${lang}`).not.toMatch(banned);
      }
    }
  });

  it("interpolates the file size", () => {
    for (const lang of LANGS) {
      const s = ATERR("tooLarge", lang, { mb: "3.4" });
      expect(s, lang).toContain("3.4");
      expect(s, lang).not.toContain("{mb}");
    }
  });

  it("still points at the message box rather than a queries field", () => {
    // English is the one string I can assert on literally; the others are covered by
    // the banned-word check above plus the length floor.
    expect(ATERR("unsupported", "English")).toMatch(/message box/i);
    expect(ATERR("readError", "English")).toMatch(/message box/i);
  });

  it("tells a stale tab to reload, and reassures that nothing is lost", () => {
    const s = ATERR("staleVersion", "English");
    expect(s).toMatch(/reload|refresh/i);
    expect(s).toMatch(/saved/i);
  });

  it("falls back to the queries table for messages shared by both contexts", () => {
    // noText and docxUnavailable are not in the attach table on purpose.
    for (const lang of LANGS) {
      expect(ATERR("noText", lang, { name: "brief.docx" }), lang).toBeTruthy();
      expect(ATERR("docxUnavailable", lang), lang).toBeTruthy();
    }
    expect(ATERR("noText", "English", { name: "brief.docx" })).toContain("brief.docx");
  });

  it("returns something for an unknown key rather than throwing", () => {
    expect(() => ATERR("nope", "English")).not.toThrow();
  });
});
