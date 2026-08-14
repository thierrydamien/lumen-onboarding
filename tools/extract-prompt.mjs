/**
 * Read the LIVE prompt constants straight out of netlify/functions/chat.js so
 * every harness stays in lockstep with prod instead of carrying its own copy.
 *
 * WHY THIS IS ITS OWN MODULE: the extraction used to live inline in
 * tools/ab-harness.mjs and did `JSON.parse(literal)`. A JS double-quoted string
 * is NOT JSON — it permits escapes JSON rejects — so a single `\'` typed into
 * the prompt made the harness throw "Bad escaped character in JSON" at import
 * time, before main() and before its try/catch. That is exactly what happened:
 * the harness failed on every commit from the one that introduced it onward and
 * had never once run. Decoding the literal as JS (below) removes that whole
 * class of breakage, and the shared module means one fix covers every harness.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Decode a JS double-quoted string literal (quotes included) to its value.
 * Handles every escape a JS string literal can carry, including the ones JSON
 * rejects: \' , \v , \0 , \xHH and backslash-newline line continuations.
 * Any unrecognised \c decodes to c, which is what JS itself does.
 */
export function decodeJsString(literal) {
  if (typeof literal !== "string" || literal.length < 2 || literal[0] !== '"' || literal[literal.length - 1] !== '"') {
    throw new Error("decodeJsString expects a double-quoted JS string literal");
  }
  const body = literal.slice(1, -1);
  const SIMPLE = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "0": "\0" };
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") { out += c; continue; }
    const e = body[++i];
    if (e === undefined) throw new Error("trailing backslash in string literal");
    if (e === "u") {
      if (body[i + 1] === "{") {                       // \u{1F600}
        const end = body.indexOf("}", i);
        if (end === -1) throw new Error("unterminated \\u{...} escape");
        out += String.fromCodePoint(parseInt(body.slice(i + 2, end), 16));
        i = end;
      } else {                                          // \uXXXX
        out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else if (e === "x") {                             // \xHH
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (e === "\n") {                            // line continuation: emits nothing
    } else {
      out += Object.prototype.hasOwnProperty.call(SIMPLE, e) ? SIMPLE[e] : e;
    }
  }
  return out;
}

/** Pull `const NAME = "...";` out of a source string and return its value. */
export function extractConst(source, name) {
  const m = source.match(new RegExp("const " + name + " = (\"(?:[^\"\\\\]|\\\\.)*\");"));
  if (!m) throw new Error(`Could not find const ${name} in the given source`);
  return decodeJsString(m[1]);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHAT_JS_PATH = path.join(HERE, "..", "netlify", "functions", "chat.js");

/** Convenience: read chat.js from disk and return one of its prompt constants. */
export function loadPromptConst(name, chatJsPath = CHAT_JS_PATH) {
  return extractConst(readFileSync(chatJsPath, "utf8"), name);
}
