import { open, start } from "./drive.mjs";

const { browser, page } = await open();
await start(page);
await page.waitForTimeout(800);

const chip = page.getByRole("button", { name: "France", exact: true });
await chip.waitFor({ state: "visible", timeout: 10000 });
await chip.click();
await page.waitForTimeout(400); // let React settle so the style read is real

const confirm = page.getByRole("button", { name: "Confirm", exact: true });
const look = () => confirm.evaluate((b) => ({
  disabled: b.disabled,
  ariaDisabled: b.getAttribute("aria-disabled"),
  opacity: getComputedStyle(b).opacity,
  cursor: getComputedStyle(b).cursor,
  bg: getComputedStyle(b).backgroundColor,
  pointerEvents: getComputedStyle(b).pointerEvents,
}));

// Did the widget actually submit? That shows up as a user message in the thread.
const submitted = () => page.evaluate(() =>
  /[✓✎]\s*(Updated\s*)?MARKETS/.test(document.body.innerText));

const idle = await look();
console.log("Confirm, idle          :", JSON.stringify(idle));
console.log("submitted yet?         :", await submitted());

await page.evaluate(() => { window.__ctl.chatMode = "hang"; });
await page.locator("textarea").first().fill("meanwhile, some extra context");
await page.keyboard.press("Enter");
await page.waitForTimeout(1500);

const busy = await look();
console.log("Confirm, turn in flight:", JSON.stringify(busy));

await confirm.click({ force: true });
await page.waitForTimeout(1500);
const didSubmit = await submitted();
console.log("clicked during flight -> widget submitted?:", didSubmit);

// Now release the turn and click again; it must work once idle.
await page.evaluate(() => { window.__ctl.chatMode = "ok"; window.__ctl.releaseAll(); });
await page.waitForTimeout(2500);
const stillThere = await confirm.count();
console.log("after release, Confirm still on screen?:", stillThere > 0);
if (stillThere) {
  await confirm.first().click({ force: true });
  await page.waitForTimeout(1800);
}
console.log("after release, submitted? :", await submitted());

console.log("\nVERDICT: the control is", JSON.stringify(idle) === JSON.stringify(busy)
  ? "VISUALLY IDENTICAL while dead — no signal to the client"
  : "visually distinguishable while busy");

await browser.close();
