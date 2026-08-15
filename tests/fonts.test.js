// Inter is served from this site, not Google's font CDN.
//
// Every client's browser used to make two extra calls to Google (a stylesheet
// then the font file) before the client-facing chat could paint, which handed
// Google their IP address. The one thing that used to justify that — a shared
// cross-site font cache — stopped existing when browsers partitioned their HTTP
// cache in 2020, so it bought nothing in return.
//
// Verified in Chromium with request listeners attached BEFORE navigation:
// zero external hosts contacted, only inter-latin.woff2 fetched on a normal
// page, and inter-latin-ext.woff2 pulled only when the page actually renders
// Polish/Turkish characters.

import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";

const P = (p) => new URL("../" + p, import.meta.url);
const read = (p) => readFileSync(P(p), "utf8");
const PAGES = ["public/chat.html", "public/sales.html", "public/dashboard.html"];

describe("no third-party font requests", () => {
  it("no shipped page references Google's font hosts", () => {
    for (const p of [...PAGES, "src/lumen.jsx"]) {
      const s = read(p);
      expect(s, `${p} still hits Google Fonts`).not.toMatch(/googleapis\.com|gstatic\.com/);
    }
  });

  it("every page declares the font locally instead", () => {
    for (const p of PAGES) {
      expect(read(p), p).toMatch(/@font-face/);
      expect(read(p), p).toMatch(/url\('\/fonts\/inter-latin\.woff2'\)/);
    }
  });
});

describe("the font files themselves", () => {
  it("ships both subsets as real woff2", () => {
    for (const f of ["inter-latin.woff2", "inter-latin-ext.woff2"]) {
      const b = readFileSync(P("public/fonts/" + f));
      expect(b.subarray(0, 4).toString("latin1"), f).toBe("wOF2");
    }
  });

  it("keeps the common subset small — it is on the client's critical path", () => {
    // latin is what a typical client downloads; latin-ext is fetched on demand.
    expect(statSync(P("public/fonts/inter-latin.woff2")).size).toBeLessThan(60 * 1024);
  });

  it("ships the SIL OFL licence, which the font's licence requires", () => {
    const ofl = read("public/fonts/OFL.txt");
    expect(ofl).toMatch(/SIL Open Font License/i);
    expect(ofl).toMatch(/Inter/);
  });

  it("is reproducible from a committed script rather than being a mystery binary", () => {
    const sh = read("tools/get-fonts.sh");
    expect(sh).toMatch(/inter-\$sub\.woff2/);
    expect(sh).toMatch(/OFL\.txt/);
  });
});

describe("the @font-face declarations", () => {
  it("covers the whole weight axis in one declaration per subset", () => {
    // These are VARIABLE fonts: one file serves 400/600/700/800, so the wordmark's
    // 800 costs nothing. Confirmed in Chromium by measuring that all four weights
    // render at distinct widths (578.88 / 590.64 / 596.56 / 603.73 px).
    const s = read("public/chat.html");
    expect((s.match(/font-weight: 100 900/g) || []).length).toBe(2);
  });

  it("keeps the unicode-range split so latin-ext is fetched only when needed", () => {
    const s = read("public/chat.html");
    expect(s).toMatch(/unicode-range: U\+0000-00FF/);      // latin
    expect(s).toMatch(/unicode-range: U\+0100-02BA/);      // latin-ext
    // Accents for all five Latin-script languages live in the latin subset, so a
    // French or German client never needs the second file.
    expect(s).toMatch(/U\+0152-0153/); // French oe ligature
  });

  it("uses font-display:swap so text is never invisible while loading", () => {
    for (const p of PAGES) {
      expect((read(p).match(/font-display: swap/g) || []).length, p).toBe(2);
    }
  });

  it("preloads the common subset on the client-facing page only", () => {
    // The chat is the page a client waits on; the two internal tools are not
    // worth the extra early request.
    expect(read("public/chat.html")).toMatch(
      /<link rel="preload" href="\/fonts\/inter-latin\.woff2" as="font" type="font\/woff2" crossorigin\/>/);
    for (const p of ["public/sales.html", "public/dashboard.html"]) {
      expect(read(p), p).not.toMatch(/rel="preload"[^>]*woff2/);
    }
  });

  it("declares the same font on all three pages, so they cannot drift apart", () => {
    const face = (s) => (s.match(/@font-face\s*{[\s\S]*?}/g) || []).join("").replace(/\s+/g, " ");
    const [a, b, c] = PAGES.map((p) => face(read(p)));
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
