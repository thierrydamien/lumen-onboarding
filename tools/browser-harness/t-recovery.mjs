import { open, start } from "./drive.mjs";

// A network blip mid-conversation: the backend fails outright, the client is
// eventually told, their typed message is NOT lost, and Try again resumes the
// conversation once the backend recovers. This is the documented ~26-45s
// worst-case path (silent retry -> background fallback -> 6 backoff attempts),
// so this test is deliberately slow. Handover bugs #3/#5/#6 all lived here.

const MSG = "we also want to track our seasonal winter campaign";

const { browser, page } = await open();
await start(page);
await page.waitForTimeout(900);

// Kill the ENTIRE backend (sync and background), then send.
await page.evaluate(() => { window.__ctl.chatMode = "http500"; });
await page.locator("textarea").first().fill(MSG);
await page.keyboard.press("Enter");
console.log("sent while backend fully down; waiting for the failure to surface (worst case ~45s)...");

// Poll for a retry affordance for up to 100s.
let surfaced = null;
const t0 = Date.now();
while (Date.now() - t0 < 100000) {
  const found = await page.evaluate(() =>
    [...document.querySelectorAll("button")].some((b) => /try again/i.test(b.textContent)));
  if (found) { surfaced = Math.round((Date.now() - t0) / 1000); break; }
  await page.waitForTimeout(1000);
}
console.log("failure surfaced with a Try again button:", surfaced !== null, surfaced !== null ? `(after ${surfaced}s)` : "");
console.log("typed message still visible in transcript:", await page.evaluate((m) => document.body.innerText.includes(m), MSG));

// Backend recovers; the client clicks Try again.
await page.evaluate(() => { window.__ctl.chatMode = "ok"; });
const tryAgain = page.locator("button").filter({ hasText: /try again/i }).first();
if (await tryAgain.count()) {
  await tryAgain.click();
  await page.waitForTimeout(4000);
  const ok = await page.evaluate((m) => {
    const t = document.body.innerText;
    return { replied: (t.match(/what markets matter most/gi) || []).length >= 2, msgKept: t.includes(m) };
  }, MSG);
  console.log("after Try again: reply arrived:", ok.replied, "| message preserved:", ok.msgKept);
  // The recovered send must carry the message to the model exactly once.
  const dupes = await page.evaluate((m) => {
    const calls = window.__ctl.calls.filter((c) => /functions\/chat/.test(c.url) && c.body && c.body.messages);
    const last = calls[calls.length - 1].body.messages;
    return last.filter((x) => x.role === "user" && x.content.includes(m)).length;
  }, MSG);
  console.log("message appears in model history exactly once:", dupes === 1);
}
await browser.close();
