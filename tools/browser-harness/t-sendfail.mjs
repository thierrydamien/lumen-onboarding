import { open, start } from "./drive.mjs";

// Stage a fully-populated brief in one reply, then send with the backend failing
// and close the modal while it is in flight.
const FULL = [
  '%%PROGRESS%%{"section":"users","percent":95,"collected":{}}%%END%%',
  '%%COMPANY%%{"name":"Acme Corp","email":"jane@acme.com","industry":"Retail","useCase":"Decide Q4 media budget","contact":"Jane Smith","languages":"English","timezone":"GMT / UTC","objectives":"1. Reputation Management","markets":"United Kingdom","teams":"Marketing"}%%END%%',
  '%%TOPICS%%[{"type":"Topic","group":"Own brand","name":"Acme","keywords":"\\"Acme\\"","urls":"https://acme.com","hashtags":"#acme","comments":""}]%%END%%',
  '%%CHANNELS%%[{"author":"Acme","type":"Instagram","url":"https://instagram.com/acme"}]%%END%%',
  '%%REPORTS%%[{"name":"Brand Health","kind":"Report","objective":"Reputation Management","details":"weekly, to the CMO","comments":""}]%%END%%',
  '%%ALERTS%%[{"name":"Crisis spike","details":"negative spike, to comms","comments":""}]%%END%%',
  '%%USERS%%[{"firstName":"Jane","lastName":"Smith","email":"jane@acme.com","role":"CMO","access":"Admin"}]%%END%%',
  "",
  "That's everything captured. Ready when you are.",
  "[OFFER_SEND]",
].join("\n");

const { browser, page } = await open({ viewport: { width: 1440, height: 900 } });
page.on("console", (m) => { const t=m.text(); if (/save|sheet|send|fail|error/i.test(t)) console.log("  [console]", t.slice(0,140)); });
await page.evaluate((r) => { window.__ctl.replies = [r, r]; }, FULL);
await start(page);
await page.waitForTimeout(1500);

// Make every write fail.
await page.evaluate(() => {
  window.__ctl.sessionUpsert = "fail";
  window.__ctl.sheet = "fail";
  window.__ctl.draftSave = "fail";
  window.__ctl.writeDelayMs = 1500;   // keep the send in flight long enough to close the modal
});

// Open the review modal.
const review = page.locator("button").filter({ hasText: /review|send|brief|terminer|finish/i });
const n = await review.count();
console.log("candidate review/send buttons:", n);
for (let i = 0; i < n; i++) console.log("   -", JSON.stringify((await review.nth(i).innerText()).trim()));

if (n) {
  await review.first().click();
  await page.waitForTimeout(1200);
}
const modalOpen = await page.getByRole("dialog").count();
console.log("modal open:", modalOpen > 0);

if (modalOpen) {
  const sendBtn = page.getByRole("dialog").locator("button").filter({ hasText: /send/i }).first();
  console.log("send button found:", await sendBtn.count());
  if (await sendBtn.count()) {
    const closeBtn = page.getByRole("dialog").locator("button").filter({ hasText: "✕" }).first();
    await sendBtn.click();
    await page.waitForTimeout(400);
    console.log("close button disabled while sending?:", await closeBtn.evaluate((b) => b.disabled).catch(() => "n/a"));
    await closeBtn.click({ force: true }).catch(() => {});
    await page.waitForTimeout(12000);
    const after = await page.evaluate(() => ({
      dialog: !!document.querySelector('[role="dialog"]'),
      mentionsFailure: /couldn|send your brief|connection/i.test(document.body.innerText),
      body: document.body.innerText.replace(/\s+/g, " ").slice(0, 200),
      looksSent: /sent|envoy|review your brief|open sheet|what happens next/i.test(document.body.innerText),
      sessionPosts: window.__ctl.calls.filter((c) => c.url.includes("/functions/session")).length,
      sheetPosts: window.__ctl.calls.filter((c) => c.url.includes("/functions/sheet")).length,
    }));
    console.log("after closing mid-send:", JSON.stringify(after, null, 1));
  }
}
await browser.close();
