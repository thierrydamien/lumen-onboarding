// public/index.html — the internal team hub at the site root.
//
// Static signposting, no script, so the only things that can rot are the three
// links and the semantics. It had no tests; these are cheap insurance on a page
// whose whole job is to point at the other two tools correctly.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const hub = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");

describe("it points at tools that exist", () => {
  it("links to the three friendly paths and nothing else", () => {
    const hrefs = [...hub.matchAll(/<a class="card[^"]*" href="([^"]+)"/g)].map(m => m[1]);
    expect(hrefs).toEqual(["/sales", "/dashboard", "/chat"]);
  });

  it("every link it offers has a redirect behind it", () => {
    // A friendly path with no redirect 404s, and this page is the only thing
    // advertising them, so the two would rot together and silently.
    for (const path of ["/sales", "/dashboard", "/chat"]) {
      expect(toml, `${path} has no redirect in netlify.toml`).toMatch(
        new RegExp(`from = "${path}"[\\s\\S]{0,80}to = "${path}\\.html"`)
      );
    }
  });

  it("stays out of search results", () => {
    // It names the internal tools and who they are for.
    expect(hub).toMatch(/<meta name="robots" content="noindex, nofollow"\s*\/?>/);
  });
});

describe("its structure is navigable, not just visually grouped", () => {
  it("wraps the content in a main landmark", () => {
    expect(hub).toContain("<main>");
    expect(hub).toContain("</main>");
  });

  it("makes the two section labels real headings", () => {
    // They were <p class="eyebrow">, styled to look like headings. Browsing by
    // heading found only the h1, so neither section was reachable that way.
    expect(hub).toMatch(/<h2 class="eyebrow">Setting up a client<\/h2>/);
    expect(hub).toMatch(/<h2 class="eyebrow">Demo &amp; testing<\/h2>/);
    expect(hub).not.toMatch(/<p class="eyebrow">/);
  });

  it("has exactly one h1 and no skipped levels", () => {
    const levels = [...hub.matchAll(/<h([1-6])[\s>]/g)].map(m => Number(m[1]));
    expect(levels.filter(l => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    expect(new Set(levels)).toEqual(new Set([1, 2]));
  });

  it("does not put flow content inside phrasing content", () => {
    // <p> inside <span class="txt"> is a content-model violation. Chrome keeps the
    // DOM the author meant, but nothing guarantees another parser will.
    //
    // Asserted on the descriptions directly. Trying to slice out each <span
    // class="txt"> block with a regex is not worth it: HTML nests, the lazy
    // quantifier wandered across element boundaries in two different ways, and
    // both times it failed against markup that was already correct. The DOM check
    // that actually proved this (document.querySelectorAll("span > p") === 0) was
    // run in a browser.
    expect(hub).not.toMatch(/<p class="d"/);
    expect(hub.match(/<span class="d">/g)).toHaveLength(3);
    expect(hub).toMatch(/\.d\{display:block;/);
  });

  it("marks the logo decorative rather than announcing it", () => {
    // The wordmark next to it already says "Lumen by Talkwalker".
    expect(hub).toMatch(/<img src="\/lumen-mark\.png" alt=""\/>/);
  });
});

describe("it renders in both themes", () => {
  it("defines a dark scheme rather than inheriting a white page", () => {
    expect(hub).toMatch(/@media \(prefers-color-scheme:dark\)/);
  });

  it("keeps the client's own step unclickable", () => {
    // There is no generic client link to hand out — every client gets their own
    // from Sales — so presenting it as a third card would invite a wrong turn.
    const between = hub.slice(hub.indexOf('<div class="between">'), hub.indexOf("</div>", hub.indexOf('<div class="between">')));
    expect(between).not.toContain("<a ");
    expect(between).not.toContain("href");
  });
});
