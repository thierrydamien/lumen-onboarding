import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

// The failure/edge paths the client-side audit flagged. Each reproduces a bug
// that was live and drives the fix.

const CFG = JSON.stringify({ googleAuth: true, clientId: "x.apps.googleusercontent.com", domain: "hootsuite.com" });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const validTok = "h." + b64({ email: "rep@hootsuite.com", hd: "hootsuite.com", exp: Math.floor(Date.now() / 1000) + 3000 }) + ".s";

// Fake GIS that renders a REAL button node so we can prove the card is actionable.
const GIS = 'window.google={accounts:{id:{'
  + 'initialize:function(o){window.__cb=o.callback;},'
  + 'renderButton:function(el){el.innerHTML="<button id=\\"realBtn\\">Sign in with Google</button>";},'
  + 'prompt:function(){}}}};';

const gate = readFileSync(new URL("../../public/google-gate.js", import.meta.url), "utf8");
const sales = readFileSync(new URL("../../public/sales.html", import.meta.url), "utf8");

const br = await chromium.launch({ headless: true, executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });

function route(page, opts = {}) {
  return page.route("**/*", async (r) => {
    const u = r.request().url();
    if (u.includes("app-config")) {
      if (opts.configDelay) await new Promise((z) => setTimeout(z, opts.configDelay));
      if (opts.configHang) return; // never fulfil
      return r.fulfill({ status: 200, contentType: "application/json", body: CFG });
    }
    if (u.includes("gsi/client")) {
      if (opts.gisHang) return; // never fulfil: firewall black-hole
      return r.fulfill({ status: 200, contentType: "application/javascript", body: GIS });
    }
    if (u.includes("google-gate.js")) return r.fulfill({ status: 200, contentType: "application/javascript", body: gate });
    if (u.includes("sales.html")) return r.fulfill({ status: 200, contentType: "text/html", body: sales });
    return r.fulfill({ status: 200, body: "" });
  });
}

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); ok ? pass++ : fail++; };

// TEST 1 — reauth on a cached token must show a card WITH a button.
{
  const ctx = await br.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.addInitScript((t) => { try { localStorage.setItem("lumen_gid_token", t); } catch (e) {} }, validTok);
  const p = await ctx.newPage();
  await route(p);
  await p.goto("http://localhost:9102/sales.html", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  const wentIn = !(await p.evaluate(() => document.getElementById("gGate").classList.contains("show")));
  await p.evaluate(() => reauthGoogle("Your sign-in expired."));
  await p.waitForTimeout(1500);
  const st = await p.evaluate(() => ({
    card: document.getElementById("gGate").classList.contains("show"),
    button: !!document.querySelector("#gBtn #realBtn"),
  }));
  console.log("TEST 1 — reauth after a reused token expires (hit hourly):");
  check("cached token goes straight in, no card", wentIn);
  check("reauth shows the card", st.card);
  check("the card has a WORKING button (was the dead-card bug)", st.button);
  await ctx.close();
}

// TEST 2 — a slow (5s) config fetch must never flash the internal form.
{
  const ctx = await br.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  await route(p, { configDelay: 5000 });
  await p.goto("http://localhost:9102/sales.html", { waitUntil: "domcontentloaded" });
  let leaked = false;
  for (let i = 0; i < 75; i++) {
    const vis = await p.evaluate(() => {
      const w = document.querySelector(".wrap");
      return w && getComputedStyle(w).visibility === "visible" && /never shown to the client/.test(document.body.innerText);
    });
    if (vis) leaked = true;
    await p.waitForTimeout(100);
  }
  console.log("TEST 2 — config fetch takes 5s (cold Netlify function):");
  check("internal form NEVER visible during the wait", !leaked);
  await ctx.close();
}

// TEST 3 — a hung GIS script must not lock the page out forever.
{
  const ctx = await br.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  await route(p, { gisHang: true });
  await p.goto("http://localhost:9102/sales.html", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(9000); // past the 8s GIS-load cap
  const st = await p.evaluate(() => ({
    card: document.getElementById("gGate").classList.contains("show"),
    err: (document.getElementById("gErr").textContent || "").trim(),
    formHidden: getComputedStyle(document.querySelector(".wrap")).visibility === "hidden",
  }));
  console.log("TEST 3 — GIS script black-holed (firewall drops the socket):");
  check("page did NOT lock out — a card is shown", st.card);
  check("with an explanation", /ad blocker|network policy|could not load/i.test(st.err), JSON.stringify(st.err.slice(0, 40)));
  check("and the form stayed hidden throughout", st.formHidden);
  await ctx.close();
}

// TEST 4 — a hung config fetch must keep the form hidden (not flash it), showing a reload card.
{
  const ctx = await br.newContext({ viewport: { width: 1200, height: 800 } });
  const p = await ctx.newPage();
  await route(p, { configHang: true });
  await p.goto("http://localhost:9102/sales.html", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(7000); // past the 6s config cap, before the 8s net
  const st = await p.evaluate(() => ({
    formHidden: getComputedStyle(document.querySelector(".wrap")).visibility === "hidden",
    card: document.getElementById("gGate").classList.contains("show"),
    msg: (document.getElementById("gMsg").textContent || "").trim(),
  }));
  console.log("TEST 4 — config fetch hangs entirely:");
  check("form stays hidden (old code flashed it via hideCard)", st.formHidden);
  check("a reload card is shown", st.card && /reload/i.test(st.msg));
  await ctx.close();
}

await br.close();
console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
