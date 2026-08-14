import { open, start } from "./drive.mjs";
import { docx, asFile } from "/home/user/lumen-onboarding-v2/tests/fixtures/make-files.mjs";
import * as XLSX from "/home/user/lumen-onboarding-v2/node_modules/xlsx/xlsx.mjs";
import fs from "node:fs";

// Write real files to disk so Playwright hands the browser genuine File objects,
// exactly as a client's file picker would.
const dir = "/tmp/uploads"; fs.mkdirSync(dir, { recursive: true });
const write = (n, b) => { const p = dir + "/" + n; fs.writeFileSync(p, Buffer.from(b)); return p; };

const wbBytes = (aoa) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Queries");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
};

const FILES = {
  docx: write("requirements.docx", docx([
    "Markets: Germany, Austria", "Competitors: Acme Brewing, Globex Beverages", "Languages: German, English",
  ])),
  xlsx: write("queries.xlsx", wbBytes([["Query", "Owner"], ['"Nordlicht" AND beer', "Katrin"], ['brand NOT Nordlichter', "Katrin"]])),
  txt: write("notes.txt", "We care about brand mentions and competitor launches."),
  pdfAsXlsx: write("fake.xlsx", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])), // %PDF- renamed
  html: write("page.html", "<html><body>not a document</body></html>"),
};

const OPENER = '%%PROGRESS%%{"section":"intro","percent":10,"collected":{}}%%END%%\n\nDo you have anything written down already?\n\n[SUGGESTIONS: No, from scratch | @ATTACH]';

async function attach(page, path, label) {
  // The composer paperclip: a hidden file input next to the message box.
  const inputs = page.locator('input[type=file]');
  const n = await inputs.count();
  await inputs.nth(n - 1).setInputFiles(path);
  await page.waitForTimeout(2500);
  const state = await page.evaluate(() => ({
    body: document.body.innerText.replace(/\s+/g, " "),
    // what actually got queued to send to the model
    composer: (document.querySelector("textarea") || {}).value || "",
  }));
  const sends = await page.evaluate(() => window.__ctl.calls.filter(c => /functions\/chat/.test(c.url) && c.body && c.body.messages).length);
  const attached = /attached a supporting document/.test(await page.evaluate(() => {
    const c = window.__ctl.calls.filter(c => /functions\/chat/.test(c.url) && c.body && c.body.messages);
    return c.length ? JSON.stringify(c[c.length-1].body.messages.slice(-1)) : "";
  }));
  console.log(`  ${label.padEnd(22)} sendsSoFar=${String(sends).padEnd(3)} lastSendIsAnAttachment=${attached}`);
  console.log(`      visible: ${state.body.slice(-170)}`);
  return { state, sends };
}

const { browser, page } = await open();
await page.evaluate((r) => { window.__ctl.replies = [r, r, r, r, r, r]; }, OPENER);
await start(page);
await page.waitForTimeout(1000);

console.log("COMPOSER ATTACH (client mid-conversation):");
const okDocx = await attach(page, FILES.docx, "real .docx");
const okXlsx = await attach(page, FILES.xlsx, "real .xlsx");
const okTxt  = await attach(page, FILES.txt,  "real .txt");
const badPdf = await attach(page, FILES.pdfAsXlsx, "PDF renamed .xlsx");
const badHtm = await attach(page, FILES.html, ".html");

console.log("\nDid the .docx content actually reach the send payload?");
const sent = await page.evaluate(() => {
  const c = window.__ctl.calls.filter(c => /functions\/chat/.test(c.url) && c.body && c.body.messages);
  const last = c[c.length - 1];
  return last ? JSON.stringify(last.body.messages[last.body.messages.length - 1]).slice(0, 400) : "(none)";
});
console.log("  last user message sent:", sent.slice(0, 320));

console.log("\nTab still alive after 5 uploads:", await page.evaluate(() => !!document.querySelector("textarea")));
await browser.close();
