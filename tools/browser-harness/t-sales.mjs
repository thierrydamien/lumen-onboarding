import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

// The Sales page: the two paths a rep actually takes, plus the internal-notes
// field that the whole seed pipeline is built around.
//
// 1. Generate must never be a dead control. It carries good click-time
//    validation (marks the field, writes a specific message, scrolls to it) —
//    but a DISABLED button never fires a click, so on the primary path a rep
//    with a missing field just clicks a pale button and gets nothing at all.
// 2. Consultant notes are stored by seed.js (token-gated), injected into the
//    system prompt by chat.js, and rendered by the dashboard as "Consultant
//    notes (from Sales)" — but the Sales form never had a field to enter them,
//    so every seed carried none and the whole path was dead.

const SHOT = process.env.SHOT_DIR || "/tmp";
let seedBody = null;

const browser = await chromium.launch({
  headless: true, executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1200 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));
await page.route("**/*", (route) => {
  const u = route.request().url();
  if (u.includes("functions/seed")) {
    try { seedBody = JSON.parse(route.request().postData() || "{}"); } catch { seedBody = null; }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "sd_demo123", expiresDays: 90 }) });
  }
  if (u.includes("sales")) return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(new URL("../../public/sales.html", import.meta.url), "utf8") });
  return route.fulfill({ status: 200, body: "" });
});
const load = async () => { await page.goto("http://localhost:9102/sales.html", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(500); };

console.log("--- 1. Generate with a required field missing ---");
await load();
// Exactly what a rushed rep does: example data (which deliberately leaves
// "Prepared by" empty), then straight to Generate.
await page.evaluate(() => document.getElementById("example").click());
await page.waitForTimeout(300);
const before = await page.evaluate(() => {
  const b = document.getElementById("gen");
  return { disabled: b.disabled, prepared: document.getElementById("preparedBy").value };
});
console.log("  'Prepared by' left empty by the example :", before.prepared === "");
console.log("  Generate is clickable                   :", !before.disabled);
await page.locator("#gen").click({ force: true });
await page.waitForTimeout(400);
const after = await page.evaluate(() => ({
  marked: document.getElementById("preparedBy").classList.contains("invalid"),
  msg: (document.getElementById("err_preparedBy").textContent || "").trim(),
  focused: document.activeElement && document.activeElement.id,
  linkShown: document.getElementById("out").classList.contains("show"),
}));
console.log("  field marked invalid                    :", after.marked);
console.log("  told why                                :", JSON.stringify(after.msg));
console.log("  focus moved to the offending field      :", after.focused === "preparedBy");
console.log("  no link generated                       :", !after.linkShown);
await page.screenshot({ path: `${SHOT}/sales-validation.png`, clip: { x: 320, y: 620, width: 640, height: 340 } });

console.log("\n--- 2. internal notes reach the seed, and only the seed ---");
await load();
await page.evaluate(() => document.getElementById("example").click());
await page.waitForTimeout(200);
const NOTES = "Budget holder is the CFO, not Steve. Lost a deal to Brandwatch last year — do not mention it.";
await page.evaluate((n) => {
  document.getElementById("preparedBy").value = "Alex Rep";
  document.getElementById("preparedBy").dispatchEvent(new Event("input"));
  const el = document.getElementById("notes");
  if (el) { el.value = n; el.dispatchEvent(new Event("input")); }
}, NOTES);
await page.waitForTimeout(200);
console.log("  a notes field exists on the form        :", await page.evaluate(() => !!document.getElementById("notes")));
console.log("  it sits in the INTERNAL section         :", await page.evaluate(() => {
  const el = document.getElementById("notes"); if (!el) return false;
  const secs = [...document.querySelectorAll(".sec")];
  const internal = secs.find((s) => /internal/i.test(s.textContent));
  return !!internal && internal.compareDocumentPosition(el) === Node.DOCUMENT_POSITION_FOLLOWING;
}));
await page.locator("#gen").click({ force: true });
await page.waitForTimeout(900);
console.log("  notes sent in the seed payload          :", seedBody && seedBody.seed && seedBody.seed.notes === NOTES);
console.log("  brief stayed separate from notes        :", seedBody && seedBody.seed && seedBody.seed.brief !== NOTES && !!seedBody.seed.brief);
const link = await page.evaluate(() => (document.getElementById("link") || {}).value || "");
console.log("  link carries only an opaque id          :", /sd_demo123/.test(link) && !/CFO|Brandwatch/.test(link));
console.log("  link:", link);
await page.screenshot({ path: `${SHOT}/sales-notes.png`, fullPage: true });

console.log("\n--- 3. the happy path still works ---");
console.log("  link shown                              :", await page.evaluate(() => document.getElementById("out").classList.contains("show")));
console.log("  Generate re-enabled after the run       :", await page.evaluate(() => !document.getElementById("gen").disabled));

await browser.close();
