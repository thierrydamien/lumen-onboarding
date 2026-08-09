// What the stored draft keeps, and how long a finished reply survives being read.

import { describe, it, expect } from "vitest";
import { draftPayload } from "../src/lumen.jsx";
import { consumeAction } from "../netlify/functions/chat-status.js";

describe("draftPayload", () => {
  const snap = () => ({
    messages: [
      { role: "assistant", content: "Great, thanks.", raw: '%%PROGRESS%%{"percent":15}%%END%%<thought>terse</thought>Great, thanks.' },
      { role: "user", content: "Acme Corp" },
    ],
    history: Array.from({ length: 200 }, (_, i) => ({ role: "user", content: "turn " + i })),
    cdata: { company: { name: "Acme Corp" } },
    uiLang: "English",
  });

  it("never persists the unstripped model output", () => {
    // raw carried every %%MARKER%% block plus the hidden <thought> reasoning, and the
    // draft is retrievable by any holder of the client link.
    const out = draftPayload(snap());
    for (const m of out.messages) expect(m).not.toHaveProperty("raw");
    expect(JSON.stringify(out)).not.toContain("<thought>");
  });

  it("keeps everything the resume actually needs", () => {
    const out = draftPayload(snap());
    expect(out.messages.map(m => m.content)).toEqual(["Great, thanks.", "Acme Corp"]);
    expect(out.messages[0].role).toBe("assistant");
    expect(out.cdata.company.name).toBe("Acme Corp");
    expect(out.uiLang).toBe("English");
  });

  it("still trims the model history", () => {
    expect(draftPayload(snap()).history.length).toBe(80);
  });

  it("tolerates a malformed snapshot rather than throwing", () => {
    expect(() => draftPayload({})).not.toThrow();
    expect(() => draftPayload({ messages: null, history: null })).not.toThrow();
  });
});

describe("chat-status retention", () => {
  const GRACE = 60_000;

  it("keeps a freshly generated reply on first read", () => {
    // Deleting on sight destroyed the only copy: a lost poll response meant the
    // client re-rolled a whole new (paid) generation.
    expect(consumeAction({ status: 200, body: {} }, 1_000_000)).toBe("stamp");
  });

  it("serves the same reply again to a repeat poll inside the window", () => {
    const consumedAt = 1_000_000;
    expect(consumeAction({ consumedAt }, consumedAt + 500)).toBe("keep");
    expect(consumeAction({ consumedAt }, consumedAt + GRACE)).toBe("keep");
  });

  it("cleans up once the window has passed", () => {
    const consumedAt = 1_000_000;
    expect(consumeAction({ consumedAt }, consumedAt + GRACE + 1)).toBe("delete");
  });

  it("treats a missing or malformed stamp as a first read, keeping the reply", () => {
    // Erring toward keeping is the safe direction: worst case is a stale few KB.
    expect(consumeAction({ consumedAt: "nope" }, 1_000_000)).toBe("stamp");
    expect(consumeAction({}, 1_000_000)).toBe("stamp");
    expect(consumeAction(null, 1_000_000)).toBe("stamp");
  });
});
