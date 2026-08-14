// Recovering from a failed FIRST turn.
//
// The composer goes live before the first reply lands (startConvo sets started=true up
// front), so a client whose opening turn fails can type instead of tapping Try again.
// Driving that path in a browser surfaced two problems:
//
//   1. The seeded opener is a USER turn left on histRef, so typing sent
//      [seeded-opener, client-answer] — two consecutive user turns, no assistant
//      between. That is the malformed shape the pop in sendToAPI and busyRef both
//      exist to prevent.
//   2. initErr was never cleared on a later success, so a "We couldn't reach the
//      assistant" card sat above a conversation that had already recovered. Its Try
//      again calls startConvo(), which resetSession()s: one reasonable tap wiped the
//      whole conversation. Measured going from the client's answers present to gone.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");

describe("a failed first turn does not poison the history", () => {
  it("drops the seeded opener so the next turn is not a second user message", () => {
    const start = src.indexOf("const startConvo");
    const body = src.slice(start, src.indexOf("}, [callAPI, init, resetSession, seed, uiLang]);", start));
    const errIdx = body.indexOf('setInitErr("start")');
    expect(errIdx, "startConvo failure branch not found").toBeGreaterThan(-1);
    // The reset must happen in the same failure branch, before/at the error flag.
    const around = body.slice(Math.max(0, errIdx - 700), errIdx + 60);
    expect(around).toMatch(/histRef\.current = \[\];/);
  });

  it("still seeds the opener on the happy path", () => {
    // Clearing it must not remove the normal seeded first turn.
    expect(src).toMatch(/const ini = \{ role:"user", content: sanitizeIn\(seededOpener\(sd, uiLang\)\) \};/);
    expect(src).toMatch(/histRef\.current = \[ini\];/);
  });
});

describe("a recovered conversation clears the failure card", () => {
  it("clears initErr on any successful turn", () => {
    // Not cosmetic: the card's own button calls startConvo(), which wipes the session.
    const ok = src.slice(src.indexOf('if (!actionable) throw new Error("empty_reply");'));
    expect(ok.slice(0, 900)).toContain("setInitErr(null)");
  });

  it("clears it before the turn is committed to history", () => {
    const ok = src.slice(src.indexOf('if (!actionable) throw new Error("empty_reply");'));
    const clear = ok.indexOf("setInitErr(null)");
    const push = ok.indexOf('histRef.current.push({role:"assistant"');
    expect(clear).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(clear);
  });

  it("the card's retry still routes to the right operation", () => {
    // start vs resume must not be conflated: resuming through startConvo would discard
    // the restored conversation.
    expect(src).toMatch(/t==="resume"\?resumeConvo\(\):startConvo\(\)/);
  });
});
