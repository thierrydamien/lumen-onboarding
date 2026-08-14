// Returning to the link AFTER the brief has been sent.
//
// `sent` and `sheetLink` are plain component state, the autosave effect bails once
// `sent` is true, and a successful send deliberately clears both draft copies. So there
// was nothing left to restore: a refresh — or simply re-opening the emailed link to find
// the Sheet again — dropped the client on the untouched Start screen. Verified: the
// confirmation, the "what happens next" timeline and the Google Sheet link were all
// gone, and "Start <company>'s setup" was offered as if nothing had happened. Pressing
// it mints a NEW session id, giving the consultant a second dashboard row for the same
// client.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");

describe("a delivered brief leaves a receipt", () => {
  it("stores one under its own key, separate from the draft", () => {
    expect(src).toMatch(/const lsSentKey = seedId => LS_PREFIX \+ "sent_"/);
    expect(src).toMatch(/function lsSaveReceipt\(seedId, r\)/);
    expect(src).toMatch(/function lsLoadReceipt\(seedId\)/);
  });

  it("writes it on a delivered send, alongside clearing the draft", () => {
    const send = src.slice(src.indexOf("if (saveOk) { lsClearDraft(seedId); srvClearDraft(seedId); }"));
    expect(send.slice(0, 600)).toMatch(/lsSaveReceipt\(seedId, \{ sentAt: sentAt\.toISOString\(\), sheetLink: sheetUrl \|\| null, uiLang \}\)/);
  });

  it("writes it even when the record save failed but the Sheet landed", () => {
    // That path deliberately keeps the draft; the receipt must not be gated on saveOk,
    // or the one case most likely to be revisited is the one with no receipt.
    const send = src.slice(src.indexOf("if (saveOk) { lsClearDraft(seedId); srvClearDraft(seedId); }"));
    const clear = send.indexOf("if (saveOk)");
    const receipt = send.indexOf("lsSaveReceipt(");
    expect(receipt).toBeGreaterThan(clear);
    // the receipt call must sit OUTSIDE the saveOk block (which ends on the same line)
    expect(send.slice(clear, receipt)).toContain("}");
  });

  it("carries only what the finish card needs, never a conversation", () => {
    // Anything more could resurrect a submitted session.
    const save = src.slice(src.indexOf("lsSaveReceipt(seedId, {"), src.indexOf("lsSaveReceipt(seedId, {") + 160);
    expect(save).not.toMatch(/messages|history|wState|cdata/);
  });
});

describe("the receipt is honoured on return", () => {
  it("is checked on mount before any draft handling", () => {
    const eff = src.slice(src.indexOf("const receipt = lsLoadReceipt(seedId);"));
    const draft = src.indexOf("const local = lsLoadDraft(seedId);", src.indexOf("const receipt = lsLoadReceipt(seedId);"));
    expect(src.indexOf("const receipt = lsLoadReceipt(seedId);")).toBeLessThan(draft);
    expect(eff.slice(0, 400)).toContain("return;"); // early return, so a stale draft cannot win
  });

  it("restores the sent state and the Sheet link", () => {
    const eff = src.slice(src.indexOf("const receipt = lsLoadReceipt(seedId);"), src.indexOf("const receipt = lsLoadReceipt(seedId);") + 600);
    expect(eff).toContain("setSheetLink(receipt.sheetLink || null)");
    expect(eff).toContain("setSent(true)");
    expect(eff).toContain("setStarted(true)");
  });

  it("restores the language the brief was sent in", () => {
    const eff = src.slice(src.indexOf("const receipt = lsLoadReceipt(seedId);"), src.indexOf("const receipt = lsLoadReceipt(seedId);") + 600);
    expect(eff).toMatch(/receipt\.uiLang && UI_LANGS\.some/);
  });

  it("does not disturb the resume path when nothing was sent", () => {
    // With no receipt the effect must fall through to the existing draft logic.
    expect(src).toMatch(/const receipt = lsLoadReceipt\(seedId\);\s*\n\s*if \(receipt\) \{/);
    expect(src).toMatch(/const draft = pickDraft\(local, remote\);/);
  });
});
