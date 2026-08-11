// Archive / restore / permanent delete.
//
// The rules that matter are the ones a UI can't be trusted to enforce, so they are
// tested against the shipped source rather than a restatement of it:
//   - permanent deletion is refused unless the record is ALREADY archived
//   - archiving a session also hides the "link sent" seed row beside it
//   - archiving never deletes, and never breaks the client's link
//   - a still-open client tab cannot resurrect an archived row via autosave
//   - there is no second password: the dashboard token gates everything, and the
//     archive-before-delete guard is what stands in for a confirmation step

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const admin = read("../netlify/functions/session-admin.js");
const session = read("../netlify/functions/session.js");
const seed = read("../netlify/functions/seed.js");

describe("permanent delete is gated on archive, server-side", () => {
  it("refuses to delete a record that is not archived", () => {
    // Both delete paths (session row and orphan seed row) must carry the guard, or a
    // scripted call could skip the archive step the UI enforces.
    const guards = admin.match(/if \(!rec\.archivedAt\) return \{ id, ok: false, error: "not_archived" \};/g) || [];
    expect(guards.length).toBe(2);
  });

  it("guards the delete BEFORE any destructive call", () => {
    // Ordering matters: a guard placed after the first delete would still destroy data.
    for (const fn of ["applyToSession", "applyToSeed"]) {
      const body = admin.slice(admin.indexOf("async function " + fn));
      const guardAt = body.indexOf("not_archived");
      const firstDelete = body.search(/\.delete\(/);
      expect(guardAt, fn).toBeGreaterThan(-1);
      expect(firstDelete, fn).toBeGreaterThan(guardAt);
    }
  });
});

describe("auth", () => {
  it("requires the dashboard token, and nothing else", () => {
    // No second password: the archive-before-delete guard and the dashboard's own
    // confirm dialogs are what stand in for one.
    expect(admin).toContain("DASHBOARD_TOKEN");
    expect(admin).toContain("x-dashboard-token");
    expect(admin).not.toContain("DASHBOARD_ADMIN_TOKEN");
    expect(admin).not.toContain("x-admin-token");
  });

  it("compares the token in constant time", () => {
    expect(admin).toContain("timingSafeEqual");
  });

  it("is rate limited", () => {
    expect(admin).toMatch(/rateLimit\(req, "session-admin"/);
  });
});

describe("archive is visibility only", () => {
  it("hides the session row and its 'link sent' seed row together", () => {
    // Otherwise archiving a test leaves its other half on screen.
    const fn = admin.slice(admin.indexOf("async function applyToSession"), admin.indexOf("async function applyToSeed"));
    expect(fn).toContain("seeds.setJSON");
    expect(fn).toContain("archivedAt");
  });

  it("does not delete anything on archive or restore", () => {
    const fn = admin.slice(admin.indexOf("async function applyToSession"), admin.indexOf("async function applyToSeed"));
    const afterDeleteBranch = fn.slice(fn.indexOf("const archivedAt ="));
    expect(afterDeleteBranch).not.toMatch(/\.delete\(/);
  });

  it("keeps an archived client link working", () => {
    // seed.js filters archived seeds out of the dashboard LIST, but the GET-by-id
    // branch the chat page uses must not filter them, or archiving would silently
    // break a real client's in-flight onboarding.
    const listBranch = seed.slice(seed.indexOf("// List:"));
    expect(listBranch).toContain("archivedAt");
    const byIdBranch = seed.slice(seed.indexOf("if (id) {"), seed.indexOf("// List:"));
    expect(byIdBranch).not.toContain("archivedAt");
  });
});

describe("an archived row cannot be resurrected by a client autosave", () => {
  it("session.js carries archivedAt across every write", () => {
    // Autosave POSTs the whole record and omits archivedAt; without this the row
    // reappears minutes after being archived, which reads as "archiving is broken".
    expect(session).toMatch(/if \(prev && prev\.archivedAt && !record\.archivedAt\) record\.archivedAt = prev\.archivedAt;/);
  });

  it("preserves it for in-progress writes too, not just completed ones", () => {
    // The preservation must sit ABOVE the status branch, so it applies to both.
    const preserveAt = session.indexOf("prev.archivedAt");
    const branchAt = session.indexOf('if (record.status !== "completed")');
    expect(preserveAt).toBeGreaterThan(-1);
    expect(preserveAt).toBeLessThan(branchAt);
  });

  it("still returns the archived flag to the dashboard", () => {
    expect(session).toMatch(/archivedAt: r\.archivedAt \|\| null/);
  });
});

describe("bulk safety", () => {
  it("caps how many records one request can touch", () => {
    expect(admin).toMatch(/MAX_ITEMS = \d+/);
    expect(admin).toContain("too_many_items");
  });

  it("validates ids against the shapes each store actually mints", () => {
    expect(admin).toContain("SESSION_ID_RE");
    expect(admin).toContain("SEED_ID_RE");
    expect(admin).toContain("bad_item");
  });
});
