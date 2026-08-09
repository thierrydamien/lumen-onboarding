// Non-English behaviour. All manual testing to date has been in English, so these
// cover the two things English sessions structurally cannot exercise.

import { describe, it, expect } from "vitest";
import { docLangDir, isAttachToken } from "../src/lumen.jsx";

describe("docLangDir", () => {
  it("declares the real conversation language, not 'en'", () => {
    // Leaving lang="en" makes a screen reader pronounce French with an English voice
    // (WCAG 2.2 SC 3.1.1) and makes browsers offer to translate a page already in the
    // reader's language.
    expect(docLangDir("French").lang).toBe("fr-FR");
    expect(docLangDir("German").lang).toBe("de-DE");
    expect(docLangDir("Spanish").lang).toBe("es-ES");
    expect(docLangDir("Italian").lang).toBe("it-IT");
    expect(docLangDir("English").lang).toBe("en-GB");
  });

  it("puts Arabic in right-to-left", () => {
    // This is what activates the [dir=rtl] Arabic font stack and flips every
    // marginInline*/paddingInline* logical property the layout already uses.
    expect(docLangDir("Arabic")).toEqual({ lang: "ar", dir: "rtl" });
  });

  it("keeps every left-to-right language left-to-right", () => {
    for (const l of ["English", "French", "German", "Spanish", "Italian"]) {
      expect(docLangDir(l).dir).toBe("ltr");
    }
  });

  it("falls back safely for an unknown language", () => {
    expect(docLangDir("Klingon")).toEqual({ lang: "en", dir: "ltr" });
    expect(docLangDir(undefined)).toEqual({ lang: "en", dir: "ltr" });
  });
});

describe("isAttachToken", () => {
  it("matches the documented English token", () => {
    expect(isAttachToken("@ATTACH")).toBe(true);
    expect(isAttachToken("  @ATTACH  ")).toBe(true);
    expect(isAttachToken("@attach")).toBe(true);
  });

  it("still matches when the model translates the token", () => {
    // The prompt says never translate it, but that is model obedience, not a
    // guarantee, and it can only go wrong in a language nobody tests in.
    for (const t of ["@JOINDRE", "@ANHÄNGEN", "@ADJUNTAR", "@ALLEGARE", "@إرفاق"]) {
      expect(isAttachToken(t)).toBe(true);
    }
  });

  it("does not hijack a normal answer chip", () => {
    for (const t of [
      "Watching competitors",
      "No, let's build from scratch",
      "@mentions and hashtags", // multi-word: a real answer, not an action token
      "",
      null,
      undefined,
    ]) {
      expect(isAttachToken(t)).toBe(false);
    }
  });
});
