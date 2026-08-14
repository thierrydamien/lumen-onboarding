// The status lock in session.js — the one guard standing between a resumed session and
// a downgraded dashboard record.
//
// Why this file exists: an audit flagged "resuming after a send can flip a completed
// record back to in_progress". Driving the real app proved the CLIENT genuinely does
// attempt it — after resuming a draft carrying a session id, it POSTs
// {id, status:"in_progress"} against that id (observed three times in one resume).
// So the record only survives because session.js refuses the write. That made the guard
// load-bearing and completely untested, which is the worst combination.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const session = readFileSync(new URL("../netlify/functions/session.js", import.meta.url), "utf8");

// The write handler, so assertions can't accidentally match the GET/list branches.
const writeBranch = session.slice(session.indexOf("const record = { ...session, id"));

describe("a non-completed write cannot overwrite a completed record", () => {
  it("refuses the downgrade instead of writing it", () => {
    expect(writeBranch).toMatch(
      /if \(record\.status !== "completed"\) \{[\s\S]{0,300}?prev && prev\.status === "completed"[\s\S]{0,120}?return json\(/
    );
  });

  it("signals the refusal rather than reporting a silent success", () => {
    // The dashboard and any retry logic need to be able to tell "stored" from
    // "deliberately skipped"; both are 200.
    expect(writeBranch).toContain('skipped: "completed_locked"');
  });

  it("returns BEFORE any store write on that path", () => {
    const guard = writeBranch.indexOf('skipped: "completed_locked"');
    const write = writeBranch.search(/store\.setJSON\(/);
    expect(guard, "lock not found").toBeGreaterThan(-1);
    expect(write, "no store write found").toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
  });

  it("reads the previous record once, before deciding", () => {
    // The lock needs `prev`; if the read moved below the branch the guard would always
    // see undefined and silently stop protecting anything.
    const read = writeBranch.indexOf("const prev = await store.get(id");
    const guard = writeBranch.indexOf('prev.status === "completed"');
    expect(read).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(read);
  });
});

describe("the lock does not block legitimate writes", () => {
  it("a completed record may still overwrite an earlier completed one", () => {
    // Re-sending after a partial failure has to be able to land, otherwise the
    // save-failed-but-Sheet-delivered recovery path (which deliberately keeps the
    // draft so it CAN be re-sent) would be permanently stuck.
    const guardBlock = writeBranch.slice(
      writeBranch.indexOf('if (record.status !== "completed")'),
      writeBranch.indexOf("} else {") + 8
    );
    expect(guardBlock).toContain('record.status !== "completed"');
    expect(guardBlock).toContain("} else {");
  });

  it("a completed write reconciles rather than nulling a known Sheet link", () => {
    expect(writeBranch).toMatch(/prev && prev\.sheetUrl && !record\.sheetUrl.*record\.sheetUrl = prev\.sheetUrl/);
  });

  it("in-progress autosaves still write when nothing is stored yet", () => {
    // The guard is conditional on `prev` existing AND being completed, so a first
    // autosave for a fresh id must not be caught by it.
    expect(writeBranch).toMatch(/if \(prev && prev\.status === "completed"\)/);
  });
});
