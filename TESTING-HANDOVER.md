# Lumen onboarding — testing handover

Rewritten 2026-08-17. The previous version of this file was written on 2026-08-14
against commit `8d725b7` and 162 tests. It is now three lineages out of date and
every item on its backlog has since been closed, so it has been replaced wholesale
rather than amended. **Do not act on a copy of the older version.**

Current state: `3a5c6d6`, **502 tests** across 45 files, build and function bundle
clean. Every source file in the repo is named by at least one test.

---

## Read this first

Three things about this repo will waste your time if you learn them the hard way.

1. **Deploys cost the owner money.** Batch fixes, verify locally, ship once.
   Nothing in this document requires a deploy except the live-model tools.

2. **Test coverage here does not mean what it usually means.** Most tests parse
   the *source* rather than executing it, because `src/lumen.jsx` is not shaped
   for import. That catches removals and reorderings and nothing else. When a
   test can execute the real thing, make it — `tests/ratelimit.test.js`,
   `tests/google-gate-endpoint.test.js` and `tests/keep-warm.test.js` all do, and
   the defects they found were invisible to inspection.

3. **Prove every regression test fails when you revert its fix.** This is not
   ceremony. Tests in this repo have passed against broken code four separate
   times: a `[^)]*` that could not cross a `)`, an assertion that matched an
   explanatory comment about the old behaviour, a whole-file search that matched
   the word "anthropic" in a header comment at character 15, and a lazy regex
   that wandered across HTML element boundaries. Each looked fine and asserted
   nothing.

---

## Harnesses

### Unit / source tests

```bash
npm test                 # 502 tests
npm run build            # vite build
npx esbuild netlify/functions/*.js --bundle --platform=node --format=esm \
  --outdir=/tmp/fnck --external:@netlify/blobs   # function bundle check
```

### Browser harness — the client chat

Drives the **real built bundle** in a real browser with the network stubbed. See
`tools/browser-harness/README.md` for full setup and the `window.__ctl` table.
Sixteen driver scripts already exist (`t-resume.mjs`, `t-sendfail.mjs`,
`t-rotate.mjs`, …); copy the nearest one rather than starting from scratch.

Two traps, both documented in that README: write `stub.js` as a real file loaded
with `<script src>` (inlining it fails to parse silently), and stub the
**synchronous** `/functions/chat` because the client is sync-first.

### Browser harness — the Sales page

`tools/browser-harness/sales-stub.js`, setup in the same README. `sales.html` is
static, so no build step. Copy `google-gate.js` across too or the page throws
`LumenGoogleGate is not defined` and Generate silently does nothing, which reads
exactly like the bug you are hunting.

**Read UI state from `classList`, not from computed style.** A browser pane that
is not compositing freezes CSS transitions at zero progress, so
`getComputedStyle` reports collapsed values forever while the class is correctly
applied. This cost an hour and looks precisely like a cascade bug that isn't one.
It is also why the Sales link panel uses `inert` rather than transitioned
`visibility`: an accessibility guarantee must not depend on an animation running.

### Live model tools (these DO spend money)

```bash
LUMEN_SITE=https://lumen-onboarding.netlify.app node tools/live-convo.mjs init -f /tmp/fr.json --lang French
node tools/live-convo.mjs say -f /tmp/fr.json "Bonjour, ici Amélie de ..."
node tools/live-convo.mjs report -f /tmp/fr.json

LUMEN_SITE=... node tools/live-ending.mjs de      # a full run to the finish card
ANTHROPIC_API_KEY=sk-... node tools/ab-harness.mjs  # prompt-lever A/B
```

`tools/quality-checks.mjs` holds the deterministic reply checks (marker validity,
the multi-question counter). Use it rather than a 1-5 judge score for narrow
defects: a coarse score does not move on them, and deterministic counting needs
far fewer runs, which keeps the API bill down.

---

## What is covered

| Area | How |
|---|---|
| Client chat (`src/lumen.jsx`, 4,926 lines) | 27 test files + 16 browser drivers |
| Sales link generator | 6 test files + browser harness |
| Dashboard | 8 test files + browser driver |
| Team hub (`index.html`) | link/redirect and semantics tests |
| Netlify functions | per-function tests; `seed`, `session`, `chat` heavily |
| Rate limiter | executed against a fake store, incl. malformed records |
| Google Sign-In gate | module, wiring, and a real forged-request probe |
| Conversation quality | live A/B harness + deterministic reply checks |
| i18n | mechanical audit of all 6 languages, zero missing keys |

