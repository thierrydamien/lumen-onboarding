// Four defects from the audit backlog, each one a silent data-loss or
// wrong-affordance path a client would hit without ever seeing an error.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { isAttachToken, unionUsers, extractFileText, QueriesWidget } from "../src/lumen.jsx";

describe("isAttachToken only matches the one literal token", () => {
  it("accepts the token the prompt guarantees", () => {
    expect(isAttachToken("@ATTACH")).toBe(true);
    expect(isAttachToken("  @ATTACH  ")).toBe(true);
    expect(isAttachToken("@attach")).toBe(true); // tolerate a stray lowercasing
  });

  it("still accepts a translated token, which is why this is an allowlist", () => {
    // The prompt says never to translate it; this is the net for when it does.
    for (const t of ["@JOINDRE", "@ANHÄNGEN", "@ADJUNTAR", "@ALLEGARE", "@إرفاق"]) {
      expect(isAttachToken(t)).toBe(true);
    }
  });

  it("leaves a social handle as a normal answer chip", () => {
    // The channels step legitimately offers handles as chips. Under the old
    // /^@[\p{L}_]+$/u these all became "Attach a document" buttons, so the
    // client could not choose their own handle at all — which is the whole
    // reason the loose regex had to go.
    expect(isAttachToken("@maisonverlaine")).toBe(false);
    expect(isAttachToken("@nuxe")).toBe(false);
    expect(isAttachToken("@caudalie")).toBe(false);
    expect(isAttachToken("@الواحة")).toBe(false);
    expect(isAttachToken("@AlwahaRealEstate")).toBe(false);
  });

  it("is false for ordinary answers and junk", () => {
    for (const v of ["ATTACH", "", null, undefined, "@", "@ATTACH now", "no"]) {
      expect(isAttachToken(v)).toBe(false);
    }
  });
});

describe("unionUsers keeps distinct people who share a mailbox", () => {
  it("keeps two different names on one shared address", () => {
    // A team alias (info@, marketing@) or a PA on a director's address. Keying
    // on email alone dropped the second person silently — the chat reported two,
    // the brief carried one, and that person never got access provisioned.
    const out = unionUsers(
      [{ firstName: "Anne", lastName: "Dupont", email: "info@acme.com" }],
      [{ firstName: "Marc", lastName: "Lefevre", email: "info@acme.com" }],
    );
    expect(out).toHaveLength(2);
    expect(out.map(u => u.firstName).sort()).toEqual(["Anne", "Marc"]);
  });

  it("still merges the same person captured twice", () => {
    const out = unionUsers(
      [{ firstName: "Anne", lastName: "Dupont", email: "anne@acme.com" }],
      [{ firstName: "anne", lastName: "DUPONT", email: "Anne@Acme.com" }],
    );
    expect(out).toHaveLength(1);
  });

  it("folds a by-email-only mention into the named entry, in either order", () => {
    // %%USERS%% can name a report recipient by email before their name is known.
    const named = { firstName: "Anne", lastName: "Dupont", email: "anne@acme.com" };
    const bare = { email: "anne@acme.com" };
    expect(unionUsers([named], [bare])).toHaveLength(1);
    expect(unionUsers([bare], [named])).toHaveLength(1);
    expect(unionUsers([bare], [named])[0].firstName).toBe("Anne");
  });

  it("drops blank rows and tolerates junk input", () => {
    expect(unionUsers([{ firstName: "", email: "" }, {}], null)).toEqual([]);
    expect(unionUsers(undefined, undefined)).toEqual([]);
    expect(unionUsers("nonsense", 42)).toEqual([]);
  });

  it("keeps two people who have names but no email at all", () => {
    const out = unionUsers([{ firstName: "Anne" }, { firstName: "Marc" }], []);
    expect(out).toHaveLength(2);
  });
});

describe("file import honours the allowlist it advertises", () => {
  // Minimal stand-in for File: extractFileText only reads size/name/type/text().
  const f = (name, type, text = "hello") => ({ name, type, size: text.length, text: async () => text });

  it("reads the formats the UI promises", async () => {
    expect(await extractFileText(f("queries.txt", "text/plain"))).toEqual({ text: "hello" });
    expect(await extractFileText(f("queries.csv", "text/csv"))).toEqual({ text: "hello" });
  });

  it("still reads a genuine text file with an odd or missing extension", async () => {
    // This is what the MIME fallback exists for, so narrowing it must not kill it.
    expect(await extractFileText(f("queries", "text/plain"))).toEqual({ text: "hello" });
  });

  it("rejects other text/* types the allowlist never promised", async () => {
    // startsWith("text/") made the extension allowlist advisory: the UI says it
    // reads .txt/.csv/.xlsx/.docx, then read these anyway and forwarded the raw
    // bytes on as a requirements document.
    for (const [name, type] of [["page.html", "text/html"], ["app.js", "text/javascript"], ["data.xml", "text/xml"], ["style.css", "text/css"]]) {
      expect(await extractFileText(f(name, type))).toEqual({ error: "unsupported" });
    }
  });

  it("rejects an oversized file before reading it into memory", async () => {
    const big = { name: "huge.txt", type: "text/plain", size: 3 * 1024 * 1024, text: async () => { throw new Error("must not read"); } };
    expect((await extractFileText(big)).error).toBe("tooLarge");
  });
});

describe("the queries widget cannot silently discard pasted text", () => {
  const html = (props) => renderToStaticMarkup(React.createElement(QueriesWidget, { onSubmit() {}, lang: "English", ...props }));

  // Read the attributes of the "No queries" button ITSELF. Scanning nearby markup
  // instead picks up Submit's own (correct) disabled attribute and passes for the
  // wrong reason.
  const noQueriesAttrs = (out) => {
    const m = out.match(/<button([^>]*)>No queries<\/button>/);
    if (!m) throw new Error('no "No queries" button in the rendered output');
    return m[1];
  };

  it('disables "No queries" once the box has content', () => {
    // This widget is the only path that preserves a client's original query
    // syntax verbatim, so discarding it is unrecoverable.
    expect(noQueriesAttrs(html({ initialData: "brand AND (launch OR release)" }))).toContain("disabled");
  });

  it('leaves "No queries" clickable when the box is empty', () => {
    expect(noQueriesAttrs(html({}))).not.toContain("disabled");
  });

  it("still lets Submit through when there is text", () => {
    const out = html({ initialData: "brand AND launch" });
    const submit = out.match(/<button([^>]*)>Submit queries<\/button>/)[1];
    expect(submit).not.toContain("disabled");
  });
});
