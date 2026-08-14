#!/usr/bin/env node
/**
 * Drive a REAL onboarding conversation against the DEPLOYED chat function, one
 * turn at a time, with a human (or Claude) playing the client.
 *
 * WHY THIS EXISTS: tools/ab-harness.mjs answers "is this cost lever safe?" by
 * having a model play the client, which is fine for cost but weak for quality —
 * a simulated client is cooperative, never contradicts itself, and never
 * code-switches. The top item on the untested list is conversation QUALITY, and
 * that needs an adversarial client. So this tool makes the loop interactive:
 * you send one client message, you read what came back, you decide what to send
 * next. It is the only way to test "the client goes off-script and the model has
 * to recover".
 *
 * WHY IT TALKS TO THE DEPLOY, NOT THE API: the deployed function holds the API
 * key, so nobody has to hand a key around to run this. It also means the thing
 * under test is the real production stack — the real system prompt, the real
 * model, the real max_tokens ceiling — not a local reconstruction of it. The
 * function's only gate is an Origin check, which we satisfy the same way a
 * browser does.
 *
 * RUN:
 *   export LUMEN_SITE=https://your-site.netlify.app
 *   node tools/live-convo.mjs init  -f /tmp/fr.json --lang French
 *   node tools/live-convo.mjs say   -f /tmp/fr.json "Bonjour, ici Amélie de ..."
 *   node tools/live-convo.mjs show  -f /tmp/fr.json
 *   node tools/live-convo.mjs report -f /tmp/fr.json
 *
 * COST: real API calls, billed to whoever owns the deployed site. A 20-turn
 * conversation is a few cents. Nothing is written to the session store or the
 * dashboard — this only ever POSTs to the chat function.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SITE = (process.env.LUMEN_SITE || "").replace(/\/+$/, "");
if (!SITE) { console.error("Set LUMEN_SITE, e.g. LUMEN_SITE=https://your-site.netlify.app"); process.exit(1); }
const ENDPOINT = SITE + "/.netlify/functions/chat";

// ---- production client contract (src/lumen.jsx callAPI). Keep in lockstep. ----
const MAX_HIST_TURNS = 20;
const MAX_REQ_BODY = 350_000;
const MAX_TOKENS = 2000;
const sanitizeIn = (s) => String(s == null ? "" : s).replace(/%%+/g, "%");

/** src/lumen.jsx seededOpener(): the exact first message a real link produces. */
function seededOpener(sd, uiLang) {
  const langDirective = uiLang && uiLang !== "English" ? ` Please conduct the entire conversation in ${uiLang}.` : "";
  if (sd) {
    const contactPart = sd.contactName
      ? ` Contact: ${sd.contactName}${sd.email ? ` (${sd.email})` : ""}.`
      : (sd.email ? ` Contact email: ${sd.email}.` : "");
    return `[SEEDED SESSION] Prepared by the Lumen team. Company: ${sd.company}.${contactPart}`
      + `${sd.industry ? ` Industry: ${sd.industry}.` : ""}`
      + `${sd.notes ? ` Consultant notes (do not read back to the client): ${sd.notes}.` : ""}`
      + ` The client has just opened their link.${langDirective}`;
  }
  return `Hello, I'm ready to get started.${langDirective}`;
}

function trimHistory(hist) {
  const mkBody = (msgs) => ({ messages: msgs, maxTokens: MAX_TOKENS, overstateFix: false });
  let t = hist.slice(-MAX_HIST_TURNS);
  while (t.length > 1 && JSON.stringify(mkBody(t)).length > MAX_REQ_BODY) t = t.slice(1);
  if (t.length > 1 && t[0].role !== "user") t = t.slice(1);
  return t;
}

async function callChat(hist) {
  const messages = trimHistory(hist);
  const started = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE },
    body: JSON.stringify({ messages, maxTokens: MAX_TOKENS, overstateFix: false }),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  return {
    text: (data.content || []).map((b) => b.text || "").join(""),
    usage: data.usage || {},
    ms: Date.now() - started,
    sentTurns: messages.length,
  };
}

