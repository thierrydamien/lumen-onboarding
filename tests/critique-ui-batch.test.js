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
    // color:"white" became var(--wc-on-accent) in the dark-mode refactor; the point of
    // the assertion is which button carries the FILLED treatment, not the literal.
    expect(step.slice(step.lastIndexOf("<button", keep), keep)).toMatch(/background:A,color:"var\(--wc-on-accent\)"/);
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
  it("lays the transcript out top-down, like every other chat client", () => {
    // The "dead canvas" finding (~350px of empty space below an opening turn at
    // 1280x720) was first answered by pinning the conversation to the BOTTOM with a
    // leading margin-top:auto spacer. On the deployed site with a real first message
    // that only moved the empty space above the text, leaving the greeting floating
    // mid-column under the stepper — worse than the gap it replaced. iMessage,
    // WhatsApp, Slack, Teams and Messenger all anchor from the top.
    //
    // Following the newest message is a SCROLL concern and is handled separately (the
    // wheel/touch/key intent tracking). This test exists to stop the spacer coming
    // back as a "fix" for sparseness.
    // Scoped to <main>'s OWN opening tag. A fixed-length slice runs into the welcome
    // screen child, which is legitimately a flex column, and the assertion then fails
    // against correct code.
    const from = code.indexOf("<main ref={msgRef}");
    const mainTag = code.slice(from, code.indexOf(">", from));
    expect(code).not.toMatch(/marginTop:"auto"/);
    expect(mainTag).not.toMatch(/justifyContent:"flex-end"/);
    expect(mainTag).not.toMatch(/flexDirection:"column"/);
  });
});

