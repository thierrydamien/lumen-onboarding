#!/usr/bin/env node
/**
 * Generate the touch/favicon assets from public/lumen-mark.png.
 *
 * WHY a generator rather than hand-made files: the source mark is a TRANSPARENT
 * PNG, and iOS composites transparent apple-touch-icons onto BLACK — the Lumen
 * waveform would land on a black tile on a client's home screen. These outputs
 * bake in the brand background, at the sizes each platform actually asks for.
 *
 * Uses the Chromium already on the image (canvas draw + toDataURL); no native
 * image library is installed here. Re-run only if the source mark changes:
 *   node tools/make-icons.mjs
 */
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";

const SRC = new URL("../public/lumen-mark.png", import.meta.url);
const OUT = (n) => new URL("../public/" + n, import.meta.url);
const b64 = readFileSync(SRC).toString("base64");

// Artwork occupies 62% of the tile, matching the ratio the app itself uses for
// the mark-on-disc lockup (LumenMark: inner = size * 0.6). iOS rounds the
// corners itself, so the background must run full-bleed to the edges.
const JOBS = [
  { name: "apple-touch-icon.png", size: 180, bg: "#ffffff", scale: 0.62 },
  { name: "icon-192.png", size: 192, bg: "#ffffff", scale: 0.62 },
  { name: "icon-512.png", size: 512, bg: "#ffffff", scale: 0.62 },
  // Favicon keeps transparency (browser chrome supplies its own background) and
  // is generated small so the browser isn't downscaling a 498px source to 16px.
  { name: "favicon-32.png", size: 32, bg: null, scale: 0.92 },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setContent("<canvas id=c></canvas>");

for (const j of JOBS) {
  const dataUrl = await page.evaluate(async ({ b64, size, bg, scale }) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const c = document.getElementById("c");
    c.width = size; c.height = size;
    const x = c.getContext("2d");
    x.clearRect(0, 0, size, size);
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, size, size); }
    // Preserve aspect ratio: the source is 498x501, not square.
    const box = size * scale;
    const r = Math.min(box / img.width, box / img.height);
    const w = img.width * r, h = img.height * r;
    x.imageSmoothingQuality = "high";
    x.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return c.toDataURL("image/png");
  }, { b64, size: j.size, bg: j.bg, scale: j.scale });

  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  writeFileSync(OUT(j.name), buf);
  console.log(`  ${j.name.padEnd(22)} ${j.size}x${j.size}  ${(buf.length / 1024).toFixed(1)} KB${j.bg ? "" : "  (transparent)"}`);
}
await browser.close();
