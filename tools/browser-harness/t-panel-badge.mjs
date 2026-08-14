import { open, start } from "./drive.mjs";

// The captured-answers panel toggle used to be a hamburger with no state — a
// settings-lookalike nobody tapped, so below 1280px (panel closed by default)
// clients never found the panel, its Fix buttons, or the "Still to capture"
// list. Now the toggle carries a live count badge while the panel is closed.
// This drives the real UI and checks: badge absent when open, present with the
// right count when closed, growing as answers land, gone again when reopened.

const SHOT = process.env.SHOT_DIR || "/tmp";

const badgeState = (page) => page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => {
    const l = b.getAttribute("aria-label") || "";
    return /captured so far|hide/i.test(l) && b.hasAttribute("aria-pressed");
  });
  if (!btn) return { found: false };
  const badge = [...btn.querySelectorAll("span")].find((s) => /^\d+$/.test(s.textContent.trim()));
  return { found: true, pressed: btn.getAttribute("aria-pressed"), label: btn.getAttribute("aria-label"),
           badge: badge ? Number(badge.textContent) : null };
});

const capturedRows = (page) => page.evaluate(() => {
  // Green tick circles render one per captured row in the open panel.
  return [...document.querySelectorAll("svg circle[fill='#16a34a']")].length;
});

const { browser, page } = await open(); // 1280px -> panel open by default
await start(page);
await page.waitForTimeout(900);

let s = await badgeState(page);
console.log("panel open by default at 1280px :", s.pressed === "true");
console.log("no badge while the panel is open:", s.badge === null);

// Close it — the state every client below 1280px starts in.
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.hasAttribute("aria-pressed"))?.click();
});
await page.waitForTimeout(400);
s = await badgeState(page);
console.log("badge appears once closed        :", s.badge !== null, s.badge !== null ? `(count ${s.badge})` : "");
console.log("count folded into aria-label     :", s.badge !== null && (s.label || "").includes(`(${s.badge})`));
const before = s.badge;
await page.screenshot({ path: `${SHOT}/badge-closed.png`, clip: { x: 780, y: 0, width: 500, height: 110 } });

// A turn that captures more data must grow the badge without opening the panel.
// The stub's DEFAULT reply carries no data markers (collected:{}), so queue a
// reply that captures one new company field — the badge must track it live.
await page.evaluate(() => {
  window.__ctl.replies.push(
    '%%PROGRESS%%{"section":"intro","percent":15,"collected":{}}%%END%%\n' +
    '%%COMPANY%%{"useCase":"Measure festival sponsorship impact"}%%END%%\n\n' +
    "Great — a craft brewery in Lyon, and you want to measure the festival sponsorship. What markets matter most to you?\n\n[WIDGET:MARKETS]");
});
await page.locator("textarea").first().fill("We are Acme Brewing, a craft brewery in Lyon");
await page.keyboard.press("Enter");
await page.waitForTimeout(3500);
s = await badgeState(page);
console.log("badge grew after an answer landed:", s.badge > before, `(${before} -> ${s.badge})`);

// Reopen: badge gone, and the panel's captured rows must MATCH the count the
// badge was showing — otherwise the badge is advertising something else.
const shown = s.badge;
await page.evaluate(() => {
  [...document.querySelectorAll("button")].find((b) => b.hasAttribute("aria-pressed"))?.click();
});
await page.waitForTimeout(400);
s = await badgeState(page);
const rows = await capturedRows(page);
console.log("reopens on click, badge removed  :", s.pressed === "true" && s.badge === null);
console.log("badge count matched panel rows   :", rows === shown, `(badge ${shown}, rows ${rows})`);
await page.screenshot({ path: `${SHOT}/badge-open.png` });

await browser.close();
