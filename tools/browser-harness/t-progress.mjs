import { open, start } from "./drive.mjs";

// iPhone-sized viewport, walking the same percent sequence a real conversation
// produces, to see what the client actually reads off the screen.
const SEQ = [5, 8, 12, 15, 18, 22];
const reply = (p) =>
  `%%PROGRESS%%{"section":"company","percent":${p},"collected":{}}%%END%%\n\nGot it — and your email address?`;

const { browser, page } = await open({ viewport: { width: 390, height: 844 } });
await page.evaluate((rs) => { window.__ctl.replies = rs; }, [reply(0), ...SEQ.map(reply)]);
await start(page);
await page.waitForTimeout(900);

const read = async () => {
  const t = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const step = (t.match(/Step \d+ of \d+[^·]*·?\s*[A-Za-z ]*/) || [""])[0].trim().slice(0, 28);
  const pct = (t.match(/(\d+)%/) || [null, "?"])[1];
  return { step, pct };
};

console.log("what a client on an iPhone sees, turn by turn:");
let r = await read();
console.log(`  opener        ${String(r.pct + "%").padEnd(5)}  ${r.step}`);
for (let i = 0; i < SEQ.length; i++) {
  await page.locator("textarea").first().fill("ok");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3000);
  r = await read();
  console.log(`  message ${i + 1}     ${String(r.pct + "%").padEnd(5)}  ${r.step}`);
}
await browser.close();