// ---------------------------- output analysis ----------------------------
// These names are the protocol between the model and the client parser. The
// parser matches %%[A-Z]+%% and [WIDGET:[A-Z_]+] — so a marker the model
// translates or writes in another script does not merely capture the wrong
// data, it fails to strip and leaks raw text to the client.
const KNOWN_MARKERS = ["PROGRESS", "COMPANY", "TOPICS", "CHANNELS", "REPORTS", "ALERTS", "USERS", "HANDOFF"];
const KNOWN_WIDGETS = ["MARKETS", "OBJECTIVES", "TEAMS", "USERS", "QUERIES", "LANGUAGES", "TIMEZONE", "PATH"];

const ARABIC = /[؀-ۿݐ-ݿ]/;
const CJK = /[一-鿿]/;
const LATIN_LETTER = /[A-Za-z]/;

/** Visible prose, mirroring src/lumen.jsx stripAll. Labelled as a copy on purpose. */
function visibleOf(t) {
  return t
    .replace(/%%[A-Z]+%%[\s\S]*?%%END%%/g, "")
    .replace(/\[WIDGET:[A-Z_]+\]/g, "")
    .replace(/<(thought|thoughts|thinking|think)>[\s\S]*?<\/(thought|thoughts|thinking|think)>/g, "")
    .replace(/^\s*<(thought|thoughts|thinking|think)>[\s\S]*$/, "")
    .replace(/\[SUGGESTIONS:[\s\S]*?\]/g, "")
    .replace(/\[OFFER_SEND\]/g, "")
    .replace(/TOPIC_SUGGESTION\s*\{[^{}]*\}/g, "")
    .replace(/^TOPIC_SUGGESTION\|.*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const EMOJI = /\p{Extended_Pictographic}/gu;

function analyse(raw, lang) {
  const issues = [];
  const visible = visibleOf(raw);

  // 1. Marker integrity. Anything shaped like a marker whose name is not plain
  //    A-Z will not be stripped by the client and leaks to the screen.
  const markerish = [...raw.matchAll(/%%([^%\s]{1,40})%%/g)].map((m) => m[1]);
  for (const name of new Set(markerish)) {
    if (name === "END") continue;
    if (!/^[A-Z]+$/.test(name)) issues.push(`MARKER-NAME-NOT-STRIPPABLE: %%${name}%% is not [A-Z]+ — the client parser will not strip it, so it leaks to the client`);
    else if (!KNOWN_MARKERS.includes(name)) issues.push(`MARKER-UNKNOWN: %%${name}%% is not a marker the client understands (data silently dropped)`);
  }
  // 2. Marker payloads must be JSON with English keys.
  for (const m of raw.matchAll(/%%([A-Z]+)%%([\s\S]*?)%%END%%/g)) {
    const [, name, body] = m;
    let parsed;
    try { parsed = JSON.parse(body.trim()); }
    catch (e) { issues.push(`MARKER-BAD-JSON: %%${name}%% payload does not parse (${e.message.slice(0, 60)}) — client drops it silently`); continue; }
    const keys = [];
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const k of Object.keys(v)) { keys.push(k); walk(v[k]); } };
    walk(parsed);
    for (const k of new Set(keys)) {
      if (!LATIN_LETTER.test(k) || ARABIC.test(k) || CJK.test(k)) issues.push(`MARKER-KEY-TRANSLATED: %%${name}%% has a non-English JSON key "${k}" — the client reads English keys only`);
    }
  }
  // 3. Widget tags.
  for (const m of raw.matchAll(/\[WIDGET:([^\]]{1,40})\]/g)) {
    const w = m[1];
    if (!/^[A-Z_]+$/.test(w)) issues.push(`WIDGET-NOT-STRIPPABLE: [WIDGET:${w}] is not [A-Z_]+ — leaks to the client`);
    else if (!KNOWN_WIDGETS.includes(w)) issues.push(`WIDGET-UNKNOWN: [WIDGET:${w}] renders nothing`);
  }
  // 4. Leakage: anything protocol-shaped that survived into the visible prose.
  for (const [re, label] of [[/%%/, "%% marker fragment"], [/\[WIDGET/i, "[WIDGET tag"], [/TOPIC_SUGGESTION/, "TOPIC_SUGGESTION"], [/\[SUGGESTIONS/i, "[SUGGESTIONS tag"], [/<thought/i, "<thought> block"]]) {
    if (re.test(visible)) issues.push(`LEAK-TO-CLIENT: ${label} survived stripping and would be shown to the client`);
  }
  // 5. The @ATTACH chip must never be translated (the prompt says so verbatim).
  const sugg = [...raw.matchAll(/\[SUGGESTIONS:([^\]]*)\]/g)].map((m) => m[1]);
  const attachish = sugg.some((s) => /@/.test(s));
  if (attachish && !sugg.some((s) => /@ATTACH/.test(s))) issues.push(`ATTACH-TRANSLATED: a chip starts with @ but is not the literal @ATTACH — no file picker will render`);

  // 6. Language of the visible prose.
  if (lang === "Arabic") {
    if (visible && !ARABIC.test(visible)) issues.push(`LANGUAGE-DRIFT: reply carries no Arabic script`);
  } else if (lang && lang !== "English") {
    const asciiWords = (visible.match(/\b[A-Za-z']+\b/g) || []);
    const enStop = asciiWords.filter((w) => /^(the|and|your|you|with|that|this|for|are|our|what|which|how|would|will|can|about|from|have|help)$/i.test(w));
    if (enStop.length >= 4) issues.push(`LANGUAGE-DRIFT: reply looks like English (${enStop.length} English stopwords)`);
  }

  // 7. STYLE rules the prompt marks CRITICAL.
  const emoji = visible.match(EMOJI) || [];
  if (emoji.length > 1) issues.push(`STYLE-EMOJI: ${emoji.length} emoji in one message (prompt allows at most 1)`);
  if (/^\s*[-*]\s+/m.test(visible)) issues.push(`STYLE-MARKDOWN: bullet list in visible prose (prompt forbids)`);
  if (/\*\*/.test(visible)) issues.push(`STYLE-MARKDOWN: bold markers in visible prose (prompt forbids)`);
  if (/^#{1,6}\s/m.test(visible)) issues.push(`STYLE-MARKDOWN: heading in visible prose (prompt forbids)`);
  const questions = (visible.match(/[?؟]/g) || []).length;
  if (questions > 1) issues.push(`STYLE-MULTI-QUESTION: ${questions} questions in one message (prompt says never more than one)`);

  return {
    visible,
    issues,
    markers: [...raw.matchAll(/%%([A-Z]+)%%([\s\S]*?)%%END%%/g)].map((m) => ({ name: m[1], body: m[2].trim() })),
    widgets: [...raw.matchAll(/\[WIDGET:([A-Z_]+)\]/g)].map((m) => m[1]),
    chips: sugg,
    offerSend: /\[OFFER_SEND\]/.test(raw),
    topicSuggestions: (raw.match(/TOPIC_SUGGESTION/g) || []).length,
  };
}

// ------------------------------- state I/O -------------------------------
const load = (f) => JSON.parse(readFileSync(f, "utf8"));
const save = (f, s) => writeFileSync(f, JSON.stringify(s, null, 2));

function printTurn(a, state) {
  const n = state.turns.length;
  console.log(`\n${"=".repeat(72)}\nASSISTANT (turn ${n}) — ${a.ms}ms, ${a.usage.output_tokens || "?"} out / ${a.usage.input_tokens || "?"} in, ${a.sentTurns} msgs sent\n${"=".repeat(72)}`);
  console.log(a.analysis.visible || "(no visible prose)");
  const d = a.analysis;
  if (d.markers.length) console.log(`\n-- markers: ${d.markers.map((m) => m.name).join(", ")}`);
  for (const m of d.markers) if (m.name !== "PROGRESS") console.log(`   %%${m.name}%% ${m.body.slice(0, 600)}`);
  const prog = d.markers.find((m) => m.name === "PROGRESS");
  if (prog) console.log(`   %%PROGRESS%% ${prog.body.slice(0, 300)}`);
  if (d.widgets.length) console.log(`-- widgets: ${d.widgets.join(", ")}`);
  if (d.chips.length) console.log(`-- chips: ${d.chips.map((c) => "[" + c.trim() + "]").join(" ")}`);
  if (d.topicSuggestions) console.log(`-- topic suggestion cards: ${d.topicSuggestions}`);
  if (d.offerSend) console.log(`-- [OFFER_SEND] emitted`);
  if (d.issues.length) { console.log(`\n!! ISSUES (${d.issues.length}):`); for (const i of d.issues) console.log(`   - ${i}`); }
  else console.log(`\n   (no automated issues on this turn)`);
}

async function turn(state, file) {
  const a = await callChat(state.hist);
  state.hist.push({ role: "assistant", content: a.text });
  a.analysis = analyse(a.text, state.lang);
  state.turns.push({ raw: a.text, ms: a.ms, usage: a.usage, issues: a.analysis.issues, sentTurns: a.sentTurns });
  save(file, state);
  printTurn(a, state);
}

// --------------------------------- CLI ---------------------------------
// Split flags from positionals up front so a client message can contain anything
// (accents, quotes, RTL text) without the parser second-guessing it.
const raw = process.argv.slice(2);
const cmd = raw[0];
const FLAGS = new Set(["-f", "--file", "--lang", "--seed"]);
const opts = {};
const positional = [];
for (let i = 1; i < raw.length; i++) {
  if (FLAGS.has(raw[i])) { opts[raw[i].replace(/^-+/, "")] = raw[++i]; }
  else positional.push(raw[i]);
}
const flag = (name, dflt) => opts[name.replace(/^-+/, "")] ?? dflt;
const file = opts.f ?? opts.file ?? "/tmp/live-convo.json";

if (cmd === "init") {
  const lang = flag("--lang", "English");
  const seedRaw = flag("--seed", "");
  const sd = seedRaw ? JSON.parse(readFileSync(seedRaw, "utf8")) : null;
  const opener = sanitizeIn(seededOpener(sd, lang));
  const state = { site: SITE, lang, seed: sd, hist: [{ role: "user", content: opener }], turns: [] };
  console.log(`opener -> ${opener}`);
  await turn(state, file);
} else if (cmd === "say") {
  const msg = positional.join(" ");
  if (!msg.trim()) { console.error('usage: say -f <file> "your message"'); process.exit(1); }
  const state = load(file);
  state.hist.push({ role: "user", content: sanitizeIn(msg) });
  console.log(`\nCLIENT: ${msg}`);
  await turn(state, file);
} else if (cmd === "show") {
  const state = load(file);
  for (const m of state.hist) {
    if (m.role === "user") console.log(`\nCLIENT:    ${m.content}`);
    else console.log(`\nASSISTANT: ${visibleOf(m.content)}`);
  }
} else if (cmd === "report") {
  const state = load(file);
  const all = state.turns.flatMap((t, i) => t.issues.map((s) => ({ turn: i + 1, s })));
  const byKind = {};
  for (const { turn: n, s } of all) { const k = s.split(":")[0]; (byKind[k] ||= []).push(n); }
  console.log(`\n=== ${state.lang} conversation — ${state.turns.length} assistant turns, ${existsSync(file) ? file : ""} ===`);
  console.log(`total automated issues: ${all.length}`);
  for (const k of Object.keys(byKind).sort()) console.log(`  ${k.padEnd(28)} ${byKind[k].length}x  (turns ${[...new Set(byKind[k])].join(", ")})`);
  const lat = state.turns.map((t) => t.ms).sort((a, b) => a - b);
  if (lat.length) console.log(`latency ms: min ${lat[0]}  median ${lat[Math.floor(lat.length / 2)]}  max ${lat[lat.length - 1]}`);
  const out = state.turns.reduce((s, t) => s + (t.usage.output_tokens || 0), 0);
  console.log(`output tokens total: ${out}`);
  for (const { turn: n, s } of all) console.log(`  turn ${n}: ${s}`);
} else {
  console.error(`usage:
  node tools/live-convo.mjs init   -f <file> --lang French [--seed seed.json]
  node tools/live-convo.mjs say    -f <file> "client message"
  node tools/live-convo.mjs show   -f <file>
  node tools/live-convo.mjs report -f <file>`);
  process.exit(1);
}
