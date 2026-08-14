import { open, start } from "./drive.mjs";

// Two paths a client can land on that no test had ever watched WORK:
//
// 1. The background fallback. The client is sync-first; when the sync proxy
//    fails, it falls back to chat-background + chat-status polling. The handover
//    lists this as gap #4: "only ever exercised as a failure". Here the sync
//    endpoint 500s while the background path works — the conversation must
//    proceed as if nothing happened.
//
// 2. A dead link. Seeds expire after 90 days (or a link can simply be wrong).
//    The client must see the friendly "link expired, starting fresh" banner and
//    STILL be able to complete an onboarding — a dead link must never be a dead
//    end, because it is the very first thing that client ever sees of Lumen.

console.log("--- 1. sync path down, background path up ---");
{
  const { browser, page } = await open();
  await page.evaluate(() => { window.__ctl.chatMode = "syncFail"; });
  await start(page);
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => ({
    gotReply: /what markets matter most/i.test(document.body.innerText),
    syncCalls: window.__ctl.calls.filter((c) => /functions\/chat(\?|$)/.test(c.url)).length,
    bgKickoffs: window.__ctl.calls.filter((c) => c.url.includes("chat-background")).length,
    polls: window.__ctl.calls.filter((c) => c.url.includes("chat-status")).length,
    errorShown: /try again|couldn't reach/i.test(document.body.innerText),
  }));
  console.log("  first reply arrived            :", state.gotReply);
  console.log("  served by background+poll      :", state.bgKickoffs > 0 && state.polls > 0);
  console.log("  no error surfaced to the client:", !state.errorShown);

  // And a second turn, to prove it is not a first-turn fluke.
  await page.locator("textarea").first().fill("we are a small brewery");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(4500);
  const again = await page.evaluate(() => (document.body.innerText.match(/what markets matter most/gi) || []).length);
  console.log("  second turn also served        :", again >= 2);
  await browser.close();
}

console.log("\n--- 2. expired link ---");
{
  const { browser, page } = await open();
  await page.evaluate(() => sessionStorage.setItem("__stub.seedMode", "expired"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const t = await page.evaluate(() => document.body.innerText);
  console.log("  friendly banner shown :", /link has expired/i.test(t));
  console.log("  not a scary error     :", !/error|failed|wrong/i.test((t.match(/link has expired[^.]*\./i) || [""])[0]));
  // The client must still be able to onboard from scratch.
  await start(page);
  await page.waitForTimeout(1500);
  console.log("  can still start fresh :", await page.evaluate(() => /what markets matter most/i.test(document.body.innerText)));
  await browser.close();
}

console.log("\n--- 3. seed lookup transient failure (with control) ---");
{
  const { browser, page } = await open();
  // CONTROL first: with a healthy seed there must be NO banner and the seeded
  // prefill must show. This is what catches a stub whose seed shape is wrong —
  // the first version of this test passed vacuously because the banner was
  // showing on every load.
  const healthy = await page.evaluate(() => document.body.innerText);
  console.log("  control: no banner on a healthy link:", !/couldn't load your prepared setup/i.test(healthy));
  console.log("  control: seeded welcome (client name) :", /Jane|Acme/.test(healthy));
  await page.evaluate(() => sessionStorage.setItem("__stub.seedMode", "fail"));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const t = await page.evaluate(() => document.body.innerText);
  console.log("  transient banner shown on failure     :", /couldn't load your prepared setup/i.test(t));
  await browser.close();
}
