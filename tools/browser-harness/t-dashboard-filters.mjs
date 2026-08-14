import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

// Renders the real dashboard against stubbed session/seed endpoints and checks
// the filter bar's VISUAL GRAMMAR — the thing source-parsing tests cannot see:
// that the three control kinds actually come out looking different, that Clear
// appears only when it has something to clear, and that the caret survives the
// badge repaint that runs on every table render.

const PORT = process.env.DASH_PORT || 9102;
const SHOT = process.env.SHOT_DIR || "/tmp";

const sessions = [
  { id: "s1", company: "Acme Corp", contactName: "Jane Smith", email: "jane@acme.com", status: "completed",
    percent: 100, lastActiveAt: new Date(Date.now() - 3.6e6).toISOString(), owner: "Alice", lang: "English", pkg: "pro" },
  { id: "s2", company: "Brasserie du Nord", contactName: "Camille Dubois", email: "c@bdn.fr", status: "in_progress",
    percent: 45, lastActiveAt: new Date(Date.now() - 9e7).toISOString(), owner: "Bob", lang: "French", pkg: "starter" },
  { id: "s3", company: "Nordlicht", contactName: "Katrin Hoffmann", email: "k@nl.de", status: "in_progress",
    percent: 20, lastActiveAt: new Date(Date.now() - 2.6e8).toISOString(), owner: "Alice", lang: "German", pkg: "pro" },
];

const browser = await chromium.launch({
  headless: true,
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

// Serve the page itself and fake both data endpoints.
await page.route("**/*", async (route) => {
  const u = route.request().url();
  if (u.includes("/.netlify/functions/session")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions }) });
  }
  if (u.includes("/.netlify/functions/seed")) {
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ seeds: [] }) });
  }
  if (u.includes("dashboard")) {
    return route.fulfill({ status: 200, contentType: "text/html",
      body: readFileSync(new URL("../../public/dashboard.html", import.meta.url), "utf8") });
  }
  return route.fulfill({ status: 200, body: "" });
});
// The page gates on a DASHBOARD_TOKEN kept in storage; seed it so it never prompts.
await ctx.addInitScript(() => {
  try { sessionStorage.setItem("dash_token", "test-token"); } catch {}
});
await page.goto(`http://localhost:${PORT}/dashboard.html`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

const shapes = () => page.evaluate(() => {
  const g = (sel) => { const e = document.querySelector(sel); if (!e) return null;
    const c = getComputedStyle(e); return { radius: c.borderTopLeftRadius, bg: c.backgroundColor, border: c.borderTopWidth }; };
  const clear = document.getElementById("fClear");
  return {
    pill: g(".spill"), more: g(".fmore"), arch: g(".farch"), exp: g(".fexport"),
    clearHidden: !clear || clear.classList.contains("hidden") || clear.offsetParent === null,
    caret: !!document.querySelector(".fcaret"),
    caretText: (document.querySelector(".fcaret") || {}).textContent || "",
    archPressed: (document.getElementById("fArchived") || {}).getAttribute?.("aria-pressed"),
    // Actions must sit to the RIGHT of the last filter value.
    actionsRight: (() => {
      const a = document.querySelector(".factions"), p = [...document.querySelectorAll(".spill")].pop();
      return a && p ? a.getBoundingClientRect().left > p.getBoundingClientRect().right : null;
    })(),
  };
});

let s = await shapes();
console.log("--- shapes differ by job ---");
console.log("  filter value (.spill)  radius:", s.pill?.radius, "  <- fully round");
console.log("  disclosure   (.fmore)  radius:", s.more?.radius, "  <- rounded rect");
console.log("  scope switch (.farch)  radius:", s.arch?.radius, "  <- rounded rect, not a value");
console.log("  value shape != disclosure shape:", s.pill?.radius !== s.more?.radius);
console.log("  action (.fexport) is solid, not white:", s.exp?.bg !== "rgb(255, 255, 255)", s.exp?.bg);
console.log("\n--- affordances ---");
console.log("  caret present on disclosure   :", s.caret, JSON.stringify(s.caretText));
console.log("  actions right of the filters  :", s.actionsRight);
console.log("  Archived reports aria-pressed :", s.archPressed === "false");
console.log("  Clear hidden with no filters  :", s.clearHidden);
const barBox = async () => { const b = await page.locator("#filters").boundingBox(); return { x: Math.max(0,b.x-14), y: Math.max(0,b.y-14), width: Math.min(1400,b.width+28), height: b.height+28 }; };
await page.screenshot({ path: `${SHOT}/dash-filters-clean.png`, clip: await barBox() });

// Set a filter: Clear must appear.
await page.evaluate(() => document.querySelector(".spill")?.click());
await page.waitForTimeout(400);
s = await shapes();
console.log("  Clear appears once filtering  :", !s.clearHidden);
console.log("  caret survived the repaint    :", s.caret, JSON.stringify(s.caretText));

// Open More filters, set one from inside the panel (which calls renderTable only),
// and confirm Clear still reveals itself — the path paintMoreBadge has to cover.
await page.evaluate(() => document.querySelector(".spill")?.click()); // clear status again
await page.waitForTimeout(300);
await page.evaluate(() => document.getElementById("fMore")?.click());
await page.waitForTimeout(300);
await page.evaluate(() => {
  const sel = document.getElementById("fLang");
  if (sel && sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event("change")); }
});
await page.waitForTimeout(400);
const afterPanel = await shapes();
console.log("  Clear revealed by a panel filter:", !afterPanel.clearHidden);
console.log("  badge counted it                :",
  await page.evaluate(() => (document.getElementById("fMoreLabel") || {}).textContent));
await page.screenshot({ path: `${SHOT}/dash-filters-active.png`, clip: await barBox() });

await browser.close();
