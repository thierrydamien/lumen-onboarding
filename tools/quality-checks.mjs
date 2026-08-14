/**
 * Deterministic checks on a single VISIBLE assistant reply (markers, widget tags
 * and the <thought> block already stripped).
 *
 * Its own module so it can be unit-tested. tools/ab-harness.mjs exits at import
 * when ANTHROPIC_API_KEY is unset, which makes anything defined inside it
 * unreachable from a test — the same shape as the bug that left that harness
 * broken and unnoticed for 16 commits.
 */

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
