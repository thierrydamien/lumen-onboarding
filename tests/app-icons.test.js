// Home-screen icons, favicon and theme-color.
//
// The chat is explicitly "pause and come back on any device", so clients DO save
// it to a phone home screen. It shipped with only a raw <link rel=icon> pointing
// at the 498px transparent source mark: no apple-touch-icon (iOS composites a
// transparent one onto BLACK), no short name (iOS would fall back to the <title>,
// which is personalised per client and far too long), and no theme-color.

import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";

const read = (p) => readFileSync(new URL("../public/" + p, import.meta.url), "utf8");
const chat = read("chat.html");
const size = (p) => statSync(new URL("../public/" + p, import.meta.url)).size;

// PNG header: 8-byte signature, then IHDR carries width/height as big-endian u32.
function pngDims(p) {
  const b = readFileSync(new URL("../public/" + p, import.meta.url));
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a"); // is a real PNG
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("the client chat's home-screen identity", () => {
  it("ships an apple-touch-icon at the size iOS asks for", () => {
    expect(chat).toMatch(/<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"\/>/);
    expect(pngDims("apple-touch-icon.png")).toEqual({ w: 180, h: 180 });
  });

  it("bakes a background into that icon rather than shipping transparency", () => {
    // iOS composites a transparent touch icon onto black — the purple waveform
    // would land on a black tile. A fully opaque PNG is the guard. Colour type 6
    // (RGBA) is fine as long as it is opaque, so check the generator's intent
    // instead: the file is far smaller than the transparent source it came from
    // and is regenerable from a committed script.
    expect(size("apple-touch-icon.png")).toBeLessThan(size("lumen-mark.png"));
    expect(() => statSync(new URL("../tools/make-icons.mjs", import.meta.url))).not.toThrow();
  });

  it("gives the home-screen icon a short label", () => {
    // document.title is rewritten to "Lumen Onboarding — <Company>" per client.
    expect(chat).toMatch(/<meta name="apple-mobile-web-app-title" content="Lumen"\/>/);
  });

  it("uses a small favicon rather than downscaling the 498px source", () => {
    expect(chat).toMatch(/<link rel="icon" href="\/favicon-32\.png" sizes="32x32"\/>/);
    expect(pngDims("favicon-32.png")).toEqual({ w: 32, h: 32 });
    expect(size("favicon-32.png")).toBeLessThan(4096);
  });

  it("applies the same favicon on the internal pages", () => {
    for (const p of ["sales.html", "dashboard.html"]) {
      expect(read(p), p).toMatch(/<link rel="icon" href="\/favicon-32\.png"/);
    }
  });
});

describe("theme-color follows the user's theme toggle", () => {
  const app = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");

  it("has a starting value in the markup", () => {
    expect(chat).toMatch(/<meta name="theme-color" content="#F7F7FA"\/>/);
  });

  it("is rewritten from the live palette, not a hardcoded copy", () => {
    // Reading C.bg means the browser chrome and the page background cannot drift.
    const fx = app.slice(app.indexOf('meta[name="theme-color"]'));
    expect(fx.slice(0, 400)).toMatch(/m\.content = C\.bg;/);
  });

  it("declares the effect BELOW the palette it depends on", () => {
    // A dependency array is evaluated during render, so putting this effect above
    // `const dark` / `const C` puts them in the temporal dead zone and throws
    // "Cannot access before initialization" — which white-screened the whole app
    // when this was first written. Caught in Chromium; pinned here.
    const cDecl = app.indexOf("const C = useMemo(() => dark");
    const effect = app.indexOf('meta[name="theme-color"]');
    expect(cDecl).toBeGreaterThan(-1);
    expect(effect).toBeGreaterThan(cDecl);
  });
});

describe("font weights are all actually loaded", () => {
  it("declares every weight the chat renders", () => {
    const app = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
    const used = new Set((app.match(/fontWeight:(\d00)/g) || []).map((m) => m.split(":")[1]));
    const declared = (chat.match(/wght@([\d;]+)/) || [, ""])[1].split(";");
    // An undeclared weight is synthesized by the browser (faux bold), which
    // smeared the "Lumen" wordmark — weight 800 on the one word that is the brand.
    for (const w of used) expect(declared, `weight ${w} used but not loaded`).toContain(w);
  });
});