**The whole backlog from the previous handover is closed.** All 44 findings from
the original automated audit are resolved, rejected as false positives, or
explicitly decided against. Nothing on that list is still worth chasing.

---

## What is NOT tested

Ordered by how much it should worry you.

1. **One browser, one engine.** Everything to date is Chromium. No Safari (so no
   real `100dvh`, no iOS keyboard behaviour), no Firefox, no physical device.
   This is now the largest gap by some distance.
2. **Screen readers have never been run.** Focus order, the accessibility tree,
   `inert` and `aria-hidden` are all verified programmatically. Nobody has heard
   VoiceOver or NVDA read any of it. Programmatic checks and a real screen reader
   disagree more often than you would like.
3. **The Arabic "Email to client" draft.** Measured at **9,175 URL characters**
   (body alone 8,895 encoded) versus 3,100–3,800 for every other language,
   because UTF-8 percent-encoding triples each character. Whether Gmail truncates
   or rejects it needs one manual check: generate a link, set language to Arabic,
   click "Email to client", confirm the body arrives whole. Do this before an
   Arabic client is ever sent one.
4. **Scale and load.** Untouched. No concurrency testing, and note the rate
   limiter is deliberately non-atomic (Blobs has no compare-and-swap), so
   concurrent requests undercount by design.
5. **A real Google Sheet has never been produced end to end** by an automated
   run. The Apps Script path is stubbed everywhere.
6. **Non-English conversation quality at length.** UI strings and RTL layout are
   checked in all six languages, and the A/B harness runs non-English turns, but
   nobody has read a full 20-turn French, German or Arabic transcript for whether
   the assistant is actually any good. Needs a native speaker, not a test.

---

## Things deliberately decided, not overlooked

Do not "fix" these without talking to the owner first.

- **`pickDraft` compares two different clocks.** Local is `Date.now()`, remote is
  the server's ISO time parsed back. The source comment documents it and the
  downside is bounded: resume a turn or two earlier, never a corrupt brief.
- **The rate limiter fails open, completely.** If Blobs writes fail persistently
  the limiter stops limiting rather than blocking clients. That is the intended
  posture; the tradeoff is that a write outage silently disables the control
  while reads still succeed.
- **~26s worst case before a failing backend surfaces an error** (one silent
  retry, sync→background fallback, 6 attempts with exponential backoff). A single
  flaky request resolves in ~600ms; the rotating "thinking" copy stops it looking
  frozen.
- **Mobile welcome screen needs ~1.2 screens of scroll.** Normal web behaviour.
- **Inter, and the Hootsuite mint/cherry palette, are deliberate.** Automated
  design tooling flags them as generic. They are brand constraints and they keep
  the Sales page and the chat reading as one product. Defend, don't change.

---

## Method notes

- **Verify a defect reproduces in the real environment before fixing it.** One
  earlier finding ("Start button below the fold") was measured at a viewport
  chosen by the agent and did not reproduce on the owner's actual monitor. The
  fix built for it was reverted.
- **When a test fails, work out whether the code or the test is wrong.** Several
  failures in this repo's history were bad assertions against correct code:
  fixed-character-window slices that broke when a guard was added above them,
  and index comparisons that spanned two unrelated branches of the same file.
  Widen the scope properly; do not weaken the assertion.
- **Match behaviour, not identifiers.** Two tests once broke on a pure rename.
- **React batching hides guards.** Firing N clicks in a synchronous loop tests
  nothing real. Space them out.
- **Check the branch before you build on it.** Work here has landed on
  `claude/conversation-quality-testing-akreag` as well as `main`. A local branch
  29 commits behind its own remote produced an afternoon of fixes against a file
  that had already grown by 200 lines.

---

## Rollback

Recent work is one commit per theme with a detailed message; `git log` is the
real record and is more specific than this file. `git revert <sha>` per theme.
Note that all client changes live in `src/lumen.jsx` and all Sales changes in
`public/sales.html`, so a revert takes that whole theme with it.
