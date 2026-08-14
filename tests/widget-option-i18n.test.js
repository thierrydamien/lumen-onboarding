// The widget option lists (objectives, teams, markets, languages) were rendered
// raw, so they stayed English in all six supported languages while everything
// around them translated.
//
// Found by running real conversations against the deployed build. The model
// names the options in the CLIENT's language and the widget then lists them in
// English, so the label the client was just told to pick does not appear on
// screen. Captured live:
//   FR turn 12: "je mettrais en priorité la Gestion de la réputation, puis
//                l'Intelligence concurrentielle" -> chips read "Reputation
//                Management", "Competitive Intelligence"
//   AR turn 10: "أرى أن إدارة السمعة تأتي أولاً ... والذكاء التنافسي ثانياً"
//                -> a block of LTR English chips inside an RTL layout
//
// The canonical English values must survive: they are what widgetApiPayload
// sends the model, what lands in the %% markers, and what the brief, the Sheet
// and the dashboard are keyed on. Only the display label may change.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { optLabel, TRANSLATED_OPTION_LISTS, UNTRANSLATED_OPTION_LISTS, OPT_LANGS, ChipSelector, RankedSelector } from "../src/lumen.jsx";

// Rendering the real components is what proves the WIRING, not just the lookup
// table: the bug was that these two rendered the canonical array element
// directly, so a correct translation map would have changed nothing on screen.
describe("the selectors render localised labels", () => {
  const html = (el) => renderToStaticMarkup(el);

  it("ChipSelector shows the client's language, not the canonical English", () => {
    const out = html(React.createElement(ChipSelector, { options: TRANSLATED_OPTION_LISTS.MARKETS_OPT, lang: "French", onSubmit() {} }));
    expect(out).toContain("Royaume-Uni");
    expect(out).toContain("Pays-Bas");
    expect(out).not.toContain("United Kingdom");
    expect(out).not.toContain("Netherlands");
  });

  it("RankedSelector shows the client's language in both the chips and the ranked list", () => {
    const out = html(React.createElement(RankedSelector, {
      options: TRANSLATED_OPTION_LISTS.OBJ_OPT, lang: "Arabic",
      initialData: { ranked: ["Reputation Management"], details: "" }, onSubmit() {},
    }));
    expect(out).toContain("إدارة السمعة");        // chip
    expect(out).toContain("الذكاء التنافسي");      // another chip
    expect(out).not.toContain("Reputation Management");
    expect(out).not.toContain("Competitive Intelligence");
  });

  it("still renders English for an English session", () => {
    const out = html(React.createElement(ChipSelector, { options: TRANSLATED_OPTION_LISTS.TEAM_OPT, lang: "English", onSubmit() {} }));
    expect(out).toContain("Customer Experience");
  });

  it("renders a client-typed custom value unchanged", () => {
    const out = html(React.createElement(ChipSelector, {
      options: TRANSLATED_OPTION_LISTS.MARKETS_OPT, lang: "Arabic", initialData: ["قطر"], onSubmit() {},
    }));
    expect(out).toContain("قطر");
  });
});

describe("optLabel", () => {
  it("translates an option into the conversation language", () => {
    expect(optLabel("Reputation Management", "French")).toBe("Gestion de la réputation");
    expect(optLabel("Reputation Management", "Arabic")).toBe("إدارة السمعة");
    expect(optLabel("United Kingdom", "German")).toBe("Vereinigtes Königreich");
    expect(optLabel("Customer Experience", "Spanish")).toBe("Experiencia del cliente");
  });

  it("returns the canonical English string for English", () => {
    for (const o of TRANSLATED_OPTION_LISTS.OBJ_OPT) expect(optLabel(o, "English")).toBe(o);
  });

  it("falls back to canonical rather than blanking the chip", () => {
    // An unknown language, an unknown option, and a value the client typed into
    // the free-text Add field all have to render as themselves.
    expect(optLabel("Reputation Management", "Klingon")).toBe("Reputation Management");
    expect(optLabel("Some Future Objective", "French")).toBe("Some Future Objective");
    expect(optLabel("Ma propre catégorie", "French")).toBe("Ma propre catégorie");
    expect(optLabel("مجموعة الواحة", "Arabic")).toBe("مجموعة الواحة");
  });

  it("keeps the language names distinct from the market names", () => {
    // "France" the market and "French" the language are separate rows; a
    // collision here would silently mislabel one of the two widgets.
    expect(optLabel("France", "German")).toBe("Frankreich");
    expect(optLabel("French", "German")).toBe("Französisch");
  });
});

describe("translation completeness", () => {
  // The real regression guard: add an option, forget its translations, and this
  // fails instead of quietly showing that one chip in English to every
  // non-English client.
  for (const [listName, list] of Object.entries(TRANSLATED_OPTION_LISTS)) {
    it(`covers every ${listName} option in every supported language`, () => {
      const missing = [];
      for (const option of list) {
        for (const lang of OPT_LANGS) {
          if (optLabel(option, lang) === option && !isLegitimatelyIdentical(option, lang)) {
            missing.push(`${listName}: "${option}" has no ${lang} label`);
          }
        }
      }
      expect(missing).toEqual([]);
    });
  }

  it("leaves the timezone codes alone on purpose", () => {
    // "CET (UTC+1)" is used verbatim in every language; translating it would be
    // wrong, so it must NOT be dragged into the completeness rule above.
    for (const tz of UNTRANSLATED_OPTION_LISTS.TZ_OPT) {
      for (const lang of OPT_LANGS) expect(optLabel(tz, lang)).toBe(tz);
    }
  });
});

// Some labels are genuinely the same word in a given language ("Marketing" in
// French, "Italia" in both Spanish and Italian). Listing them explicitly keeps
// the completeness check honest instead of letting a real gap hide behind a
// blanket "identical is fine" rule.
const IDENTICAL_BY_DESIGN = {
  French:  ["Marketing", "Digital", "Canada", "France", "APAC", "LATAM", "Hindi", "Mandarin", "Italian"],
  German:  ["Marketing", "Digital", "Social Media", "PR", "Japan", "Australia", "Hindi", "Mandarin", "APAC", "LATAM", "Deutsch", "German", "Dutch"],
  Spanish: ["Marketing", "Digital", "Legal", "Italy", "India", "Australia", "Global", "Hindi", "APAC", "LATAM", "Spanish", "Italian"],
  Italian: ["Marketing", "Digital", "Brand", "Canada", "France", "Italy", "India", "Australia", "Hindi", "APAC", "LATAM", "Italian"],
  Arabic:  [],
};
function isLegitimatelyIdentical(option, lang) {
  return (IDENTICAL_BY_DESIGN[lang] || []).includes(option);
}
