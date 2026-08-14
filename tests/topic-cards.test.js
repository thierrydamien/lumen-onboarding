// Topic cards must not throw away the client's own edits.
//
// Found by driving the app: rename both suggested topics, Confirm (the model DOES
// receive the edits), then click Edit to tweak one thing — and every card reverted to
// the model's original wording. Confirming again would have overwritten the client's
// good data with the AI's first guesses. Topics are what Lumen actually gets configured
// with, so it was the worst possible field to silently lose.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
const component = src.slice(src.indexOf("function TopicCards("), src.indexOf("function TopicCards(") + 1800);
const renderSite = src.slice(src.indexOf('{type==="TOPICS"'), src.indexOf('{type==="TOPICS"') + 400);

describe("TopicCards accepts a previous confirmation", () => {
  it("takes initialData, like every other widget at the call site", () => {
    expect(component).toMatch(/function TopicCards\(\{[^}]*initialData/);
  });

  it("is actually passed initialData when rendered", () => {
    // The bug was purely at the call site: the prop existed nowhere, so the component
    // could only ever re-seed from the model's batch.
    expect(renderSite).toMatch(/initialData=\{pd\}/);
  });

  it("prefers a stored confirmation over the model's suggestions", () => {
    expect(component).toMatch(/Array\.isArray\(initialData\) && initialData\.length \? initialData : suggestions/);
  });

  it("seeds state from that choice, not from suggestions directly", () => {
    // useState(suggestions.map(...)) is the exact shape of the original bug.
    expect(component).not.toMatch(/useState\(suggestions\.map\(/);
    expect(component).toMatch(/useState\(seed\.map\(/);
  });

  it("still renders when only a stored confirmation exists", () => {
    // Guarding on topicSuggestions alone would hide the widget on reopen if the model's
    // later turn carried no suggestions, stranding the client's confirmed topics.
    expect(renderSite).toMatch(/pd\?\.length>0 \|\| topicSuggestions\?\.length>0/);
  });

  it("preserves a card's own status rather than forcing everything back to kept", () => {
    // Otherwise reopening would silently resurrect topics the client had discarded.
    expect(component).toMatch(/status:s\.status\|\|"kept"/);
  });
});
