import { open, start } from "./drive.mjs";

// The resume flow, end to end, in a real browser. Historically the most
// bug-dense area of the app — 4 of the original 14 handover bugs lived here
// (unresumable brief destroyed on next visit, failed message swallowed on
// resume, second tab resuming a stale snapshot, post-send blank Start screen) —
// and every prior check of it was a unit test. This drives the real thing:
//
//   phase 1  same device:   converse -> reload -> "Welcome back!" -> Resume ->
//            history intact -> a NEW message still works after resume
//   phase 2  cross device:  wipe localStorage so only the SERVER draft exists ->
//            reload -> Resume must come from the draft endpoint
//
// Phase 2 is the promise the header makes ("reopen on any device") and depends
// on srvSaveDraft/srvLoadDraft/pickDraft — code no browser test had ever run.

const MARKER = "our flagship line is called Aurora Borealis";

const { browser, page } = await open();
await start(page);
await page.waitForTimeout(900);

// Answer the markets widget, then send one distinctive typed message.
await page.getByRole("button", { name: "France", exact: true }).first().click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Confirm", exact: true }).first().click();
await page.waitForTimeout(2500);
await page.locator("textarea").first().fill(MARKER);
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);

const count = () => page.evaluate(() => (document.body.innerText.match(/what markets matter most/gi) || []).length);
const beforeReplies = await count();
console.log("before reload: assistant replies =", beforeReplies, "| typed message on screen =", await page.evaluate((m) => document.body.innerText.includes(m), MARKER));

// Give the debounced autosave time to hit the (stubbed) server, then reload.
await page.waitForTimeout(1500);
const draftOnServer = await page.evaluate(() => !!window.__ctl.draftStore);
console.log("server draft captured before reload:", draftOnServer);

// ---------- phase 1: same-device resume ----------
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1200);
const t1 = await page.evaluate(() => document.body.innerText);
console.log("\nPHASE 1 (same device):");
console.log("  welcome-back shown:", /welcome back/i.test(t1));
const resume = page.getByRole("button", { name: /resume session/i }).first();
console.log("  resume button:", (await resume.count()) > 0);
await resume.click();
await page.waitForTimeout(2000);

const t2 = await page.evaluate(() => document.body.innerText);
console.log("  history restored — typed message present:", t2.includes(MARKER));
console.log("  markets submission survived:", /MARKETS/.test(t2) && /France/.test(t2));

// The real test of a resume: the NEXT send must work, with sane history.
await page.locator("textarea").first().fill("and we sell mostly through independent retailers");
await page.keyboard.press("Enter");
await page.waitForTimeout(3500);
const afterResumeSend = await count();
console.log("  new message after resume got a reply:", afterResumeSend > beforeReplies);
const hist = await page.evaluate(() => {
  const calls = window.__ctl.calls.filter((c) => /functions\/chat/.test(c.url) && c.body && c.body.messages);
  const msgs = calls[calls.length - 1].body.messages;
  const alternates = msgs.every((m, i) => i === 0 || m.role !== msgs[i - 1].role);
  return { len: msgs.length, first: msgs[0].role, alternates };
});
console.log("  resumed send history: len=" + hist.len + " first=" + hist.first + " alternates=" + hist.alternates);

// ---------- phase 2: cross-device resume (server draft only) ----------
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1500);
const t3 = await page.evaluate(() => document.body.innerText);
console.log("\nPHASE 2 (cross device — localStorage wiped, server draft only):");
console.log("  welcome-back shown:", /welcome back/i.test(t3));
const resume2 = page.getByRole("button", { name: /resume session/i }).first();
if (await resume2.count()) {
  await resume2.click();
  await page.waitForTimeout(2000);
  const t4 = await page.evaluate(() => document.body.innerText);
  console.log("  history restored from SERVER:", t4.includes(MARKER));
} else {
  console.log("  RESUME BUTTON MISSING — cross-device resume is broken");
}

await browser.close();
