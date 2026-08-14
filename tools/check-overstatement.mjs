import { readFileSync } from "node:fs";

// The English guard, copied verbatim from src/lumen.jsx overstatesCompletion.
function overstatesEnglish(t) {
  if (/\b((is|are|you'?re|you are) now (set up|live|active|running|configured|enabled|getting|receiving|monitoring|tracking|all set)|will now (get|receive|start|begin)|now getting proactive|delivered on a schedule|you'?re all set|is now live)\b/i.test(t)) return true;
  if (/\b(this|it|your setup|the setup|everything) is (live|active|running)\b/i.test(t) && !/\b(once|when|after|as soon as|until)\b/i.test(t)) return true;
  return false;
}

// What the SAME claim looks like in French and German. The tell in both is a
// present-tense claim of activity paired with a now-adverb; the CORRECT framing
// is conditional or future ("once your consultant activates this...").
const BAD = {
  French: [
    /\b(est|sont)\s+(maintenant|désormais|dès à présent)\s+(configuré|actif|active|en ligne|en place|opérationnel)/i,
    /\bvous (recevez|recevrez) (maintenant|désormais|dès à présent)\b/i,
    /\b(c'est|tout est) (en place|prêt|configuré|opérationnel)\b/i,
    /\bvous êtes (prêt|paré|opérationnel)s?\b/i,
    /\b(surveille|suit|traque)\s+(maintenant|désormais)\b/i,
    /\bà partir de maintenant,? vous\b/i,
    /\bLumen (surveille|suit|capte) (maintenant|désormais|déjà)\b/i,
  ],
  German: [
    /\b(ist|sind)\s+(jetzt|nun|ab sofort)\s+(eingerichtet|aktiv|live|konfiguriert|bereit|einsatzbereit)/i,
    /\bSie (erhalten|bekommen)\s+(jetzt|nun|ab sofort)\b/i,
    /\b(alles ist|es ist)\s+(bereit|eingerichtet|fertig)\b/i,
    /\bSie sind (startklar|bereit|fertig eingerichtet)\b/i,
    /\b(überwacht|verfolgt|erfasst)\s+(jetzt|nun|ab sofort)\b/i,
    /\bab sofort\b/i,
    /\bläuft (jetzt|nun|bereits)\b/i,
  ],
};

// Correct framing — presence of these is the GOOD signal.
const GOOD = {
  French: /\b(une fois|dès que|lorsque|quand)\b[^.]{0,60}\b(activé|activera|activation|mis en place)\b|\bsera\b|\bseront\b|\bvotre consultant\b/i,
  German: /\b(sobald|wenn|nachdem)\b[^.]{0,60}\b(aktiviert|einrichtet|freigeschaltet)\b|\bwird\b[^.]{0,40}\beingerichtet\b|\bIhr(e)? (Berater|Consultant)\b/i,
};

for (const [file, lang] of [["/tmp/ending-de.json", "German"], ["/tmp/ending-fr.json", "French"]]) {
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch { console.log(`\n${lang}: (no transcript yet)`); continue; }
  const turns = data.turns;
  console.log(`\n${"=".repeat(70)}\n${lang} — ${turns.length} turns, final ${turns[turns.length - 1].pct}%, ~$${data.cost.toFixed(3)}\n${"=".repeat(70)}`);

  let anyBad = 0, engFired = 0;
  turns.forEach((t, i) => {
    const v = t.visible;
    const bad = BAD[lang].filter((re) => re.test(v));
    const eng = overstatesEnglish(v);
    if (eng) engFired++;
    if (bad.length) {
      anyBad++;
      console.log(`\n!! turn ${i + 1} (${t.pct}%) — ${lang} overstatement pattern matched:`);
      bad.forEach((re) => { const m = v.match(re); console.log(`     "${m[0]}"`); });
      console.log(`   English guard would have fired: ${eng}`);
    }
  });

  console.log(`\nsummary: ${anyBad}/${turns.length} turns matched a ${lang} overstatement pattern`);
  console.log(`         ${engFired}/${turns.length} turns the ENGLISH guard would have caught`);
  const last = turns[turns.length - 1].visible;
  console.log(`closing turn uses correct conditional framing: ${GOOD[lang].test(last)}`);
}

// CONTROL: sentences that unambiguously overstate. If these do not trip the
// detector, "0 matches" on the transcripts means nothing.
console.log("\n" + "=".repeat(70) + "\nDETECTOR CONTROL — these MUST all be caught\n" + "=".repeat(70));
const CONTROLS = {
  French: [
    "Votre configuration est maintenant active et Lumen surveille désormais vos marques.",
    "Tout est en place ! Vous recevez maintenant vos alertes chaque matin.",
    "Vous êtes prêt — à partir de maintenant, vous verrez toutes les mentions.",
  ],
  German: [
    "Ihre Einrichtung ist jetzt aktiv und Lumen überwacht ab sofort Ihre Marken.",
    "Alles ist bereit! Sie erhalten ab sofort Ihre Benachrichtigungen.",
    "Sie sind startklar — das Monitoring läuft jetzt.",
  ],
};
const SAFE = {
  French: ["Une fois que votre consultant aura activé tout cela, vous verrez toutes les mentions."],
  German: ["Sobald Ihr Consultant das aktiviert, erhalten Sie wöchentliche Updates."],
};
for (const lang of ["French", "German"]) {
  for (const s of CONTROLS[lang]) {
    const hit = BAD[lang].some((re) => re.test(s));
    console.log(`  ${hit ? "CAUGHT " : "MISSED!"} [${lang}] ${s.slice(0, 62)}...`);
  }
  for (const s of SAFE[lang]) {
    const hit = BAD[lang].some((re) => re.test(s));
    console.log(`  ${hit ? "FALSE+!" : "ok     "} [${lang}] (correct framing) ${s.slice(0, 46)}...`);
  }
}
