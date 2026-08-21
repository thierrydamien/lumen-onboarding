// Three things the dashboard could not previously answer.
//
// It already had duration, completion, stall detection, per-call token metering and
// content counts. What it could not tell you: WHERE a session stopped (percent is a
// model-reported number and cannot name the question), which LANGUAGE it ran in
// (uiLang was referenced 195 times in the client and zero times in session.js), and
// whether clients skip questions at all — the measurement that decides whether the
// skip-handling prompt rule is worth writing, since a live probe showed a skip gets
// 0% help offered.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
const server = readFileSync(new URL("../netlify/functions/session.js", import.meta.url), "utf8");
const dash = readFileSync(new URL("../public/dashboard.html", import.meta.url), "utf8");

describe("the client sends all three, on both upserts", () => {
  // Both matter: the in-progress upsert is the ONLY one an abandoned session ever
  // writes, so a drop-off point that were only sent on completion would be recorded
  // exclusively for sessions that did not drop off.
  const upserts = [...client.matchAll(/section: furthestSection\(progress\),\s*\n\s*uiLang,\s*\n\s*skips: \[\.\.\.skipsRef\.current\],/g)];
  it("attaches section, uiLang and skips to the in-progress AND completed records", () => {
    expect(upserts).toHaveLength(2);
  });
  it("counts a skip where skips actually happen", () => {
    const fn = client.slice(client.indexOf("const onWSkip = useCallback"), client.indexOf("const onWSkip = useCallback") + 700);
    expect(fn).toMatch(/skipsRef\.current = \[\.\.\.skipsRef\.current, type\]/);
    expect(client).toMatch(/const skipsRef = useRef\(\[\]\)/);
  });
  it("copies the skip list rather than sending the live ref", () => {
    // Sending skipsRef.current directly would hand a mutable array to a payload that
    // is serialised later, and the debounced autosave means "later" is not immediate.
    expect(client).toMatch(/skips: \[\.\.\.skipsRef\.current\]/);
  });
});

describe("the drop-off point is a frontier, not the raw section", () => {
  const fn = client.slice(client.indexOf("function furthestSection"), client.indexOf("function furthestSection") + 600);
  it("takes the furthest of reported section and collected map", () => {
    // The model's `collected` map arrives non-monotonic — the same reason Stepper
    // derives a frontier — so progress.section can go backwards and would misreport
    // where a client stopped.
    expect(fn).toMatch(/SECTION_KEYS\.indexOf\(progress\.section\)/);
    expect(fn).toMatch(/collectedMax/);
    expect(fn).toMatch(/Math\.max\(cur, collectedMax, 0\)/);
  });
  it("survives a missing progress object", () => {
    expect(fn).toMatch(/if \(!progress\) return null/);
  });
});

