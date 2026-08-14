// The prompt is the product's behaviour. It moved out of chat.js into its own
// file so it can be reviewed as prose, and the ONLY thing that mattered about
// that move is that not one character changed.
//
// The checksum below was taken from the prompt as it shipped on main BEFORE the
// move. It is not decoration: it is the thing that makes an accidental edit —
// a stray keystroke, a bad merge, an editor reformatting on save — fail the
// build instead of reaching a client mid-conversation.
//
// WHEN YOU DELIBERATELY CHANGE THE PROMPT: this test is supposed to fail. Read
// the diff (which is now readable, which was the point), satisfy yourself the
// change is what you meant, then update EXPECTED_SHA and EXPECTED_LENGTH in the
// same commit. Never update them in a commit that changes anything else.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SYSTEM_PROMPT } from "../netlify/lib/system-prompt.js";

const EXPECTED_SHA = "3efd33c9fd69cab1b301be864835b7c287c736e782d04deca499cbef6192ae2d";
const EXPECTED_LENGTH = 33197;

describe("the live system prompt", () => {
  it("is byte-for-byte the text that shipped", () => {
    const sha = createHash("sha256").update(SYSTEM_PROMPT, "utf8").digest("hex");
    expect(SYSTEM_PROMPT.length).toBe(EXPECTED_LENGTH);
    expect(sha).toBe(EXPECTED_SHA);
  });

  it("still carries the rules the app depends on to function", () => {
    // Behavioural anchors, not wording. If any of these are lost the app breaks
    // in a way no other test would catch: the client parses English markers, and
    // a translated marker name is not stripped, so it leaks raw to the screen.
    expect(SYSTEM_PROMPT).toMatch(/mirror the client's language/i);
    expect(SYSTEM_PROMPT).toMatch(/stay in English/i);
    expect(SYSTEM_PROMPT).toMatch(/%%PROGRESS%%/);
    expect(SYSTEM_PROMPT).toMatch(/@ATTACH/);
    expect(SYSTEM_PROMPT).toMatch(/never ask more than one question/i);
  });

  it("keeps the two deliberate backslashes in (\\[OFFER_SEND\\])", () => {
    // These are real characters sent to the model. They look like a mistake and
    // are easy to "tidy up" — doing so would silently change the prompt, so pin
    // them. Any change here is a prompt change and must be intentional.
    expect(SYSTEM_PROMPT).toContain("(\\[OFFER_SEND\\])");
    expect((SYSTEM_PROMPT.match(/\\/g) || []).length).toBe(2);
  });
});

describe("chat.js no longer embeds the prompt", () => {
  const chatSrc = readFileSync(new URL("../netlify/functions/chat.js", import.meta.url), "utf8");

  it("imports it instead of carrying a copy", () => {
    // Two copies drifting apart is the failure this whole move prevents.
    expect(chatSrc).toContain('from "../lib/system-prompt.js"');
    expect(chatSrc).not.toContain("You are an expert onboarding consultant");
  });

  it("keeps the prompt out of the functions directory", () => {
    // Every file in netlify/functions/ is published as its own HTTP endpoint.
    // The prompt living there would expose it; netlify/lib/ does not publish.
    const url = new URL("../netlify/functions/system-prompt.js", import.meta.url);
    expect(() => readFileSync(url)).toThrow();
  });
});
