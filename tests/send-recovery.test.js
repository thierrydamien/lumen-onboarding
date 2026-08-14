// Re-sending a brief must not destroy what the first send achieved.
//
// The Send button stays live after a successful send on purpose: re-sending is the
// documented recovery path when the record save failed but the Sheet was delivered.
// That makes a second send a normal thing for a client to do, so it must be safe.
//
// Found by driving it: send successfully (finish card offers "Open your brief"), then
// re-send while the Sheet endpoint is failing. The link disappeared from the card even
// though the Sheet existed untouched, leaving the client no in-app route back to it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
const session = readFileSync(new URL("../netlify/functions/session.js", import.meta.url), "utf8");

describe("a failed re-send keeps a Sheet link that already exists", () => {
  it("only sets the link when one was actually returned", () => {
    // `sheetUrl` is a fresh local per send and stays null whenever the Sheet step fails,
    // so an unconditional assignment nulls out a known-good link.
    expect(src).toMatch(/if \(sheetUrl\) setSheetLink\(sheetUrl\);/);
  });

  it("never assigns the link unconditionally", () => {
    expect(src).not.toMatch(/^\s*setSheetLink\(sheetUrl\);/m);
  });

  it("matches the rule the server already applies", () => {
    // session.js reconciles the same way when a completed record comes back without a
    // sheetUrl; the client had been the only side that forgot.
    expect(session).toMatch(/prev && prev\.sheetUrl && !record\.sheetUrl.*record\.sheetUrl = prev\.sheetUrl/);
  });

  it("still clears nothing else about the sent state", () => {
    // The finish card must keep reporting `sent`; only the link assignment was at fault.
    expect(src).toMatch(/onBriefSent\?\.\(\{ \.\.\.record, filename, sentAt \}\);/);
    expect(src).toMatch(/setSent\(true\); setShowExport\(false\);/);
  });
});
