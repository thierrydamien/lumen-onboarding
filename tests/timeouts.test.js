// Cross-file timeout invariant.
//
// THE BUG THIS GUARDS: the client gave up polling at 180s while the background
// function kept generating to 540s. The abandoned job finished, billed a full
// generation, and persisted a result nobody would poll for — and the client, having
// seen nothing, re-rolled a brand new job. One slow turn, two paid generations, and a
// failure shown to the client while their answer was still being written.
//
// The fix is an ORDERING, not a pair of magic numbers: the server must give up first
// so the outcome is reported rather than inferred. Nothing in the language enforces a
// relationship between two constants in two separate bundles, so it is enforced here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

function constant(src, name) {
  // Matches `const NAME = 150_000;` and `const A = 500, NAME = 180_000;`.
  // The trailing lookahead deliberately REJECTS an expression such as `9 * 60 * 1000`:
  // a loose match would read the leading `9` and quietly satisfy the ordering check
  // while the real budget was 540s, which is exactly the bug this file exists to catch.
  const m = new RegExp(name + "\\s*=\\s*([0-9_]+)\\s*(?=[;,)\\n])").exec(src);
  expect(m, `${name} must be a plain millisecond literal (an expression like 9 * 60 * 1000 is not parseable here, and hid this bug once already)`).not.toBeNull();
  const v = Number(m[1].replace(/_/g, ""));
  expect(v, `${name} does not look like milliseconds`).toBeGreaterThanOrEqual(1000);
  return v;
}

const clientSrc = read("../src/lumen.jsx");
const bgSrc = read("../netlify/functions/chat-background.js");

describe("poll deadline vs background generation budget", () => {
  const pollMax = constant(clientSrc, "POLL_MAX_MS");
  const bgAbort = constant(bgSrc, "BG_ABORT_MS");

  it("has the server give up before the client stops listening", () => {
    expect(bgAbort).toBeLessThan(pollMax);
  });

  it("leaves enough margin for the result to be persisted and polled", () => {
    // The client polls every 500ms with a 12s per-poll timeout, so the gap has to
    // cover a slow poll plus the persist. 20s is comfortably above both.
    expect(pollMax - bgAbort).toBeGreaterThanOrEqual(20_000);
  });

  it("still allows far longer than any measured legitimate reply", () => {
    // Real replies have been measured at 20-30s. Guard against someone "fixing" the
    // invariant by collapsing the budget to something that cuts off real turns.
    expect(bgAbort).toBeGreaterThanOrEqual(90_000);
  });
});
