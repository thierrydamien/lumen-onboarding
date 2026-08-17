// Response headers, and the assumptions that make them safe.
//
// The site shipped with none. These are cheap, but two of them are only correct
// because of facts elsewhere in the repo, so the facts are asserted too — a
// header block that silently stops matching reality is worse than none, because
// it reads as a control that is being enforced.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const toml = readFileSync(new URL("../netlify.toml", import.meta.url), "utf8");
const block = toml.slice(toml.indexOf("[[headers]]"));

describe("the headers are declared", () => {
  it("applies to every path", () => {
    expect(block).toMatch(/for = "\/\*"/);
  });

  it("refuses framing two ways", () => {
    // frame-ancestors is the modern control; X-Frame-Options still covers
    // browsers that predate it. They agree, so neither can be the odd one out.
    expect(block).toMatch(/X-Frame-Options = "DENY"/);
    expect(block).toMatch(/Content-Security-Policy = "frame-ancestors 'none'"/);
  });

  it("stops content-type sniffing", () => {
    expect(block).toMatch(/X-Content-Type-Options = "nosniff"/);
  });

  it("never lets the full URL leave the origin", () => {
    // The seed id lives in the query string, so a policy that sends the path
    // cross-origin would hand out the client's session link.
    expect(block).toMatch(/Referrer-Policy = "strict-origin-when-cross-origin"/);
    expect(block).not.toMatch(/Referrer-Policy = "(unsafe-url|no-referrer-when-downgrade|origin-when-cross-origin)"/);
  });
});

describe("the assumptions the headers rest on still hold", () => {
  it("nothing in the repo embeds anything, so DENY breaks nothing", () => {
    // The moment something legitimately needs to be framed, DENY becomes an
    // outage rather than a control, and this is where that gets caught.
    const roots = ["public", "src", "demo"];
    const hits = [];
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) { walk(`${dir}/${e.name}`); continue; }
        if (!/\.(html|jsx?|tsx?)$/.test(e.name)) continue;
        const body = readFileSync(new URL(`../${dir}/${e.name}`, import.meta.url), "utf8");
        if (/<iframe/i.test(body)) hits.push(`${dir}/${e.name}`);
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });

  it("every link a client can click still carries rel=noreferrer", () => {
    // Belt and braces with Referrer-Policy: these are the only two outbound
    // links reachable from the client's own session, and its URL is the secret.
    const client = readFileSync(new URL("../src/lumen.jsx", import.meta.url), "utf8");
    const external = [...client.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)].map(m => m[0]);
    expect(external.length).toBeGreaterThan(0);
    for (const tag of external) expect(tag, tag.slice(0, 90)).toMatch(/rel="noopener noreferrer"/);
  });

  it("fonts are self-hosted, so no font CDN needs allowlisting", () => {
    // If a page goes back to fonts.googleapis.com this note stops being true and
    // a future CSP would silently block it.
    for (const page of ["sales.html", "dashboard.html", "index.html"]) {
      const body = readFileSync(new URL(`../public/${page}`, import.meta.url), "utf8");
      expect(body, `${page} loads fonts from a CDN`).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
  });
});
