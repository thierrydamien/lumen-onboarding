// Tests for the %%MARKER%% parser: the single highest-risk untested path in the app.
// Everything the client reads is whatever survives stripAll, and the dangling/
// unparseable detectors are what decide whether a malformed generation is silently
// shown to the client or quietly retried.

import { describe, it, expect } from "vitest";
import { stripAll, hasDanglingMarker, hasUnparseableMarker } from "../src/lumen.jsx";

const PROGRESS = '%%PROGRESS%%{"section":"intro","percent":0,"collected":{}}%%END%%';

describe("stripAll", () => {
  it("removes complete markers and leaves the prose", () => {
    expect(stripAll(PROGRESS + "\n\nGreat, thanks. What is your company called?"))
      .toBe("Great, thanks. What is your company called?");
  });

  it("removes widget, suggestion, offer and topic tags", () => {
    const raw = [
      "[WIDGET:MARKETS]",
      "Which markets matter most?",
      "[SUGGESTIONS: Just getting started | Some experience]",
      "[OFFER_SEND]",
      'TOPIC_SUGGESTION{"name":"Acme","keywords":"acme"}',
    ].join("\n");
    expect(stripAll(raw)).toBe("Which markets matter most?");
  });

  it("removes the hidden thought block, closed or truncated", () => {
    expect(stripAll("<thought>terse notes</thought>Visible reply.")).toBe("Visible reply.");
    // A reply cut off mid-thought must not leak the reasoning to the client.
    expect(stripAll("Visible reply.\n<thought>cut off here")).toBe("Visible reply.");
  });

  it("truncates at a marker that was cut off mid-emit rather than rendering raw JSON", () => {
    const out = stripAll('Here you go.\n%%COMPANY%%{"name":"Acme"');
    expect(out).toBe("Here you go.");
    expect(out).not.toContain("%%");
    expect(out).not.toContain("Acme");
  });

  it("collapses the blank-line holes left where markers were removed", () => {
    expect(stripAll(PROGRESS + "\n\n\n\nOne.\n\n\n\nTwo.")).toBe("One.\n\nTwo.");
  });
});

describe("hasDanglingMarker", () => {
  it("is false for a well-formed reply", () => {
    expect(hasDanglingMarker(PROGRESS + "\nAll good.")).toBe(false);
  });

  it("is true when an opener has no %%END%% — the signature of a truncated generation", () => {
    expect(hasDanglingMarker('%%COMPANY%%{"name":"Acme"')).toBe(true);
    expect(hasDanglingMarker(PROGRESS + '\n%%TOPICS%%[{"name":"Acme"')).toBe(true);
  });
});

describe("hasUnparseableMarker", () => {
  it("is false when every complete marker holds valid JSON", () => {
    expect(hasUnparseableMarker(PROGRESS)).toBe(false);
  });

  it("is true when a complete marker holds a malformed body", () => {
    // An unescaped quote in a free-text HANDOFF field parses to null and would
    // otherwise be dropped silently, on the one turn the handoff matters.
    expect(hasUnparseableMarker('%%HANDOFF%%{"consultantTips":"they said "yes""}%%END%%')).toBe(true);
  });
});
