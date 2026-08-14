import { open, start } from "./drive.mjs";

// Every real client link is a SEEDED session, so this is the default path.
// Claim under test: "✓ Progress saved" + "Reopen this link on any device".
// That is a promise about the SERVER draft. Break the server draft and see
// whether the app keeps making the promise.

const run = async (draftSave) => {
  const { browser, page } = await open();
  await page.evaluate((m) => { window.__ctl.draftSave = m; }, draftSave);
  await start(page);
  await page.waitForTimeout(600);

  // Answer something so the debounced autosave actually fires.
  await page.getByRole("button", { name: "France", exact: true }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Confirm", exact: true }).first().click();
  await page.waitForTimeout(3000);

  const out = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      claimsCrossDevice: /Progress saved/i.test(t),
      claimsThisDeviceOnly: /Saved on this device/i.test(t),
      draftPosts: window.__ctl.calls.filter((c) => c.url.includes("/functions/draft") && c.method === "POST").length,
    };
  });
  await browser.close();
  return out;
};

console.log("draftSave=ok  ->", JSON.stringify(await run("ok")));
console.log("draftSave=FAIL->", JSON.stringify(await run("fail")));
console.log("\nIf both claim cross-device, the promise is unconditional.");
