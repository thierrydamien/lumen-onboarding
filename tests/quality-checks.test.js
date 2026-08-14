// The one-question-per-message counter used by tools/ab-harness.mjs.
//
// Every fixture below is a VERBATIM visible reply captured from the deployed
// build during live conversations, so this pins the counter against what the
// model actually says rather than against invented examples.
//
// Accuracy on those 40 real turns: a naive "?" count flags 9, this counter
// flags 7, and reading them by hand puts the true number at 6. It is a
// COMPARATIVE instrument — a residual over-count that applies equally to both
// arms of an A/B still leaves the delta meaningful — and ab-transcripts.txt is
// written on every harness run so the number can be checked by reading.

import { describe, it, expect } from "vitest";
import { countQuestions, multiQuestion, visibleOf } from "../tools/quality-checks.mjs";
import { stripAll } from "../src/lumen.jsx";

// The harness cannot import src/lumen.jsx (JSX, pulls in React), so it carries a
// copy of the client's stripping. Vitest CAN import both, so pin them together
// here — drift between them is what made a whole A/B run unreadable.
describe("the harness sees what the client sees", () => {
  const CASES = [
    // The exact failure: the prompt asks for <thought>, the model often emits
    // <thinking>. Production strips all four spellings; the harness stripped one,
    // so an entire reasoning block was scored and judged as visible prose.
    "<thinking>The client wants exclusions. I should fold these into keywords. Do they mean weather? Or the tech company?</thinking>\n\nI'll add those exclusions now.",
    "<thought>terse plan</thought>\n\nWhat markets matter most?",
    "<think>short</think>\n\nGot it.",
    "<thoughts>plural spelling</thoughts>\n\nUnderstood.",
    // Brace form is what the prompt specifies; the harness matched only a
    // bracketed form that the model never emits.
    'Here are your topics.\nTOPIC_SUGGESTION{"name":"Acme","keywords":"acme"}\nDoes that look right?',
    '%%PROGRESS%%{"section":"intro","percent":0,"collected":{}}%%END%%\n\nWelcome!',
    "Pick your markets.\n\n[WIDGET:MARKETS]",
    "How experienced are you?\n\n[SUGGESTIONS: Just starting | Some experience]",
    "We can send what we have.\n\n[OFFER_SEND]",
    "Voilà.\n<thinking>truncated mid-block",
  ];

  for (const raw of CASES) {
    it(`agrees with stripAll on: ${JSON.stringify(raw.slice(0, 44))}…`, () => {
      expect(visibleOf(raw)).toBe(stripAll(raw));
    });
  }

  it("does not count a leaked reasoning block as questions", () => {
    const leaked = "<thinking>Should I ask about markets? Or objectives? Maybe both?</thinking>\n\nWhich markets matter most to you?";
    expect(countQuestions(leaked)).toBeGreaterThan(1);          // raw text is full of them
    expect(multiQuestion(visibleOf(leaked))).toBe(false);       // what the client sees is one question
  });
});

describe("genuine violations are caught", () => {
  it("catches a question followed by a rephrasing of itself", () => {
    // FR turn 3, and the same shape appeared in ES and IT.
    expect(multiQuestion("Avant de rentrer dans les détails : qu'est-ce que vous espérez obtenir de Lumen ? Qu'est-ce qui vous a amené à vous lancer dans cet outil ?")).toBe(true);
    expect(multiQuestion("Antes de entrar en los detalles técnicos, me gustaría entenderte mejor: ¿qué esperas conseguir con Lumen? ¿Qué te llevó a dar este paso ahora?")).toBe(true);
  });

  it("catches a confirmation paired with a new question", () => {
    // DE turn 2 — the other shape, and the one the German flow reached for.
    expect(multiQuestion("Nordlicht Brauerei aus Hamburg — ich gehe davon aus, dass Sie im Bereich Craft Beer unterwegs sind — passt das so? Und damit ich Ihre Einrichtung zuordnen kann: Welche E-Mail-Adresse sollen wir verwenden?")).toBe(true);
  });

  it("catches two distinct asks in one message", () => {
    // FR turn 16.
    expect(multiQuestion("Pour Caudalie et Nuxe, je vais créer un sujet séparé pour chacune. Est-ce que ça vous convient ? Et je voulais aussi confirmer : on garde le sujet Sylve, ou vous préférez le laisser de côté ?")).toBe(true);
  });
});

describe("a single question is not a violation", () => {
  it("accepts one plain question", () => {
    expect(multiQuestion("Pour commencer : quel est le nom de votre entreprise ?")).toBe(false);
    expect(multiQuestion("ما اسم شركتك؟")).toBe(false);
    expect(countQuestions("Which markets matter most to you?")).toBe(1);
  });

  it("does not count an illustrative example that ends in a question mark", () => {
    // FR turn 4: one ask, then an example. Reads as a single question.
    expect(multiQuestion("Est-ce qu'il y a une décision concrète que ça aiderait à prendre ? Par exemple, savoir si un lancement produit est bien perçu ?")).toBe(false);
    expect(multiQuestion("Is there a concrete decision this would inform? For example, whether the Q4 budget is working?")).toBe(false);
  });

  it("applies the example filter to Arabic too", () => {
    // AR turn 6. This regressed silently at first: the filter ended in \b, which
    // is defined against [A-Za-z0-9_] and so never matches after Arabic script,
    // meaning the exclusion could not fire in the one language most likely to
    // need it. Guards the \p{L} lookahead that replaced it.
    expect(multiQuestion("ما الكلمات أو الأسماء التي تتوقع أن يكتبها الناس لما يتحدثون عن الواحة؟ مثلاً اسم المجموعة، أو اسم المشروع المحدد؟")).toBe(false);
  });

  it("handles empty and junk input", () => {
    for (const v of ["", null, undefined, "No questions here.", "Merci !"]) {
      expect(multiQuestion(v)).toBe(false);
    }
  });
});

describe("known limitation, pinned so it is not mistaken for a regression", () => {
  it("still over-counts an appositive list that ends in a question mark", () => {
    // FR turn 17. One ask, with the alternatives trailing as a fragment. A human
    // reads this as a single question; the counter does not. Documented rather
    // than papered over — chasing it would need real parsing, and a consistent
    // over-count that applies to both A/B arms does not distort the delta.
    expect(multiQuestion("Est-ce que l'un de ces mots est aussi utilisé pour autre chose qui n'a rien à voir avec vous ? Une autre marque, un lieu, un mot courant ?")).toBe(true);
  });
});
