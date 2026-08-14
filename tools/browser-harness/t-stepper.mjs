import { open, start } from "./drive.mjs";

// When the side panel is open the chat column and composer translate 160px, but
// the stepper above them does not. Both are centred blocks, so their centres
// should stay on the same vertical axis.
const { browser, page } = await open({ viewport: { width: 1440, height: 900 } });
await start(page);
await page.waitForTimeout(1000);

const centres = () => page.evaluate(() => {
  const pick = (fn) => { const el = [...document.querySelectorAll("div")].find(fn); return el ? el.getBoundingClientRect() : null; };
  // The scrolling message column and the composer both carry the translate.
  const msg = pick((d) => d.style.overflowY === "auto" && d.style.maxWidth === "760px");
  const composer = document.querySelector("textarea")?.closest("div[style*='max-width: 760px']")
    || document.querySelector("textarea")?.parentElement?.parentElement;
  // The stepper sits in the header block with maxWidth 640.
  const step = pick((d) => d.style.maxWidth === "640px" && d.style.margin === "0px auto");
  const c = (r) => (r ? Math.round(r.left + r.width / 2) : null);
  return { msg: c(msg), composer: c(composer && composer.getBoundingClientRect()), stepper: c(step) };
});

const panelToggle = page.getByRole("button", { name: /hide|show/i }).first();

const openState = await centres();
console.log("panel OPEN  :", JSON.stringify(openState));
if (openState.stepper != null && openState.msg != null)
  console.log("  stepper vs chat centre offset:", Math.abs(openState.stepper - openState.msg) + "px");

if (await panelToggle.count()) {
  await panelToggle.click();
  await page.waitForTimeout(800);
  const closedState = await centres();
  console.log("panel CLOSED:", JSON.stringify(closedState));
  if (closedState.stepper != null && closedState.msg != null)
    console.log("  stepper vs chat centre offset:", Math.abs(closedState.stepper - closedState.msg) + "px");
}

await browser.close();
