// Telling a human when the TOOL is broken, and naming what the client bought.
//
// Every other alert in this repo is about a client. chat.js had seven
// console.error paths — a missing key, upstream 401/429/5xx — that were logged
// and nothing else, so an expired credential broke every live session while the
// only signal sat in a Netlify log nobody watches.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
// Strip comments before asserting. Both of the first drafts of the tests below
// matched their own explanatory prose — "before ANY await" satisfied a search for
// `await`, and "EMAIL, NOT SLACK" satisfied a search for `slack` — which is the
// documented way tests in this repo pass against broken code.
const decomment = (x) => x.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const ops = read("netlify/lib/opsalert.js");
const chat = read("netlify/functions/chat.js");
const sheet = read("netlify/functions/sheet.js");
const gs = read("apps-script/onboarding-sheet-webapp.gs");

describe("an outage reaches a person, by email", () => {
  it("alerts only on failures that break every session, not one request", () => {
    // A 400 is one malformed request. 401/403 is the credential, 429 is the quota
    // ceiling, 5xx is the provider — each hits every concurrent client at once.
    expect(chat).toMatch(/res\.status === 401 \|\| res\.status === 403 \|\| res\.status === 429 \|\| res\.status >= 500/);
    expect(chat).toMatch(/notifyOps\("anthropic_key_missing"/);
    expect(chat).toMatch(/notifyOps\("upstream_unreachable"/);
  });

  it("cannot delay or break the request it is reporting on", () => {
    // Fire-and-forget at every call site, and a lib that never throws.
    const calls = chat.match(/notifyOps\(/g) || [];
    const voided = chat.match(/void notifyOps\(/g) || [];
    expect(voided.length, "every notifyOps call must be voided").toBe(calls.length);
    expect(ops).toMatch(/catch \(err\)[\s\S]*return false;/);
  });

  it("survives a burst, which is the normal case for an outage", () => {
    const opsCode = decomment(ops);
    // The Blobs stamp is a read-then-write with no compare-and-swap, so concurrent
    // invocations all read "nothing sent yet" before any writes: measured at 50
    // simultaneous failures producing 50 mails. The synchronous in-process claim
    // is what actually holds — verified back down to 1 mail per instance.
    expect(opsCode).toMatch(/const _claimed = new Map\(\)/);
    // Claimed before ANY await, or the window simply reopens.
    const fn = opsCode.slice(opsCode.indexOf("export async function notifyOps"));
    const claimAt = fn.indexOf("_claimed.set(kind, Date.now())");
    const firstAwait = fn.indexOf("await");
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt, "the claim must be set before the first await").toBeLessThan(firstAwait);
  });

  it("releases the claim when the send failed, so a retry can still alert", () => {
    expect(ops).toMatch(/_claimed\.delete\(kind\);/);
    // And does not stamp durable storage on a send that never landed.
    const idx = { stamp: ops.indexOf("store.setJSON(kind"), send: ops.indexOf("await fetch(url") };
    expect(idx.stamp).toBeGreaterThan(idx.send);
  });

  it("emails rather than posting to the completion channel", () => {
    // A status code and a provider name are operational detail, and the channel is
    // read by people who cannot act on them.
    expect(gs).toMatch(/MailApp\.sendEmail\(to, subject/);
    // Code only: the header comment explains the choice and says the word.
    expect(decomment(ops)).not.toMatch(/chat\.postMessage|slack/i);
  });

  it("keeps the recipient out of a public repo and stays dormant without it", () => {
    expect(gs).toMatch(/getProperty\("OPS_EMAIL"\)/);
    expect(gs).toMatch(/if \(!to\) return false;/);
    expect(gs).not.toMatch(/@hootsuite\.com/);
    expect(ops).not.toMatch(/@hootsuite\.com/);
  });

  it("is a no-op until the Apps Script integration is configured", () => {
    expect(ops).toMatch(/if \(!url \|\| !secret \|\| !kind\) return false;/);
  });
});

describe("the alert names what the client actually bought", () => {
  it("resolves the package server-side, never via the browser", () => {
    // The client's own copy of the seed is the client-safe subset and deliberately
    // excludes the package. It should stay that way, so sheet.js reads the seed
    // record itself: session -> seedId -> seed.package.
    expect(sheet).toMatch(/async function packageForSession\(sessionId\)/);
    expect(sheet).toMatch(/getStore\("lumen-seeds"\)/);
    expect(sheet).toMatch(/package: pkg/);
    expect(read("src/lumen.jsx")).not.toMatch(/package: .*pkgCode|seed\.package/);
  });

  it("never lets a missing package stop a Sheet being created", () => {
    const fn = sheet.slice(sheet.indexOf("async function packageForSession"), sheet.indexOf("async function verifiedClientEmail"));
    expect(fn).toMatch(/catch \(err\)[\s\S]*return "";/);
    expect(fn).toMatch(/typeof pkg === "string" \? pkg\.slice\(0, 40\) : ""/); // bounded: it lands in a Slack message
  });

  it("degrades a new SKU to something readable instead of dropping it", () => {
    // Verified: "newsku-plus" -> "Newsku · Plus" rather than vanishing.
    const fn = gs.slice(gs.indexOf("function packageLabel_"), gs.indexOf("// Context line describing HOW"));
    expect(fn).toMatch(/PRODUCTS\[parts\[0\]\] \|\| title\(parts\[0\]\)/);
    expect(fn).toMatch(/if \(!raw\) return "";/);
  });
});
