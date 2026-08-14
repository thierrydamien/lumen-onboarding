import { open, start } from "./drive.mjs";

// Three defects that only a rendered browser in a specific STATE reveals:
//   1. Dark mode painted the stepper's done/current labels in near-black navy on
//      the dark canvas — the client could not read which step they were on.
//   2. Every assistant turn carrying [OFFER_SEND] rendered its own button
//      forever, so a client who signalled twice got a stack of identical CTAs.
//   3. At 375px the "Answer above…" placeholder wrapped and clipped mid-word.

const SHOT = process.env.SHOT_DIR || "/tmp";
const OFFER = (n) =>
  `%%PROGRESS%%{"section":"intro","percent":${10 + n},"collected":{}}%%END%%\n\n` +
  `No problem — we can pick this up later, nothing is lost. [OFFER_SEND]`;

// Contrast of text vs the surface behind it. Not a full WCAG ratio — just enough
// to catch "same colour as the background", which is the actual bug.
const contrast = (page, sel) => page.evaluate((s) => {
  const lum = (c) => {
    const [r, g, b] = c.match(/\d+/g).map(Number).map((v) => {
      const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const el = [...document.querySelectorAll("div")].find((d) => d.textContent.trim() === s && d.children.length === 0);
  if (!el) return null;
  let bgEl = el, bg = "";
  while (bgEl && (!bg || bg === "rgba(0, 0, 0, 0)")) { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement; }
  const a = lum(getComputedStyle(el).color), b = lum(bg);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
}, sel);

console.log("--- 1. dark-mode stepper labels ---");
{
  const { browser, page } = await open();
  await start(page);
  await page.waitForTimeout(900);
  const light = await contrast(page, "About you");
  await page.evaluate(() => [...document.querySelectorAll("button")]
    .find((b) => /dark mode/i.test(b.getAttribute("aria-label") || ""))?.click());
  await page.waitForTimeout(500);
  const darkC = await contrast(page, "About you");
  console.log(`  current-step label contrast  light ${light} / dark ${darkC}`);
  console.log("  readable in dark mode        :", darkC !== null && darkC >= 4.5);
  // A non-current label was always fine; check we didn't regress it.
  console.log("  pending label still readable :", (await contrast(page, "Reports")) >= 4.5);
  await page.screenshot({ path: `${SHOT}/dark-stepper.png`, clip: { x: 280, y: 60, width: 720, height: 60 } });
  await browser.close();
}

console.log("\n--- 2. repeated early-send offers ---");
{
  const { browser, page } = await open();
  await start(page);
  await page.waitForTimeout(900);
  const countBtns = () => page.evaluate(() =>
    [...document.querySelectorAll("button")].filter((b) => /review and send/i.test(b.textContent)).length);

  await page.evaluate((r) => window.__ctl.replies.push(r), OFFER(1));
  await page.locator("textarea").first().fill("actually I have to go");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3200);
  console.log("  one offer  -> buttons:", await countBtns(), "(expect 1)");

  await page.evaluate((r) => window.__ctl.replies.push(r), OFFER(2));
  await page.locator("textarea").first().fill("can I talk to a human");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3200);
  const n = await countBtns();
  console.log("  two offers -> buttons:", n, "(expect 1)");
  console.log("  no duplicate CTAs            :", n === 1);
  // The surviving one must be the LATEST, not the stale first offer.
  const onLast = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => /review and send/i.test(b.textContent));
    const bubbles = [...document.querySelectorAll("div")].filter((d) => /nothing is lost/i.test(d.textContent) && d.children.length === 0);
    return btn && bubbles.length ? btn.compareDocumentPosition(bubbles[bubbles.length - 1]) === Node.DOCUMENT_POSITION_PRECEDING : null;
  });
  console.log("  it is the most recent offer  :", onLast === true);
  await browser.close();
}

console.log("\n--- 3. mobile composer placeholder ---");
for (const [w, label] of [[375, "mobile"], [1280, "desktop"]]) {
  const { browser, page } = await open({ viewport: { width: w, height: 740 } });
  await start(page);
  await page.waitForTimeout(1100);
  const r = await page.evaluate(() => {
    const ta = document.querySelector("textarea");
    // scrollHeight > clientHeight means the placeholder wrapped past the visible row.
    return { ph: ta.placeholder, clipped: ta.scrollHeight > ta.clientHeight + 1 };
  });
  console.log(`  ${label.padEnd(8)} placeholder: "${r.ph}"`);
  console.log(`  ${label.padEnd(8)} clipped    : ${r.clipped}`);
  await browser.close();
}
