import { open, start } from "./drive.mjs";
import fs from "node:fs";

// End-to-end: a complete brief, through the review modal, to the downloaded
// .xlsx the consultant actually receives. Everything is stubbed, so no network,
// no cost, nothing written to production.
const FULL = [
  '%%PROGRESS%%{"section":"users","percent":100,"collected":{}}%%END%%',
  '%%COMPANY%%{"name":"Nordlicht Brauerei","email":"k.hoffmann@nordlicht.de","industry":"Craft Beer","useCase":"Did the festival sponsorship pay off","contact":"Katrin Hoffmann","languages":"German","timezone":"CET (UTC+1)","objectives":"1. Reputation Management, 2. Campaign Optimization","markets":"Germany, Austria","teams":"Marketing"}%%END%%',
  '%%TOPICS%%[{"type":"Topic","group":"Own brand","name":"Nordlicht","keywords":"\\"Nordlicht Brauerei\\" NOT Nordlichter","urls":"https://nordlicht.de","hashtags":"#nordlicht","comments":"main brand"}]%%END%%',
  '%%CHANNELS%%[{"author":"Nordlicht","type":"Instagram","url":"https://instagram.com/nordlicht"}]%%END%%',
  '%%REPORTS%%[{"name":"Brand Health","kind":"Report","objective":"Reputation Management","details":"weekly, to the CMO","comments":""}]%%END%%',
  '%%ALERTS%%[{"name":"Crisis spike","details":"negative spike, to comms","comments":""}]%%END%%',
  '%%USERS%%[{"firstName":"Katrin","lastName":"Hoffmann","email":"k.hoffmann@nordlicht.de","role":"CMO","access":"Admin"}]%%END%%',
  '%%HANDOFF%%{"consultantTips":"Client dodged the email twice early on","followUps":["confirm budget owner"]}%%END%%',
  "",
  "That's everything. Ready when you are.",
  "[OFFER_SEND]",
].join("\n");

const { browser, page } = await open({ viewport: { width: 1440, height: 900 }, lang: "Deutsch" });
await page.evaluate((r) => { window.__ctl.replies = [r, r]; }, FULL);
await start(page);
await page.waitForTimeout(1500);

const btns = await page.evaluate(() => [...document.querySelectorAll("button")].map(b => b.textContent.trim()).filter(Boolean));
console.log("buttons on screen:", JSON.stringify(btns));
const opener = page.locator("button").filter({ hasText: /review|send|brief|senden|pr\u00fcfen/i }).first();
await opener.click();
await page.waitForTimeout(1200);

const dialog = page.getByRole("dialog");
const readiness = await dialog.innerText();
console.log("readiness line:", (readiness.match(/\d+%[^\n]*/) || ["?"])[0]);
console.log("says ready to send:", /ready to send/i.test(readiness));

// The consultant's artifact.
const dl = page.waitForEvent("download", { timeout: 20000 });
await dialog.locator("button").filter({ hasText: /download/i }).first().click();
const file = await dl;
const out = "/tmp/brief.xlsx";
await file.saveAs("/tmp/brief-de.xlsx");
const bytes = fs.statSync(out).size;
console.log("\ndownloaded:", file.suggestedFilename(), "|", bytes, "bytes");

await browser.close();