describe("the server validates them instead of trusting the client", () => {
  // The record is client-POSTed and lands in a dashboard that builds HTML, so a
  // free-text field is an XSS sink and an unbounded array is unbounded storage. The
  // existing `status` field is whitelisted and apiCalls coerced for the same reason.
  it("whitelists section and language against fixed sets", () => {
    expect(server).toMatch(/const SECTIONS = \["company", "path", "topics", "channels", "reports", "users"\]/);
    expect(server).toMatch(/const UI_LANGS = \["English", "French", "German", "Spanish", "Italian", "Arabic"\]/);
    expect(server).toMatch(/section: oneOf\(r\.section, SECTIONS\)/);
    expect(server).toMatch(/uiLang: oneOf\(r\.uiLang, UI_LANGS\)/);
  });
  it("rejects anything not in the set rather than passing it through", () => {
    expect(server).toMatch(/const oneOf = \(v, allowed\) => \(typeof v === "string" && allowed\.includes\(v\) \? v : null\)/);
  });
  it("filters the skip list to known widgets AND bounds its length", () => {
    // Without the cap a client could post thousands of entries into the blob store.
    expect(server).toMatch(/const skipsOf = \(v\) => \(Array\.isArray\(v\) \? v\.filter\(\(x\) => WIDGETS\.includes\(x\)\)\.slice\(0, 20\) : \[\]\)/);
    expect(server).toMatch(/skips: skipsOf\(r\.skips\)/);
  });
  it("keeps the section whitelist in step with the client's own list", () => {
    const clientKeys = client.match(/const SECTION_KEYS\s*=\s*\[([^\]]*)\]/)[1];
    const clientSet = [...clientKeys.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    const serverKeys = server.match(/const SECTIONS = \[([^\]]*)\]/)[1];
    const serverSet = [...serverKeys.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    expect(serverSet).toEqual(clientSet);
  });
  it("keeps the language whitelist in step with the languages actually offered", () => {
    const offered = [...client.matchAll(/\{\s*code:\s*"([^"]+)"/g)].map(m => m[1]);
    const serverLangs = server.match(/const UI_LANGS = \[([^\]]*)\]/)[1];
    const serverSet = [...serverLangs.matchAll(/"([^"]+)"/g)].map(m => m[1]);
    if (offered.length) for (const l of offered) expect(serverSet, `${l} missing from the server whitelist`).toContain(l);
    else expect(serverSet).toHaveLength(6);
  });
});

