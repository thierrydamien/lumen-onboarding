# Browser harness

Drives the **real built bundle** in a real Chromium, with the network stubbed, so
the class of bug that only exists in a browser is reachable: in-flight timing,
viewport and rotation, focus, and anything where the question is "what does the
client actually see right now".

The unit tests in `tests/` cover pure logic. `tools/live-convo.mjs` covers the
real model. This covers the third thing neither can: the rendered UI over time.

## Why it exists

`onWSubmit` has always bailed while a turn is in flight — correctly, so a second
user turn can't be queued. But it bailed *silently*, and the widget went on
rendering Confirm at full opacity with a pointer cursor. Nothing short of a real
browser shows you that: the guard looks right in the source, and the rendered
control looks alive. Measured here, the styling was byte-identical to idle.

## Setup

```bash
npm run build
rm -rf /tmp/h && mkdir -p /tmp/h
cp -R dist/* /tmp/h/ && cp public/*.png /tmp/h/ && cp tools/browser-harness/stub.js /tmp/h/
node -e 'const fs=require("fs");let h=fs.readFileSync("public/chat.html","utf8");
h=h.replace(/<script type="module"/,"<script src=\"/stub.js\"></script>\n<script type=\"module\"");
fs.writeFileSync("/tmp/h/index.html",h);'
(cd /tmp/h && python3 -m http.server 9100 &)

npm i --no-save playwright-core     # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 if needed
node tools/browser-harness/t-widget-inflight.mjs
```

`drive.mjs` points `executablePath` at the Chromium already on the image. If you
run this elsewhere, change that line or drop it to use a downloaded browser.

## Two things that will waste your afternoon

1. **Write `stub.js` as a real file loaded with `<script src>`.** Inlining it into
   the HTML means nested escaping (`\\"` vs `\"`) and it fails to parse silently —
   you end up debugging the app instead of your stub.

2. **The client is SYNC-FIRST.** `src/lumen.jsx` tries `/functions/chat` and only
   falls back to `chat-background` + `chat-status` on failure. Stub the
   synchronous endpoint or nothing you do to the background path matters. This
   also means `hang` must stay *releasable* — a bare never-settling promise wedges
   the tab and makes `__ctl.releaseAll()` a lie, which reads exactly like an app
   bug that isn't one. That cost an hour; the fix is in `stub.js`.

## `window.__ctl`

Flip failure modes mid-session from the driver, no rebuild:

| field | values | effect |
|---|---|---|
| `chatMode` | `ok` `hang` `http500` `malformed` | `hang` holds the turn in flight until you set it back to `ok` |
| `draftSave` | `ok` `fail` | make the draft POST fail (does "Progress saved" still appear?) |
| `sessionUpsert` | `ok` `fail` | dashboard upsert failure |
| `sheet` | `ok` `fail` | Sheet generation failure |
| `replies` | `string[]` | queue exact raw assistant replies, markers and all |
| `calls` | `[]` | every request the app made, for assertions |
| `releaseAll()` | — | release everything held by `hang` |

Queue a reply verbatim to stage any UI state, e.g.:

```js
await page.evaluate(() => { window.__ctl.replies = [
  '%%PROGRESS%%{"section":"topics","percent":40,"collected":{}}%%END%%\n\nPick your markets.\n\n[WIDGET:MARKETS]',
]; });
```

## The Sales page (`sales-stub.js`)

`public/sales.html` is a plain static page, so it needs no build — copy it, inject
the stub, serve it. It found nine defects on its first pass, including a link that
could be generated under one service package and revealed under another.

Copy `google-gate.js` across too. Without it the page throws
`LumenGoogleGate is not defined` and Generate silently does nothing — which reads
exactly like the bug you are hunting.

```bash
rm -rf /tmp/s && mkdir -p /tmp/s
cp public/sales.html /tmp/s/index.html
cp public/*.png public/media-brief-template.xlsx public/google-gate.js /tmp/s/
cp -R public/fonts /tmp/s/
cp tools/browser-harness/sales-stub.js /tmp/s/stub.js
node -e 'const fs=require("fs");let h=fs.readFileSync("/tmp/s/index.html","utf8");
h=h.replace("<script>\n  // The client chat lives at",
  "<script src=\"/stub.js\"></script>\n<script>\n  // The client chat lives at");
fs.writeFileSync("/tmp/s/index.html",h);'
(cd /tmp/s && python3 -m http.server 9200 &)
```

Its `window.__ctl` covers the three endpoints the page calls:

| field | values |
|---|---|
| `seed` | `ok` `slow` `http500` `http401` `http403` `badjson` `noid` `network` |
| `parseBrief` | `ok` `slow` `http401` `err:<code>` |
| `previewBrief` | `ok` `slow` `http401` `http500` |
| `duplicates` | what the seed POST reports back, to drive the duplicate-client note |
| `seedBodies` | the exact seed objects POSTed — this is how the wrong-package bug was caught |

**Read state from `classList`, not from computed style.** The panel reveal is a
CSS transition, and a browser pane that is not compositing (hidden, backgrounded)
freezes transitions at zero progress, so `getComputedStyle` reports the collapsed
values forever while the class is correctly applied. That cost an hour and looks
exactly like a cascade bug that isn't one. It is also why the link panel now uses
`inert` rather than transitioned `visibility` — the a11y state must not depend on
an animation running.

## Still worth writing

Composer height after rotation, stepper alignment while the chat column
translates 160px, `pickDraft`'s two clocks, "Progress saved" with `draftSave:
"fail"`, and closing the review modal mid-send. All are reachable from here.
