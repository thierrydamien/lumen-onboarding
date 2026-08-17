#!/usr/bin/env node
/**
 * What does the assistant do when a client presses Skip on a widget?
 *
 * The client emits the literal user turn `[Widget skipped — <TYPE>]`
 * (src/lumen.jsx onWSkip). That string appears NOWHERE in the system prompt, so
 * the model has no rule for it — while FORWARD MOTION tells it every turn must
 * advance the setup. The prompt DOES already say the right thing for uncertainty
 * (HANDLING "I DON'T KNOW": offer one contextual industry suggestion; if still
 * unsure, note as unconfirmed and move on) — but that rule is keyed on the client
 * SAYING something, and the UI hands them a button instead. This probe measures
 * whether the good behaviour fires on the path clients actually take.
 *
 * Deliberately ONE TURN, not a full conversation. The question is what the very
 * next reply does, so a 16-turn run with a 1-5 judge is the wrong instrument and
 * ~20x the cost. Scoring is deterministic for the same reason the multi-question
 * counter is: a coarse score cannot see a defect this narrow, and determinism
 * needs far fewer runs for signal.
 *
 * RUN:  LUMEN_SITE=https://lumen-onboarding.netlify.app node tools/probe-skip.mjs
 * ENV:  PROBE_RUNS (default 3), PROBE_TYPES (default MARKETS,OBJECTIVES),
 *       PROBE_LANG (default English; try French or Arabic)
 * COST: real API calls billed to whoever owns the deployed site. One turn each,
 *       so a full default run is a few cents.
 *
 * WHAT IT CANNOT DO: test a FIX. The deployed function hard-rejects a supplied
 * system prompt (chat.js: `system_not_accepted`), so a candidate lever cannot be
 * injected through it. Measuring a fix needs a direct ANTHROPIC_API_KEY and
 * tools/ab-harness.mjs, which appends levers in memory. This file establishes
 * the BASELINE the fix would have to beat.
 */
import { readFileSync } from "node:fs";

const SITE = (process.env.LUMEN_SITE || "").replace(/\/+$/, "");
if (!SITE) { console.error("Set LUMEN_SITE, e.g. LUMEN_SITE=https://lumen-onboarding.netlify.app"); process.exit(1); }
const ENDPOINT = SITE + "/.netlify/functions/chat";
const RUNS = Number(process.env.PROBE_RUNS || 3);
const TYPES = (process.env.PROBE_TYPES || "MARKETS,OBJECTIVES").split(",").map(s => s.trim()).filter(Boolean);
const LANG = process.env.PROBE_LANG || "English";

const visibleOf = s => String(s == null ? "" : s)
  .replace(/<(thought|thoughts|thinking|think)>[\s\S]*?<\/(thought|thoughts|thinking|think)>/gi, "")
  .replace(/<(thought|thoughts|thinking|think)>[\s\S]*$/i, "")
  .replace(/%%[A-Z_]+%%[\s\S]*?%%END%%/g, "")
  .replace(/TOPIC_SUGGESTION\{[\s\S]*?\}\s*$/gm, "")
  .replace(/\[(WIDGET|SUGGESTIONS|OFFER_SEND)[^\]]*\]/g, "")
  .trim();

async function chat(messages) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE },
    body: JSON.stringify({ messages, maxTokens: 2000, overstateFix: false }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return (data.content || []).map(b => b.text || "").join("");
}

// A minimal history that has plausibly just shown the widget under test. Kept
// short on purpose: the fewer turns, the less anything except the skip signal can
// explain the reply.
function historyFor(type) {
  const asked = {
    MARKETS: "Which markets matter most to you? Select all that apply.\n\n[WIDGET:MARKETS]",
    OBJECTIVES: "Pick up to 3 priorities and set their order — your #1 decides what we build first.\n\n[WIDGET:OBJECTIVES]",
    TEAMS: "Which teams will be using Lumen?\n\n[WIDGET:TEAMS]",
    LANGUAGES: "Which languages should we monitor?\n\n[WIDGET:LANGUAGES]",
  }[type] || `Please choose.\n\n[WIDGET:${type}]`;
  return [
    { role: "user", content: `[BEGIN ONBOARDING] The client just opened their link. Conduct this onboarding in ${LANG}.` },
    { role: "assistant", content: "Hi! I'm here to set up your Lumen environment. To start: what are you hoping to get out of Lumen?" },
    { role: "user", content: "We're Northwind Athletics, we sell running shoes. Mainly we want to keep an eye on our brand reputation." },
    { role: "assistant", content: asked },
    // The exact string src/lumen.jsx onWSkip sends.
    { role: "user", content: `[Widget skipped — ${type}]` },
  ];
}