describe("dark mode reaches the widgets and the review modal", () => {
  // The five in-conversation widgets and the review modal were written with hardcoded
  // light colours and take no theme prop, so in dark mode they rendered as bright
  // islands and the modal was a full-white flash at the send moment. 202 colour
  // references across six components. They cannot read the C object (that is inline
  // styles in the app shell), so the theme reaches them as custom properties.
  const COMPONENTS = ["ChipSelector", "RankedSelector", "UserForm", "TopicCards", "QueriesWidget", "ExportModal"];
  const bodyOf = name => {
    const a = code.indexOf(`function ${name}(`);
    const rest = code.slice(a + 10);
    const m = rest.search(/\n(?:export )?function /);
    return code.slice(a, m === -1 ? undefined : a + 10 + m);
  };

  it("defines the palette for both themes", () => {
    expect(src).toMatch(/--wc-border:#e2e8f0;/);
    expect(src).toMatch(/\[data-theme="dark"\]\{/);
    expect(src).toMatch(/--wc-border:#5a7899;/);
  });

  it("keeps every light value byte-identical to what was hardcoded before", () => {
    // The safety property of the whole refactor: light mode cannot shift, only dark
    // gains anything. Verified in a browser too — field bg, border and heading all
    // still resolve to their pre-refactor values.
    const rootBlock = src.slice(src.indexOf(":root{"), src.indexOf('[data-theme="dark"]{'));
    for (const [v, hex] of [["--wc-border", "#e2e8f0"], ["--wc-muted", "#556377"], ["--wc-text", "#1e293b"],
                            ["--wc-surface", "#ffffff"], ["--wc-heading", "#012B3A"], ["--wc-warn-text", "#92400e"]]) {
      expect(rootBlock, `${v} light value`).toContain(`${v}:${hex};`);
    }
  });

  it("leaves no hardcoded light colour inside those six components", () => {
    for (const name of COMPONENTS) {
      const body = bodyOf(name);
      expect(body.match(/#[0-9a-fA-F]{6}/g) || [], `${name} still has hex colours`).toHaveLength(0);
      expect(body, `${name} still has a bare "white"`).not.toMatch(/"white"/);
    }
  });

  it("keeps white button text white, rather than folding it into the surface role", () => {
    // color:"white" meant white ON a coloured fill. Mapping it to --wc-surface turned
    // every primary button's label dark-on-purple in dark mode — caught in the browser.
    expect(src).toMatch(/--wc-on-accent:#ffffff;/);
    expect(src.match(/--wc-on-accent:#ffffff;/g) || []).toHaveLength(2); // same in both themes
    expect(code).not.toMatch(/color:"var\(--wc-surface\)"/);
  });

  it("gives the primary action a boundary without losing its text contrast", () => {
    // Dark Teal on the dark bubble measured 1.12:1. The fill carries white text at
    // 5.7:1 and a separate edge carries the 3:1 boundary at 6.11:1.
    expect(src).toMatch(/--wc-accent:#7C3AED;/);
    expect(src).toMatch(/--wc-accent-edge:#a78bfa;/);
    expect(contrast("#ffffff", "#7C3AED")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#a78bfa", "#111f30")).toBeGreaterThanOrEqual(3);
  });

  it("shows the accent edge only while the button is enabled", () => {
    // Applying it unconditionally made the DISABLED button read as interactive.
    //
    // This asserted the invariant by banning one literal character sequence, which
    // also failed an always-enabled button that legitimately needs a constant edge
    // (the review modal's Confirm). Per this repo's handover: match the BEHAVIOUR,
    // not a string. The real rule is narrower — a button that can be disabled must
    // gate its edge on that same condition — so check exactly those buttons.
    const withEdge = code
      .split("\n")
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => line.includes("--wc-accent-edge"));
    expect(withEdge.length, "no accent-edge buttons found — the sweep is checking nothing").toBeGreaterThan(0);

    const canBeDisabled = withEdge.filter(({ line }) => /disabled=\{/.test(line));
    expect(canBeDisabled.length, "no disableable accent buttons — has the pattern moved?").toBeGreaterThan(0);
    for (const { line, n } of canBeDisabled) {
      expect(line, `line ${n}: a disableable button applies the accent edge unconditionally, so it reads as interactive while disabled`)
        .toMatch(/border:[^,]+\?"1px solid var\(--wc-accent-edge\)":"1px solid var\(--wc-border\)"/);
    }
  });

  it("leaves no light-mode literal anywhere in the review modal subtree", () => {
    // The first pass migrated the modal itself but missed two components rendered
    // INSIDE it (Section's count badge, PasteImport entirely) and two controls that
    // set a colour inline. Inline wins over the input/select safety-net rule below,
    // so the reports <select> kept background:"#fff" while its text went light —
    // near-invisible. Sweep the whole subtree rather than re-listing single lines.
    const region = (from, to) => {
      const a = src.indexOf(from);
      expect(a, `anchor not found: ${from}`).toBeGreaterThan(-1);
      return src.slice(a, src.indexOf(to, a));
    };
    const subtree = [
      region("function Section({", "function PasteImport({"),
      region("function PasteImport({", "const URL_RE"),
      region("function ExportModal({", "function FinishCard({"),
    ].join("\n");
    // Hex literals and bare "white"/"black" in style values. The modal scrim is the
    // one legitimate rgba() — it is a scrim in both themes — so hex only.
    const literals = subtree.match(/(?:background|color|borderColor):\s*"#[0-9a-fA-F]{3,8}"|(?:background|color):\s*"(?:white|black)"/g) || [];
    expect(literals, `light-mode literals left in the review modal: ${literals.join(", ")}`).toEqual([]);
    // Dark Teal as a FILL is the same 1.12:1 case --wc-accent exists for, and `P`
    // is an identifier so the hex sweep above cannot see it.
    expect(subtree).not.toMatch(/background:\s*P\b/);
  });

  it("keeps the new tint as subtle in dark as the light value it replaces", () => {
    // #faf8ff had no existing counterpart and reusing --wc-accent-soft (#ede9fe)
    // would have shifted light mode, so this is a new pair. A dark value chosen by
    // eye tends to land as a slab; match the light subtlety instead.
    expect(src).toMatch(/--wc-accent-tint:#faf8ff;/);
    expect(src).toMatch(/--wc-accent-tint:#241c3d;/);
    expect(contrast("#faf8ff", "#ffffff")).toBeLessThan(1.1);   // barely there in light
    expect(contrast("#241c3d", "#16283c")).toBeLessThan(1.1);   // and in dark
    expect(contrast("#8aa4c1", "#241c3d")).toBeGreaterThanOrEqual(4.5); // muted label
    expect(contrast("#c8d8e8", "#241c3d")).toBeGreaterThanOrEqual(4.5); // textarea text
  });

  it("gives fields a background instead of inheriting the UA white", () => {
    // Fields with no background of their own fell back to Chrome's white: invisible in
    // light mode, a wall of glaring white boxes in the dark modal.
    expect(src).toMatch(/input,textarea,select\{background:var\(--wc-surface\)\}/);
  });

  it("measures the dark values rather than guessing them", () => {
    const S = "#16283c", BUBBLE = "#111f30";
    expect(contrast("#c8d8e8", S)).toBeGreaterThanOrEqual(4.5);   // body text
    expect(contrast("#8aa4c1", S)).toBeGreaterThanOrEqual(4.5);   // muted
    expect(contrast("#5a7899", S)).toBeGreaterThanOrEqual(3);     // control border, SC 1.4.11
    expect(contrast("#86efac", "#13301f")).toBeGreaterThanOrEqual(4.5); // ok text
    expect(contrast("#fca5a5", "#3a1618")).toBeGreaterThanOrEqual(4.5); // danger text
    expect(contrast("#fcd34d", "#3a2f14")).toBeGreaterThanOrEqual(4.5); // warning text
    expect(contrast("#c8d8e8", BUBBLE)).toBeGreaterThanOrEqual(4.5);    // heading on the bubble
  });
});
