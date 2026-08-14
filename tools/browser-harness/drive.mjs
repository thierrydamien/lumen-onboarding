import { chromium } from "playwright-core";

// Port is overridable so a test can be pointed at two builds in turn (serve the
// pre-fix bundle on one port, the fixed one on another) and prove it actually
// detects the defect instead of passing vacuously.
const URL_BASE = `http://localhost:${process.env.HARNESS_PORT || 9100}/?s=sd_test`;

export async function open({ viewport = { width: 1280, height: 900 }, lang } = {}) {
  // The image ships Chromium 1194; playwright-core here expects a newer build, so
  // point at the pre-installed binary rather than downloading one.
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
  await page.goto(URL_BASE, { waitUntil: "networkidle" });
  if (lang) {
    // Welcome screen language chips carry the native name.
    const chip = page.getByRole("button", { name: lang, exact: true });
    if (await chip.count()) await chip.first().click();
  }
  return { browser, ctx, page };
}

/** Click the welcome-screen Start button, whatever it is called in this build. */
export async function start(page) {
  const btn = page.locator("button").filter({ hasText: /start|commencer|beginnen|comenzar|inizia|ابدأ/i }).first();
  await btn.waitFor({ state: "visible", timeout: 15000 });
  await btn.click();
  await page.waitForTimeout(1200);
}

export const ctl = (page, fn, arg) => page.evaluate(fn, arg);

if (import.meta.url === `file://${process.argv[1]}`) {
  const { browser, page } = await open();
  console.log("title:", await page.title());
  await start(page);
  const text = await page.locator("body").innerText();
  console.log("--- visible text after Start (first 400 chars) ---");
  console.log(text.slice(0, 400).replace(/\n{2,}/g, "\n"));
  const calls = await page.evaluate(() => window.__ctl.calls.map((c) => c.method + " " + c.url.replace(location.origin, "")));
  console.log("--- stub saw ---");
  console.log(calls.join("\n"));
  await browser.close();
}