// The widget's REAL option list, read out of the client so this stays in lockstep.
// Scoring "did it name a concrete example" against the domain's own vocabulary
// beats any capitalisation heuristic: the first version used a proper-noun regex
// and scored "the US, UK and Japan are usually the first three" as naming nothing,
// because US and UK are two-letter all-caps tokens it could not match — and those
// are precisely the market names this product deals in.
const CLIENT_SRC = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
function optionsFor(type) {
  const varName = { MARKETS: "MARKETS_OPT", LANGUAGES: "LANG_OPT", OBJECTIVES: "OBJ_OPT", TEAMS: "TEAM_OPT", TIMEZONE: "TZ_OPT" }[type];
  if (!varName) return [];
  const m = CLIENT_SRC.match(new RegExp(`const ${varName}\\s*=\\s*\\[([^\\]]*)\\]`));
  if (!m) return [];
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
}
// Common informal aliases the model reasonably uses instead of the exact option.
const ALIASES = {
  "United States": ["US", "U.S.", "USA", "the States"],
  "United Kingdom": ["UK", "U.K.", "Britain"],
  "South Korea": ["Korea"],
  "Middle East": ["MENA"],
};

// Deterministic checks on the ONE reply that follows the skip.
function score(raw, type) {
  const visible = visibleOf(raw);
  // Did it put the same widget back in front of the client?
  const reoffered = new RegExp(`\\[WIDGET:${type}\\]`).test(raw);
  // Did it move on to a DIFFERENT widget instead? (A regex LITERAL cannot
  // interpolate ${type} — the first version of this line did exactly that and
  // silently matched nothing.)
  const others = (raw.match(/\[WIDGET:([A-Z_]+)\]/g) || []).filter(w => w !== `[WIDGET:${type}]`);
  const movedOn = others.length > 0;
  // Did it name at least two concrete options from this widget's own list?
  const opts = optionsFor(type);
  const hit = o => {
    const forms = [o, ...(ALIASES[o] || [])];
    return forms.some(f => new RegExp(`(^|[^\\w])${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w]|$)`, "i").test(visible));
  };
  const matched = opts.filter(hit);
  const named = matched.length >= 2;
  const asksSomething = /\?/.test(visible);
  const acknowledgesUncertainty = /no (worries|problem)|that'?s fine|不要紧|pas de souci|kein problem|no pasa nada|nessun problema|لا مشكلة|happy to|if you'?re not sure|not sure|don'?t know|we can (come back|cover|revisit)|later|review call/i.test(visible);
  return { reoffered, movedOn, named, asksSomething, acknowledgesUncertainty,
           helped: named && (reoffered || asksSomething),
           matched,
           visible: visible.replace(/\s+/g, " ").slice(0, 260) };
}

const pct = (n, d) => d ? Math.round(n / d * 100) + "%" : "n/a";

