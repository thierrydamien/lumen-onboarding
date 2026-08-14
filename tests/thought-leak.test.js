// The model plans out loud inside the hidden <thought> block, and while planning
// it writes the very control tokens the client parser looks for. parseReply used
// to extract from the RAW reply, so those planning mentions were obeyed as if the
// model had emitted them for real.
//
// The opening fixture is a VERBATIM reply captured from a live French session
// against the deployed backend — this is what the model actually does, not a
// hypothetical. The variants below are the same shape with the thought naming a
// different token from the one the turn really emits, which is the case that
// turns a harmless duplicate into a visible malfunction.

import { describe, it, expect } from "vitest";
import { parseReply } from "../src/lumen.jsx";

// Captured live, turn 7 of a French conversation (deployed build 8d725b7).
const LIVE_TURN = "<thought>no existing material; guided flow confirmed; next: STEP 4B — [WIDGET:MARKETS] with one context sentence</thought>\n\n%%PROGRESS%%{\"section\":\"topics\",\"percent\":18,\"collected\":{\"company\":\"Maison Verlaine\"}}%%END%%\n\nParfait, on part d'une belle page blanche alors ! Pour commencer, dites-moi sur quels marchés Maison Verlaine est présente.\n\n[WIDGET:MARKETS]";

describe("the hidden <thought> block is never a source of control tokens", () => {
  it("keeps a real live reply to exactly the one widget it emitted", () => {
    // The thought and the body name the SAME widget here, so the old code got
    // away with it via de-duplication. Pinning it stops a future 'optimisation'
    // from reintroducing raw extraction and passing this file.
    expect(parseReply(LIVE_TURN).widgets).toEqual(["MARKETS"]);
  });

  it("does not render a widget the model only reasoned about", () => {
    const r = "<thought>markets are done; next I should do [WIDGET:TEAMS]</thought>\n\nEt côté objectifs ?\n\n[WIDGET:OBJECTIVES]";
    expect(parseReply(r).widgets).toEqual(["OBJECTIVES"]);
  });

  it("does not render the two widgets the prompt forbids showing", () => {
    // The prompt tells the model "NEVER show [WIDGET:LANGUAGES] or
    // [WIDGET:TIMEZONE]" — so a thought that reasons about that rule used to
    // make the client render precisely those two.
    const r = "<thought>inferred setup: propose in prose, never show [WIDGET:LANGUAGES] or [WIDGET:TIMEZONE]</thought>\n\nJe vous propose le français, fuseau Europe/Paris — ça vous va ?";
    expect(parseReply(r).widgets).toEqual([]);
  });

  it("keeps quick-reply chips that a phantom widget would have deleted", () => {
    // quickReplies are suppressed whenever a widget is present, so one phantom
    // widget silently strips the chips off a turn whose chips the prompt
    // requires "every time and without exception" (the calibration step).
    const r = "<thought>calibration; after this comes [WIDGET:MARKETS]</thought>\n\nVous avez déjà utilisé un outil d'écoute ?\n\n[SUGGESTIONS: Je débute | Un peu d'expérience | Très expérimenté(e)]";
    const pr = parseReply(r);
    expect(pr.widgets).toEqual([]);
    expect(pr.quickReplies).toEqual(["Je débute", "Un peu d'expérience", "Très expérimenté(e)"]);
  });

  it("does not offer an early send the model only weighed up", () => {
    const r = "<thought>client sounds busy but not leaving — do NOT emit [OFFER_SEND] yet</thought>\n\nOn continue : quels sont vos concurrents ?";
    expect(parseReply(r).offerSend).toBe(false);
  });

  it("does not build topic cards from a topic shape inside the thought", () => {
    const r = "<thought>plan: TOPIC_SUGGESTION{\"name\":\"draft\",\"keywords\":\"x\"} maybe later</thought>\n\nParlons de vos marques.";
    expect(parseReply(r).topicSuggestions).toEqual([]);
  });

  it("still reads the tokens the model really emitted alongside a thought", () => {
    // Guard against over-stripping: the fix must not swallow real output.
    const r = "<thought>emit company + offer send</thought>\n\n%%COMPANY%%{\"name\":\"Acme\"}%%END%%\n\nOn peut envoyer ce qu'on a.\n\n[OFFER_SEND]";
    const pr = parseReply(r);
    expect(pr.offerSend).toBe(true);
    expect(pr.companyData).toEqual({ name: "Acme" });
    expect(pr.clean).toBe("On peut envoyer ce qu'on a.");
  });

  it("handles a reply truncated mid-thought without inventing widgets", () => {
    const r = "Voilà.\n<thought>next up [WIDGET:USERS] and then";
    const pr = parseReply(r);
    expect(pr.widgets).toEqual([]);
    expect(pr.clean).toBe("Voilà.");
  });
});
