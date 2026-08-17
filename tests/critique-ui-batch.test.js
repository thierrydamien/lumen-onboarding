// The UI batch from the design critique of the client chat.
//
// Everything here was verified by driving the real bundle in a browser first. Two
// of the checks are shaped by the harness's limits rather than by preference: the
// browser pane does not composite, so CSS transitions freeze at zero progress and
// `resize_window` fires no resize event. Both made a working fix look broken. Where
// a claim can only be observed with those out of the way, the test asserts the
// mechanism instead of the pixels.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
const code = decomment(src);

// WCAG relative luminance / contrast, so the thresholds are asserted not eyeballed.
const lum = h => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };

describe("the muted text role clears AA everywhere it is used", () => {
  // Seven distinct text roles failed, all the same token, all near-misses:
  // 3.80 on the finish card's gradient, 4.20 on the panel, 4.34 in the modal,
  // 4.45 on the page background, 4.76 on white.
  const SURFACES = {
    "finish-card gradient (darkest stop)": "#e3e6ea",
    "panel hi": "#f1f0f7",
    "modal slate-100": "#f1f5f9",
    "page background": "#f7f7fa",
    "card white": "#ffffff",
  };
  it("uses the darkened token, not the old one", () => {
    expect(code).toMatch(/muted:"#556377"/);
    expect(src).not.toMatch(/#64748b/);
  });
  for (const [name, bg] of Object.entries(SURFACES)) {
    it(`clears 4.5:1 on the ${name}`, () => {
      expect(contrast("#556377", bg)).toBeGreaterThanOrEqual(4.5);
    });
  }
  it("stays lighter than the primary text colour, so it is still a secondary role", () => {
    expect(lum("#556377")).toBeGreaterThan(lum("#1e293b"));
  });
  it("darkens the error-pill text too, without touching any background fill", () => {
    expect(contrast("#b91c1c", "#fef2f2")).toBeGreaterThanOrEqual(4.5);
    expect(code).not.toMatch(/color:"#dc2626"/);
  });
});

describe("placeholders are styled rather than left to the browser", () => {
  it("declares a ::placeholder colour for both themes", () => {
    // There was no rule at all, so every field fell back to Chrome's UA default,
    // measured #757575 — 4.31:1 on the page background. The composer's placeholder
    // is instruction text ("Answer above — or just type it here"), not decoration.
    expect(src).toMatch(/::placeholder\{color:#556377;opacity:1\}/);
    expect(src).toMatch(/\[data-theme="dark"\] ::placeholder\{color:#8aa4c1;opacity:1\}/);
  });
  it("sets opacity explicitly, because Firefox dims placeholders by default", () => {
    expect(src.match(/::placeholder\{[^}]*opacity:1[^}]*\}/g) || []).toHaveLength(2);
  });
  it("actually publishes the theme as an attribute the stylesheet can read", () => {
    // Everything else themes through inline styles from C, which CSS cannot reach —
    // so without this the dark placeholder rule would never match anything.
    expect(code).toMatch(/document\.documentElement\.setAttribute\("data-theme", dark \? "dark" : "light"\)/);
  });
});

describe("the topic card no longer clips the query it asks you to approve", () => {
  const card = code.slice(code.indexOf("function TopicCards"), code.indexOf("function TopicCards") + 5200);
  it("holds keywords in a textarea, not a single-line input", () => {
    // Measured before: a real query was 406px of content in a 326px input, and a
    // category card 472px — clipped mid-expression with no wrap and no title.
    expect(card).toMatch(/<textarea value=\{c\.keywords\}/);
    expect(card).not.toMatch(/<input value=\{c\.keywords\}/);
  });
  it("wraps and grows instead of scrolling", () => {
    expect(card).toMatch(/whiteSpace:"pre-wrap"/);
    expect(card).toMatch(/autoGrow\(e\.target\)/);
    expect(code).toMatch(/function autoGrow\(el\)/);
    expect(code).toMatch(/el\.style\.height = el\.scrollHeight \+ "px"/);
  });
  it("carries a real label, so the accessible name is not the placeholder", () => {
    expect(card).toMatch(/aria-label=\{WL\("keywordsLbl",lang\)\}/);
    expect(card).toMatch(/aria-label=\{WL\("topicNameLbl",lang\)\}/);
    expect(card.match(/<label/g) || []).toHaveLength(2);
  });
  it("promotes the rationale and drops the italic", () => {
    // It is the only thing that lets a client judge whether a topic is right, and it
    // was the smallest, faintest text on the card.
    expect(card).toMatch(/\{c\.rationale && <div style=\{\{fontSize:12/);
    const rationale = card.slice(card.indexOf("{c.rationale &&"), card.indexOf("{c.rationale &&") + 140);
    expect(rationale).not.toMatch(/fontStyle:"italic"/);
  });
  it("shows the priority order it tells the client to set", () => {
    expect(card).toMatch(/kept\.indexOf\(c\)\+1/);
  });
  it("drops the tick, which could never do anything on arrival", () => {
    // Every card seeds as kept and the ✕ already toggled both ways, so ✓ was a fifth
    // per-card control that was dead on sight.
    expect(card).not.toMatch(/setSt\(i,"kept"\)/);
    expect(card).toMatch(/setSt\(i,c\.status==="discarded"\?"kept":"discarded"\)/);
  });
  it("localises every per-card control", () => {
    expect(card).not.toMatch(/aria-label="(Move|Keep|Discard)/);
    expect(card).toMatch(/WL\(c\.status==="discarded"\?"restoreTopic":"discardTopic",lang,\{name:/);
  });
  it("gives WL the interpolation it needs for those labels", () => {
    expect(code).toMatch(/function WL\(key, lang, vars\)/);
    // Counted inside the WI18N table only. A whole-file count reads 7, because the
    // call site `?"restoreTopic":"discardTopic"` literally contains `"restoreTopic":"`
    // — the first version of this test failed against correct code for that reason.
    const wi18n = src.slice(src.indexOf("const WI18N"), src.indexOf("function WL("));
    for (const k of ["topicNameLbl", "keywordsLbl", "discardTopic", "restoreTopic"]) {
      expect(wi18n.match(new RegExp(`"${k}":"`, "g")) || [], `${k} in all 6 languages`).toHaveLength(6);
    }
  });
});

describe("shrinking the window cannot strand content off-screen", () => {
  it("closes the panel below the side-column breakpoint", () => {
    // showPanel was seeded at mount and never revisited. Measured 1280 -> 768: the
    // 320px panel stayed display:block, the column went to left:-96, 10 elements sat
    // off the left edge, and scrollWidth === clientWidth so nothing could scroll to
    // them. Verified fixed with transitions disabled (they freeze in a pane that is
    // not compositing, which left the old transform on screen and looked unfixed).
    expect(code).toMatch(/useEffect\(\(\) => \{ if \(ww < SIDE_COL_MIN\) setShowPanel\(false\); \}, \[ww\]\);/);
  });
  it("does not force it back open on the way up", () => {
    // Above the breakpoint the panel is the client's own toggle.
    const eff = code.slice(code.indexOf("if (ww < SIDE_COL_MIN) setShowPanel(false)"));
    expect(eff.slice(0, 120)).not.toMatch(/setShowPanel\(true\)/);
  });
});

describe("the page is navigable by landmark and heading", () => {
  it("wraps the transcript in main and the top bar in header", () => {
    expect(code).toMatch(/<main ref=\{msgRef\}/);
    expect(code).toMatch(/<\/main>/);
    expect(code).toMatch(/<header ref=\{headerRef\}/);
    expect(code).toMatch(/<\/header>/);
  });
  it("makes the captured-answers panel a labelled complementary region", () => {
    expect(code).toMatch(/<aside aria-label=\{L\("panelTitle",uiLang\)\}/);
    expect(code).toMatch(/<\/aside>\}/);
    // pnlCaptured does not exist in I18N; using it rendered an empty label.
    expect(code).not.toMatch(/L\("pnlCaptured"/);
  });
  it("gives the document a top-level heading and the panel its own", () => {
    expect(code).toMatch(/<h1 style=\{\{position:"absolute"[^>]*\}\}>\{L\("a11yPageTitle",uiLang\)\}<\/h1>/);
    expect(code).toMatch(/<h2 style=\{\{fontWeight:700,fontSize:14/);
  });
  it("exposes the stepper as a progressbar on BOTH variants", () => {
    // Only the mobile branch was patched first; desktop is the one that renders at
    // 1440 and still had no role, so the check caught a half-done fix.
    expect(code.match(/role="progressbar"/g) || []).toHaveLength(2);
    expect(code).toMatch(/aria-valuenow=\{pct\}/);
    expect(code).toMatch(/aria-valuenow=\{deskPct\}/);
  });
  it("announces the two failure surfaces that were silent", () => {
    expect(code).toMatch(/\{retryMsg && !loading && <div role="alert"/);
    expect(code.match(/\{sendErr && <div role="alert"/g) || []).toHaveLength(2);
  });
  it("leaves no hardcoded English accessible name", () => {
    expect(code).not.toMatch(/aria-label="Send message"/);
    expect(code).not.toMatch(/aria-label=\{sound\?"Turn/);
    expect(code).not.toMatch(/aria-label=\{dark\?"Switch/);
    for (const k of ["a11ySend", "a11ySoundOn", "a11ySoundOff", "a11yDarkMode", "a11yLightMode", "a11yPageTitle"]) {
      expect(src.match(new RegExp(`${k}: *"`, "g")) || [], `${k} in all 6 languages`).toHaveLength(6);
    }
    expect(src.match(/"a11yProgress":"/g) || []).toHaveLength(6);
  });
});

describe("Arabic is mirrored, not flattened", () => {
  it("swaps the bubble tail rather than removing it", () => {
    // A uniform 14 dropped the asymmetry that distinguishes assistant from client —
    // the one cue that survives when you cannot read the language.
    expect(code).toMatch(/borderRadius:uiLang==="Arabic"\s*\?\(m\.role==="assistant"\?"14px 4px 14px 14px":"4px 14px 14px 14px"\)/);
    expect(code).not.toMatch(/borderRadius:uiLang==="Arabic"\?14:/);
  });
  it("declines synthesised obliques for RTL", () => {
    // Arabic has no italic face, so the browser shears the glyphs and it reads as
    // broken rendering. One rule beats a conditional at eight call sites.
    expect(src).toMatch(/\[dir="rtl"\],\[dir="rtl"\] \*\{font-synthesis-style:none\}/);
  });
});

describe("the review modal shows what it claims to show", () => {
  it("opens the sections that have content", () => {
    // "Everything you've shared, in one place" sat above four COLLAPSED rows, so the
    // send decision was made from memory.
    const modal = code.slice(code.indexOf('<Section title={L("expSecBusiness"'), code.indexOf('<Section title={L("expSecReports"') + 200);
    expect(modal).toMatch(/expSecBusiness",uiLang\)\} defaultOpen=\{true\}/);
    expect(modal).toMatch(/expSecTeam",uiLang\)\} badge=\{users\.length\} defaultOpen=\{true\}/);
    expect(modal).toMatch(/expSecTrack",uiLang\)\} badge=\{topics\.length\} defaultOpen=\{true\}/);
    expect(modal).toMatch(/expSecLook",uiLang\)\} badge=\{chans\.length\} defaultOpen=\{chans\.length>0\}/);
    expect(modal).not.toMatch(/defaultOpen=\{false\}/);
  });
  it("makes Keep going the primary action and Send it anyway the quiet one", () => {
    // The incomplete path had the strongest affordance in the modal.
    const step = code.slice(code.indexOf("(!ready && confirmSend)"), code.indexOf("(!ready && confirmSend)") + 2200);
    const keep = step.indexOf('L("expKeepGoing",uiLang)');
    const anyway = step.indexOf('L("expSendAnyway",uiLang)');
    expect(keep).toBeGreaterThan(-1);
    expect(anyway).toBeGreaterThan(-1);
    // Keep going now carries the filled treatment; Send it anyway carries the border one.
    expect(step.slice(step.lastIndexOf("<button", keep), keep)).toMatch(/background:A,color:"white"/);
    expect(step.slice(step.lastIndexOf("<button", anyway), anyway)).toMatch(/background:"transparent"/);
  });
  it("keeps Download reachable on the confirm step", () => {
    // It used to vanish there, so the one moment a send could fail was the one moment
    // the client could not keep a copy of their own answers.
    const step = code.slice(code.indexOf("(!ready && confirmSend)"), code.indexOf("(!ready && confirmSend)") + 2200);
    expect(step).toMatch(/L\("expDownload",uiLang\)/);
  });
});

describe("the smaller defects", () => {
  it("hides the stepper once the brief is sent", () => {
    // On reload the receipt rendered under "Step 1 of 6 · About you · 0%", directly
    // contradicting the finish card below it.
    expect(code).toMatch(/\{started && !sent && <div style=\{\{background:C\.card,borderBottom/);
  });
  it("anchors a short transcript near the composer without breaking scroll", () => {
    // ~350px of dead canvas at 1280x720. Done with an auto-margin spacer, NOT
    // justify-content:flex-end, which on a scroll container makes overflowing content
    // unreachable at the start edge — verified scrollTop can still return to 0.
    expect(code).toMatch(/<div aria-hidden="true" style=\{\{marginTop:"auto"\}\}\/>/);
    const main = code.slice(code.indexOf("<main ref={msgRef}"), code.indexOf("<main ref={msgRef}") + 400);
    expect(main).not.toMatch(/justifyContent:"flex-end"/);
    expect(main).toMatch(/display:"flex",flexDirection:"column",minHeight:0/);
  });
});
