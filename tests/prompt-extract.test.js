// Guards the seam between the live prompt in netlify/functions/chat.js and every
// harness that reads it (tools/ab-harness.mjs, tools/live-convo.mjs).
//
// WHY THIS EXISTS: the extraction used to be `JSON.parse(literal)`. A JS
// double-quoted string is a DIFFERENT grammar from JSON — it allows escapes JSON
// rejects — so a single `\'` typed into the prompt made every harness throw
// "Bad escaped character in JSON" at import time. It went unnoticed because the
// throw happened before main() and before its try/catch, and because nothing
// tested it: the harness was broken on every commit from its introduction
// onward and had never once run. These tests fail if that regresses.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { decodeJsString, extractConst, loadPromptConst, CHAT_JS_PATH } from "../tools/extract-prompt.mjs";

describe("decodeJsString", () => {
  it("decodes the escapes JSON also understands", () => {
    expect(decodeJsString('"a\\nb"')).toBe("a\nb");
    expect(decodeJsString('"say \\"hi\\""')).toBe('say "hi"');
    expect(decodeJsString('"back\\\\slash"')).toBe("back\\slash");
    expect(decodeJsString('"\\u00e9t\\u00e9"')).toBe("été");
  });

  it("decodes the JS-only escapes that JSON.parse rejects", () => {
    // This is the exact shape that broke the harness. JSON.parse throws here.
    expect(() => JSON.parse('"entry\\\'s"')).toThrow();
    expect(decodeJsString('"entry\\\'s"')).toBe("entry's");
    expect(decodeJsString('"\\x41"')).toBe("A");
    expect(decodeJsString('"\\u{1F600}"')).toBe("\u{1F600}");
    // An unrecognised escape decodes to the bare character, exactly as JS does.
    expect(decodeJsString('"\\q"')).toBe("q");
  });

  it("rejects input that is not a double-quoted literal", () => {
    expect(() => decodeJsString("'single'")).toThrow();
    expect(() => decodeJsString('"')).toThrow();
  });
});

describe("the live prompt constants are extractable", () => {
  // Behavioural assertions only — the handover's rule is not to pin identifiers,
  // so these match on content the prompt must carry to work at all.
  it("extracts SYSTEM_PROMPT as a substantial string", () => {
    const p = loadPromptConst("SYSTEM_PROMPT");
    expect(typeof p).toBe("string");
    expect(p.length).toBeGreaterThan(10000);
  });

  it("carries the rule that keeps markers English in a non-English conversation", () => {
    // If this rule is lost, every non-English session silently stops capturing
    // data, because the client only parses English marker names.
    const p = loadPromptConst("SYSTEM_PROMPT");
    expect(p).toMatch(/mirror the client's language/i);
    expect(p).toMatch(/stay in English/i);
  });

  it("decodes to the same value the JS runtime gives the literal", () => {
    // The ultimate correctness check: our decoder must agree with JS itself.
    const src = readFileSync(CHAT_JS_PATH, "utf8");
    const literal = src.match(/const SYSTEM_PROMPT = ("(?:[^"\\]|\\.)*");/)[1];
    // eslint-disable-next-line no-new-func -- the regex admits only a well-formed literal
    const viaRuntime = new Function("return " + literal)();
    expect(decodeJsString(literal)).toBe(viaRuntime);
  });

  it("throws a clear error for a constant that isn't there", () => {
    expect(() => extractConst('const A = "x";', "NOPE")).toThrow(/Could not find/);
  });
});

describe("chat.js stays parseable by a strict JSON reader too", () => {
  // Belt and braces. The decoder above makes the harness immune, but keeping the
  // literal JSON-clean means any other consumer (or a future one-liner) is safe.
  it("uses no escape that JSON.parse would reject", () => {
    const src = readFileSync(CHAT_JS_PATH, "utf8");
    const bad = [];
    for (const m of src.matchAll(/^const ([A-Z_0-9]+) = ("(?:[^"\\]|\\.)*");$/gm)) {
      try { JSON.parse(m[2]); } catch (e) { bad.push(`${m[1]}: ${e.message}`); }
    }
    expect(bad).toEqual([]);
  });
});
