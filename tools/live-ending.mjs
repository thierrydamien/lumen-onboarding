#!/usr/bin/env node
/**
 * Drive a FULL onboarding to its ENDING against the deployed backend, in one
 * language, and capture the closing turns.
 *
 * WHY: the client-side overstatement guard (overstatesCompletion in
 * src/lumen.jsx) is a hardcoded ENGLISH phrase list — "you're all set", "is now
 * live", "now getting proactive". It cannot fire in French, German, Spanish,
 * Italian or Arabic. That guard exists because the model was observed making
 * exactly those claims in testing, and claiming the monitoring is already
 * running is the single most damaging thing it can say: nothing is live until a
 * consultant builds it at the review call.
 *
 * Every previous live test covered conversation MIDDLES. The overstatement risk
 * lives in the ENDING — the VALUE BEATS payoff lines and the STEP 7 close. This
 * script exists to get there and look.
 *
 * RUN:  LUMEN_SITE=https://your-site.netlify.app node tools/live-ending.mjs de
 * COST: real API calls billed to the deployed site's key. ~20 turns, a few cents.
 */
import { writeFileSync, readFileSync } from "node:fs";
import { visibleOf } from "./quality-checks.mjs";

const SITE = (process.env.LUMEN_SITE || "").replace(/\/+$/, "");
if (!SITE) { console.error("Set LUMEN_SITE"); process.exit(1); }
const ENDPOINT = SITE + "/.netlify/functions/chat";
const MAX_TURNS = Number(process.env.MAX_TURNS || 22);

// Expert flow answers: fewer explanatory detours, so the ending arrives sooner
// and the run costs less. Order tracks the documented step sequence.
const SCRIPTS = {
  fr: {
    lang: "French",
    msgs: [
      "Brasserie du Nord, on fait de la bière artisanale à Lille.",
      "c.dubois@brasseriedunord.fr",
      "On veut savoir si notre sponsoring du festival a servi à quelque chose, pour décider du budget de l'an prochain.",
      "Très expérimenté(e)",
      "Nos marques principales : Nord Blonde et Nord Triple.",
      "Nos concurrents : Brasserie Castelain et La Choulette.",
      "Oui, ces sujets me vont très bien.",
      "Non, rien d'ambigu, nos noms sont assez spécifiques.",
      "La France surtout, un peu la Belgique.",
      "Oui, français, fuseau Paris, c'est parfait.",
      "1. Gestion de la réputation, 2. Mesure des campagnes",
      "L'équipe marketing et la communication.",
      "On est sur Instagram et LinkedIn, instagram.com/brasseriedunord",
      "Oui, les trois rapports me conviennent.",
      "Camille Dubois, c.dubois@brasseriedunord.fr, directrice marketing.",
      "Non, c'est tout, on peut conclure.",
      "Oui, c'est parfait, merci !",
    ],
  },
  de: {
    lang: "German",
    msgs: [
      "Nordlicht Brauerei, wir machen Craft Beer in Hamburg.",
      "k.hoffmann@nordlicht-brauerei.de",
      "Wir wollen wissen, ob sich unser Stadtfest-Sponsoring gelohnt hat, um über das Budget nächstes Jahr zu entscheiden.",
      "Sehr erfahren",
      "Unsere Hauptmarken sind Nordlicht Pils und Nordlicht IPA.",
      "Unsere Wettbewerber sind Ratsherrn und Kehrwieder.",
      "Ja, die Themen passen so.",
      "Nein, nichts Mehrdeutiges, die Namen sind eindeutig.",
      "Hauptsächlich Deutschland, etwas Österreich.",
      "Ja, Deutsch und CET passt.",
      "1. Reputationsmanagement, 2. Kampagnenmessung",
      "Marketing und Unternehmenskommunikation.",
      "Wir sind auf Instagram und LinkedIn, instagram.com/nordlichtbrauerei",
      "Ja, alle drei Berichte klingen gut.",
      "Katrin Hoffmann, k.hoffmann@nordlicht-brauerei.de, Marketingleiterin.",
      "Nein, das war alles, wir können abschließen.",
      "Ja, sieht gut aus, danke!",
    ],
  },
};

const key = (process.argv[2] || "fr").toLowerCase();
const script = SCRIPTS[key];
if (!script) { console.error("Usage: node tools/live-ending.mjs [fr|de]"); process.exit(1); }

const opener = `Hello, I'm ready to get started. Please conduct the entire conversation in ${script.lang}.`;
let hist = [{ role: "user", content: opener }];
let turns = [];
// --continue picks up a saved run rather than paying for the whole thing again.
if (process.argv.includes("--continue")) {
  const prev = JSON.parse(readFileSync(`/tmp/ending-${key}.json`, "utf8"));
  if (prev.hist) { hist = prev.hist; turns = prev.turns; process.stderr.write(`resuming at turn ${turns.length}\n`); }
}

async function call() {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", origin: SITE },
    body: JSON.stringify({ messages: hist.slice(-20), maxTokens: 2000, overstateFix: false }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  const d = JSON.parse(t);
  return { text: (d.content || []).map((b) => b.text || "").join(""), usage: d.usage || {} };
}

const pct = (raw) => { const m = raw.match(/"percent"\s*:\s*(\d+)/); return m ? Number(m[1]) : null; };

let i = 0, cost = 0;
process.stderr.write(`driving ${script.lang} to completion (max ${MAX_TURNS} turns)\n`);
for (let n = 0; n < MAX_TURNS; n++) {
  const a = await call();
  hist.push({ role: "assistant", content: a.text.replace(/<(thought|thoughts|thinking|think)>[\s\S]*?<\/(thought|thoughts|thinking|think)>/gi, "").trim() });
  const p = pct(a.text);
  turns.push({ raw: a.text, visible: visibleOf(a.text), pct: p });
  cost += ((a.usage.input_tokens || 0) * 3 + (a.usage.output_tokens || 0) * 15
        + (a.usage.cache_creation_input_tokens || 0) * 3.75 + (a.usage.cache_read_input_tokens || 0) * 0.3) / 1e6;
  process.stderr.write(`  turn ${turns.length}: ${p == null ? "?" : p + "%"}\n`);
  if (p != null && p >= 100) break;
  // Scripted answers run out before the end — the model asks follow-ups no fixed
  // script anticipates (a LinkedIn URL, an extra recipient). Fall back to neutral
  // affirmatives so the run reaches the actual CLOSE, which is the whole point.
  const filler = script.lang === "German"
    ? ["Ja, passt so.", "Nein, das war alles.", "Ja, gerne so.", "Ja, sieht gut aus, danke!"]
    : ["Oui, c'est bon.", "Non, c'est tout.", "Oui, parfait.", "Oui, c'est parfait, merci !"];
  const next = i < script.msgs.length ? script.msgs[i++] : filler[Math.min(n % filler.length, filler.length - 1)];
  hist.push({ role: "user", content: next });
}

const out = `/tmp/ending-${key}.json`;
writeFileSync(out, JSON.stringify({ lang: script.lang, turns, cost, hist }, null, 2));
console.log(`\n=== ${script.lang}: ${turns.length} turns, final ${turns[turns.length - 1].pct}%, ~$${cost.toFixed(3)} ===`);
console.log(`(full transcript: ${out})\n`);
console.log("--- CLOSING TURNS (read these for over-promising) ---");
for (const t of turns.slice(-3)) {
  console.log(`\n[${t.pct}%] ${t.visible}`);
}