// `--self-check` exercises score() on hand-written replies, offline and free.
// Worth having: the first two versions of this scorer were wrong in ways that
// would have produced a confident, meaningless verdict — a regex literal that
// could not interpolate ${type}, and a proper-noun heuristic that scored "the US,
// UK and Japan" as naming nothing. Test the instrument before trusting it.
const SELF_CHECK = [
  ["names US/UK/Japan and re-offers", "MARKETS",
   "No worries — for a running brand like yours, the US, UK and Japan are usually the first three. Do any of those fit?\n\n[WIDGET:MARKETS]",
   { helped: true, reoffered: true, movedOn: false }],
  ["acknowledges, then jumps to another widget", "MARKETS",
   "No problem, we can cover that on your review call.\n\n[WIDGET:OBJECTIVES]",
   { helped: false, reoffered: false, movedOn: true }],
  ["bare acknowledgement, prose only", "MARKETS",
   "That's fine, let's move on. Which teams will use Lumen?",
   { helped: false, reoffered: false, movedOn: false }],
  ["names options in prose and asks, without re-emitting", "MARKETS",
   "For a footwear brand I would start with the United States, Germany and Japan. Are those close?",
   { helped: true, reoffered: false }],
  ["a thought block is not visible prose", "MARKETS",
   "<thought>skip; offer example</thought>No worries — the US and Japan often come up. Either relevant?\n\n[WIDGET:MARKETS]",
   { helped: true, reoffered: true }],
  ["objectives: two real objectives named", "OBJECTIVES",
   "For a brand like yours I would put Reputation Management first and Competitive Intelligence second. Sound right?\n\n[WIDGET:OBJECTIVES]",
   { helped: true, named: true }],
  ["one option named is not an example set", "MARKETS",
   "Shall we just put Japan for now?\n\n[WIDGET:MARKETS]",
   { named: false }],
];
if (process.argv.includes("--self-check")) {
  let pass = 0, fail = 0;
  console.log(`\nscorer self-check (offline)\nMARKETS options parsed: ${optionsFor("MARKETS").length}, OBJECTIVES: ${optionsFor("OBJECTIVES").length}\n`);
  for (const [label, type, raw, want] of SELF_CHECK) {
    const r = score(raw, type);
    const bad = Object.entries(want).filter(([k, v]) => r[k] !== v);
    if (bad.length) {
      fail++; console.log("FAIL  " + label);
      bad.forEach(([k, v]) => console.log(`        ${k}: got ${r[k]}, want ${v}   matched=${JSON.stringify(r.matched)}`));
    } else { pass++; console.log(`ok    ${label}   matched=${JSON.stringify(r.matched)}`); }
  }
  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// The simulated client NEEDS ITS OWN SYSTEM PROMPT, so it needs a direct API key.
//
// Two invalid attempts are recorded here so nobody repeats them:
//   1. A fixed client string. The assistant correctly noticed the identical
//      message repeating and spent every turn after the second handling the echo
//      ("looks like that came through twice"). The onboarding stopped; the RESULT
//      line still printed confidently.
//   2. Routing the client through the DEPLOYED endpoint with an "ignore previous
//      instructions, role-play a client" prefix. That prefix loses to the system
//      prompt, so both sides played the consultant and argued about which was
//      which for six turns ("we're both trying to be the consultant").
// The endpoint hard-rejects a supplied system prompt by design, so there is no
// third trick. A valid multi-turn run needs the client driven by a separate call
// with its own system prompt, which is what tools/ab-harness.mjs already does.
const DIRECT_KEY = process.env.ANTHROPIC_API_KEY;
const CLIENT_PERSONA =
  "You are role-playing a CLIENT being onboarded onto Lumen, a social listening tool. You are Dana, marketing "
  + "lead at Northwind Athletics (running footwear). Cooperative and brief. You have ALREADY given your email "
  + "(dana@northwind.example) and your industry, so do not repeat them unless asked directly. You genuinely do "
  + "NOT know which markets matter to you and will say so if asked again. Answer the assistant's last message in "
  + "one or two natural sentences. Output ONLY what Dana says.";
async function simulateClient(assistantVisible) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": DIRECT_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.PROBE_CLIENT_MODEL || "claude-sonnet-4-6",
      max_tokens: 200,
      system: CLIENT_PERSONA,
      messages: [{ role: "user", content: `The assistant just said:\n"""${assistantVisible}"""\n\nReply as Dana.` }],
    }),
  });
  if (!res.ok) throw new Error(`client-sim HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const t = (data.content || []).map(b => b.text || "").join("").trim();
  return t || "Okay, sounds good.";
}

// `--followup` answers the question the single-turn probe raises. Measured
// baseline replies do not offer help; they say "we'll come back to markets
// shortly" and "we can revisit priorities at your review call". That is a promise,
// and whether it is kept decides how bad the skip path really is: quietly moving
// on is mild, promising to return and never returning is worse, because the client
// believes it is handled and the brief silently lacks the field.
//
// Drives a cooperative client for N further turns and checks whether the skipped
// widget, or a plain-prose question about it, ever comes back.
async function followup(type, turns) {
  const KEYWORDS = { MARKETS: /market|countr|region|geograph/i, OBJECTIVES: /objective|priorit|goal/i,
                     TEAMS: /team|department/i, LANGUAGES: /language/i }[type] || new RegExp(type, "i");
  const hist = historyFor(type);
  const trail = [];
  let cameBack = null;
  for (let t = 0; t < turns; t++) {
    const raw = await chat(hist);
    const visible = visibleOf(raw);
    hist.push({ role: "assistant", content: raw.replace(/<thought>[\s\S]*?<\/thought>/gi, "").trim() });
    const reoffered = new RegExp(`\\[WIDGET:${type}\\]`).test(raw);
    const askedInProse = KEYWORDS.test(visible) && /\?/.test(visible);
    trail.push({ turn: t + 1, reoffered, askedInProse, visible: visible.replace(/\s+/g, " ").slice(0, 150) });
    // Turn 1 is the reply to the skip itself. It routinely says "we can come back
    // to markets later", which mentions the field and contains a question, so
    // counting it as a RETURN scores the acknowledgement as the thing it promises.
    // Only turn 2 onward can be a genuine return.
    if (t >= 1 && (reoffered || askedInProse) && cameBack === null) cameBack = t + 1;
    if (/%%PROGRESS%%[\s\S]*?"percent"\s*:\s*100/.test(raw)) break;
    // The client has to be simulated by a model, not a fixed string. A static reply
    // makes the assistant notice the repetition and spend every remaining turn
    // handling the echo instead of running the onboarding — the first version of
    // this did exactly that and derailed from turn 3, making the whole run
    // meaningless while still printing a confident RESULT line.
    hist.push({ role: "user", content: await simulateClient(visible) });
  }
  return { cameBack, trail };
}

async function main() {
  if (process.argv.includes("--followup")) {
    if (!DIRECT_KEY) {
      console.error(
        "\n--followup needs ANTHROPIC_API_KEY as well as LUMEN_SITE.\n\n" +
        "The assistant turns go through the deployed function (real prompt, real model),\n" +
        "but the CLIENT has to be simulated with its own system prompt, and the deployed\n" +
        "endpoint refuses one by design (`system_not_accepted`). Without a direct key the\n" +
        "client cannot be simulated validly — see the note above simulateClient() for the\n" +
        "two ways this was already got wrong, both of which still printed a confident\n" +
        "RESULT line off a derailed conversation.\n\n" +
        "The single-turn probe (no flag) needs no key and is unaffected.\n");
      process.exit(2);
    }
    const type = TYPES[0];
    const turns = Number(process.env.PROBE_TURNS || 8);
    console.log(`\nDoes a skipped widget ever come back? — ${type}, up to ${turns} turns, ${SITE}\n`);
    const { cameBack, trail } = await followup(type, turns);
    trail.forEach(t => console.log(
      `  turn ${t.turn}: re-offered=${t.reoffered ? "Y" : "n"} asked-in-prose=${t.askedInProse ? "Y" : "n"}\n           "${t.visible}"`));
    console.log(`\nRESULT: ${cameBack ? `came back at turn ${cameBack}` : `NEVER came back within ${turns} turns`}`);
    console.log(cameBack
      ? "READ: the promise is kept, so the skip is a deferral rather than a silent loss. Lower severity."
      : "READ: the model promised to return and did not. The client believes markets are handled; the brief has none.");
    return;
  }
  console.log(`\nSkip-handling probe — ${SITE}`);
  console.log(`${RUNS} run(s) x ${TYPES.length} widget type(s), language: ${LANG}\n`);
  const rows = [];
  for (const type of TYPES) {
    const results = [];
    for (let i = 0; i < RUNS; i++) {
      process.stderr.write(`\r${type}: run ${i + 1}/${RUNS}   `);
      try {
        results.push(score(await chat(historyFor(type)), type));
      } catch (e) {
        process.stderr.write(`\n  ${type} run ${i + 1} FAILED: ${e.message}\n`);
      }
    }
    process.stderr.write("\r");
    const n = results.length;
    rows.push({ type, n,
      helped: results.filter(r => r.helped).length,
      named: results.filter(r => r.named).length,
      reoffered: results.filter(r => r.reoffered).length,
      movedOn: results.filter(r => r.movedOn).length,
      ack: results.filter(r => r.acknowledgesUncertainty).length });
    console.log(`--- ${type} ---`);
    results.forEach((r, i) => console.log(
      `  run ${i + 1}: named-example=${r.named ? "Y" : "n"} re-offered=${r.reoffered ? "Y" : "n"} ` +
      `moved-on=${r.movedOn ? "Y" : "n"} ack-uncertainty=${r.acknowledgesUncertainty ? "Y" : "n"}\n` +
      `          "${r.visible}"`));
    console.log("");
  }
  console.log("=== summary ===");
  console.log("widget".padEnd(13) + "n".padEnd(4) + "offered help".padEnd(15) + "named example".padEnd(16) + "re-offered".padEnd(13) + "moved on");
  for (const r of rows) {
    console.log(r.type.padEnd(13) + String(r.n).padEnd(4) + pct(r.helped, r.n).padEnd(15) +
      pct(r.named, r.n).padEnd(16) + pct(r.reoffered, r.n).padEnd(13) + pct(r.movedOn, r.n));
  }
  console.log("\nREAD: the prompt's HANDLING \"I DON'T KNOW\" rule says to offer one");
  console.log("contextual industry suggestion. If 'offered help' is low and 'moved on' is");
  console.log("high, that rule is not firing on the skip path and a prompt rule for");
  console.log("[Widget skipped — X] is worth adding. If it is already high, the finding is");
  console.log("wrong and no prompt change is needed.");
}
main().catch(e => { console.error("\nProbe failed:", e.message); process.exit(1); });
