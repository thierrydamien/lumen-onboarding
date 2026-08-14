import { open, start } from "./drive.mjs";

// The composer sets its inline height from scrollHeight on CHANGE only. Rotate
// the device and the wrap width changes, but the inline height does not — so a
// draft typed in landscape can be clipped once the phone is turned upright.
const LANDSCAPE = { width: 844, height: 390 };
const PORTRAIT = { width: 390, height: 844 };

const DRAFT =
  "We mainly want to track our two product lines and the three competitors I mentioned, " +
  "plus anything about the delivery delays from last quarter, across France and Belgium.";

const { browser, page } = await open({ viewport: LANDSCAPE });
await start(page);
await page.waitForTimeout(800);

const ta = page.locator("textarea").first();
await ta.click();
await ta.fill(DRAFT);
await page.waitForTimeout(400);

const measure = async (label) => {
  const m = await ta.evaluate((el) => ({
    inlineHeight: el.style.height,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    hiddenPx: el.scrollHeight - el.clientHeight,
  }));
  console.log(`[${label}] inline=${m.inlineHeight} client=${m.clientHeight}px content=${m.scrollHeight}px hidden=${m.hiddenPx}px`);
  return m;
};

const before = await measure("landscape, just typed");
await page.setViewportSize(PORTRAIT);
await page.waitForTimeout(700);
const after = await measure("after rotate to portrait");

const linesHidden = after.hiddenPx > 4;
console.log("\ndraft chars:", DRAFT.length);
console.log("content clipped after rotation:", linesHidden, linesHidden ? `(${after.hiddenPx}px of text not visible)` : "");

// And the reverse: portrait -> landscape leaves it oversized.
await ta.fill("");
await ta.fill(DRAFT);
await page.waitForTimeout(400);
const p = await measure("portrait, just typed");
await page.setViewportSize(LANDSCAPE);
await page.waitForTimeout(700);
const l = await measure("after rotate to landscape");
console.log("oversized after rotation:", l.clientHeight - l.scrollHeight > 4 ? `${l.clientHeight - l.scrollHeight}px of empty box` : "no");

await browser.close();
