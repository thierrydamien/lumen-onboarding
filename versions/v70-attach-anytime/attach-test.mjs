import pw from "/opt/node22/lib/node_modules/playwright/index.js";
const DIR = "/tmp/claude-0/-home-user-juilly/083ec947-7ba2-56bc-ad85-cdcd5dfdd7e4/scratchpad/";
const b = await pw.chromium.launch();
const p = await b.newPage({ viewport:{width:480,height:1000} });
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("http://127.0.0.1:8199/chat.html",{waitUntil:"load"}); await p.waitForTimeout(700);
const demo = p.getByText("Preview completed demo"); if(await demo.count()){ await demo.first().click(); await p.waitForTimeout(600); }
const clip = p.locator('button[aria-label="Attach a document"]');
console.log("paperclip present:", await clip.count());
await p.screenshot({ path: DIR+"attach-composer.png", fullPage:true });
// Attach a .txt: sets the hidden input, which fires onAttachFile -> sendAttachment.
await p.setInputFiles('input[type=file][accept*=".docx"]', DIR+"reqs.txt");
await p.waitForTimeout(2500); // extract + 2 API attempts (fail in sandbox) + failMessage
await p.screenshot({ path: DIR+"attach-result.png", fullPage:true });
const bodyText = await p.locator("body").innerText();
console.log("chip shows filename:", bodyText.includes("reqs.txt"));
console.log("honest fail msg:", /couldn't read that document in time/.test(bodyText));
console.log("pageerrors:", JSON.stringify(errs));
await b.close();