describe("the dashboard turns them into something actionable", () => {
  it("names the step that loses people, not a percentage", () => {
    // "median 62%" says how far people get; it never says which question stopped them.
    expect(dash).toMatch(/var SECTION_LABELS = \{ company: "About you"/);
    expect(dash).toMatch(/top drop-off of " \+ unfinished\.length \+ " unfinished/);
  });
  it("counts drop-off over unfinished sessions only", () => {
    // A completed session has no drop-off point; including it would dilute the signal.
    expect(dash).toMatch(/real\.filter\(function \(s\) \{ return s\.status !== "completed" && s\.section; \}\)/);
  });
  it("feeds the language into the EXISTING filter rather than adding a tile", () => {
    // A dedicated "completion by language" tile was written and then removed. The
    // dashboard already has a language dropdown and a clickable "By language used"
    // chart, so filtering to French already recalculates the completed tile — and does
    // it composably with every other filter, which a fixed tile cannot. Verified in a
    // browser: English 67%, French 33%, Arabic 0%, drop-off recalculating alongside.
    expect(dash).not.toMatch(/completion by language/);
    expect(dash).not.toMatch(/lowest completion, by language/);
    expect(dash).not.toMatch(/LANG_MIN_N/);
  });

  it("prefers the language actually used over the one Sales seeded", () => {
    // s.lang came only from the seed, i.e. what Sales picked. The welcome-back screen
    // lets a client change language after starting, so the two genuinely diverge — and
    // a session whose seed was archived had no language at all, because s.lang was only
    // assigned inside the `if (m)` seed-match branch.
    const i = dash.indexOf("if (m) { if (m.owner) s.owner = m.owner;");
    expect(dash.slice(i, i + 900)).toMatch(/if \(s\.uiLang\) s\.lang = s\.uiLang;/);
    expect(dash).toMatch(/By language used/);
  });

  it("shows which widget gets skipped, not just how often", () => {
    expect(dash).toMatch(/sessions that skipped a question/);
    expect(dash).toMatch(/topSkip/);
  });
  it("escapes the new values like every other tile", () => {
    // They originate from a client POST. The whitelists make them safe, but the tile
    // renderer must not be the only thing standing between the two.
    expect(dash).toMatch(/'<div class="kpi"><div class="v">' \+ esc\(k\[0\]\) \+ '<\/div><div class="l">' \+ esc\(k\[1\]\)/);
  });
});

describe("the new dimensions are filterable, not just countable", () => {
  // A tile says "75% of drop-offs are at What to track". The filter is what turns that
  // into "show me those three and let me nudge them", composed with owner, package,
  // language and date. Verified in a browser against a 10-session fixture: section
  // topics = C,D,G; users = A,B,F,H; skipped-objectives = B,C,D; and section+skip
  // together = C,D.
  const REGISTRATION_POINTS = [
    // Every place a dimension has to be declared for it to actually work. The list is
    // the point: "Stopped at" and "Skips" rendered, counted toward the More-filters
    // badge, and had chips whose × silently did nothing, because clearFilter kept its
    // own separate defaults map and was missed.
    [/section: "all", skipped: "all"/, "defaultFilter"],
    [/sectionMap = \{\}, skipMap = \{\}/, "option maps declared"],
    [/if \(s\.section\) sectionMap\[s\.section\] = 1;/, "section map populated"],
    [/\(s\.skips \|\| \[\]\)\.forEach\(function \(w\) \{ skipMap\[w\] = 1; \}\);/, "skip map populated"],
    [/sel\("fSection", "Stopped at", sectionOpts, FILTER\.section\)/, "section control"],
    [/sel\("fSkipped", "Skips", skipOpts, FILTER\.skipped\)/, "skips control"],
    [/\$\("fSection"\)\.addEventListener\("change"/, "section handler"],
    [/\$\("fSkipped"\)\.addEventListener\("change"/, "skips handler"],
    [/except !== "section" && FILTER\.section/, "section applied in getFilteredList"],
    [/except !== "skipped" && FILTER\.skipped/, "skips applied in getFilteredList"],
    [/d\.push\("section"\)/, "section in activeFilterDims"],
    [/d\.push\("skipped"\)/, "skips in activeFilterDims"],
    [/dim === "section"\) return "Stopped at: "/, "section chip label"],
    [/dim === "skipped"\) return "Skips: "/, "skips chip label"],
    [/SECONDARY_DIMS = \["minPct", "owner", "pkg", "lang", "section", "skipped", "dateFrom", "dateTo"\]/, "SECONDARY_DIMS"],
  ];
  for (const [re, label] of REGISTRATION_POINTS) {
    it(`registers the dimension: ${label}`, () => expect(dash).toMatch(re));
  }

  it("clears a single dimension from one source of truth, not a second list", () => {
    // clearFilter used to hold its own hand-written defaults. Adding a dimension
    // without also editing it produced a chip that rendered and did nothing when
    // clicked — caught in the browser, not by any of the checks above.
    expect(dash).toMatch(/var defs = defaultFilter\(\);/);
    expect(dash).not.toMatch(/var defs = \{ status: \[\], minPct: 0, owner: "all"/);
  });

  it("does not let clearing a filter reset the sort", () => {
    // defaultFilter() carries sortKey/sortDir, which are not filters.
    const fn = dash.slice(dash.indexOf("function clearFilter"), dash.indexOf("function clearFilter") + 1200);
    expect(fn).toMatch(/delete defs\.sortKey; delete defs\.sortDir;/);
  });

  it("offers the steps in flow order, not alphabetically", () => {
    // Alphabetical would read channels, company, reports, topics, users — useless for
    // seeing where in the conversation clients fall out.
    expect(dash).toMatch(/var SECTION_ORDER = \["company", "path", "topics", "channels", "reports", "users"\]/);
    expect(dash).toMatch(/SECTION_ORDER\.filter\(function \(k\) \{ return sectionMap\[k\]; \}\)/);
  });

  it("lets you isolate a clean run as well as a skipped one", () => {
    // "any" and "none" partition the set; the per-widget entries drill in.
    expect(dash).toMatch(/\["any", "Skipped anything"\], \["none", "Skipped nothing"\]/);
    expect(dash).toMatch(/FILTER\.skipped === "any" && !sk\.length/);
    expect(dash).toMatch(/FILTER\.skipped === "none" && sk\.length/);
    expect(dash).toMatch(/FILTER\.skipped\.indexOf\("w:"\) === 0 && sk\.indexOf\(FILTER\.skipped\.slice\(2\)\) === -1/);
  });
});
