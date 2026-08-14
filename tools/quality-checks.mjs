/**
 * Deterministic checks on a single VISIBLE assistant reply (markers, widget tags
 * and the <thought> block already stripped).
 *
 * Its own module so it can be unit-tested. tools/ab-harness.mjs exits at import
 * when ANTHROPIC_API_KEY is unset, which makes anything defined inside it
 * unreachable from a test — the same shape as the bug that left that harness
 * broken and unnoticed for 16 commits.
 */

/**
 * What the CLIENT would actually see, mirroring stripAll in src/lumen.jsx.
 *
 * The harness had its own weaker copy that stripped only <thought>. The prompt
 * asks for <thought>, but models routinely emit <thinking> instead — production
 * covers all four spellings, the harness covered one. So an entire reasoning
 * block counted as visible prose: it inflated the multi-question count (planning
 * is full of question marks), it was fed to the judge, and it was written into
 * ab-transcripts.txt as though the client had been shown it. Measured on a real
 * run, that alone turned 1 genuine violation into 9.
 *
 * It also missed TOPIC_SUGGESTION{...} — the brace form the prompt specifies —
 * catching only a bracketed form that is not what the model emits.
 *
 * Deliberately NOT imported from src/lumen.jsx: that module is JSX and pulls in
 * React, so a plain node harness cannot load it. Kept as a faithful copy with
 * this note, and tests/quality-checks.test.js pins the two against each other.
 */
export function visibleOf(reply) {
  return String(reply == null ? "" : reply)
    .replace(/<(thought|thoughts|thinking|think)>[\s\S]*?<\/(thought|thoughts|thinking|think)>/gi, "")
    .replace(/<(thought|thoughts|thinking|think)>[\s\S]*$/i, "")   // truncated mid-block
    .replace(/%%[A-Z]+%%[\s\S]*?%%END%%/g, "")
    .replace(/\[WIDGET:[A-Z_]+\]/g, "")
    .replace(/\[SUGGESTIONS:[\s\S]*?\]/g, "")
    .replace(/\[OFFER_SEND\]/g, "")
    .replace(/TOPIC_SUGGESTION\s*:?\s*\{[^{}]*\}/g, "")
    .replace(/^TOPIC_SUGGESTION\|.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// One question per message is a CRITICAL rule in the live prompt. Counting raw
// "?" over-reports: measured against 40 real turns from the deployed build, every
// false positive was the same shape — one question followed by an illustrative
// example that happens to end in a question mark ("...a concrete decision it
// would inform? For example, whether the Q4 budget is working?"). That reads as a
// single ask, so a sentence opening with an example marker does not count.
//
// Both genuine violation shapes survive the filter:
//   1. ask then rephrase  — "what do you hope to get? What brought you here?"
//   2. confirm + ask      — "...you're in craft beer, right? And your email?"
// NOTE the trailing lookahead rather than \b. In JS \b is defined against
// [A-Za-z0-9_], so it never matches after Arabic script — with \b the Arabic
// alternatives below could never fire, and the filter silently did nothing for
// the one language most likely to need it. \p{L} with the u flag covers both.
const EXAMPLE_OPENER =
  /^\s*(for example|e\.?g\.?|for instance|par exemple|z\.?\s?b\.?|zum beispiel|por ejemplo|ad esempio|per esempio|مثلاً|مثلا)(?![\p{L}])/iu;

/** Sentences in `visible` that read as a distinct question. */
export function countQuestions(visible) {
  // Split on sentence enders, including the Arabic question mark U+061F.
  const sentences = String(visible == null ? "" : visible).split(/(?<=[.!?؟])\s+/);
  let asks = 0;
  for (const s of sentences) {
    if (!/[?؟]/.test(s)) continue;
    if (EXAMPLE_OPENER.test(s)) continue;
    asks++;
  }
  return asks;
}

/** True when a reply asks more than one question — a prompt-rule violation. */
export function multiQuestion(visible) {
  return countQuestions(visible) > 1;
}
