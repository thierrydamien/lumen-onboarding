// Notifying the people who actually have to act on an onboarding.
//
// Five changes, all sharing one rule: the tracker lookup is a NICE-TO-HAVE bolted
// onto alerts that must keep working without it. Every test here is really asking
// the same question — does the base alert survive when the lookup does not?

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const gs = read("apps-script/onboarding-sheet-webapp.gs");
const stalled = read("netlify/functions/stalled-check.js");
const sheet = read("netlify/functions/sheet.js");
const client = read("src/lumen.jsx");

describe("the stalled nudge tags whoever owns the client", () => {
  // It was the only alert addressed to nobody, and it is the one where a human has
  // to act. Verified by driving the real handler with Blobs/Slack/Apps Script
  // stubbed: reachable -> nudge + threaded mention; unreachable -> nudge alone.
  it("asks the Apps Script, because it cannot read the tracker itself", () => {
    // stalled-check runs on Netlify: no SpreadsheetApp, no roster. The lookup has
    // to happen where those live, behind the secret sheet.js already uses.
    expect(stalled).toMatch(/action: "assignees"/);
    expect(stalled).toMatch(/APPS_SCRIPT_WEBAPP_URL/);
    expect(stalled).toMatch(/APPS_SCRIPT_SECRET/);
    expect(gs).toMatch(/if \(body\.action === "assignees"\)/);
  });

  it("posts the mention in a thread, not as a second channel line", () => {
    expect(stalled).toMatch(/postSlack\(token, channel, mentionText, posted\.ts\)/);
    expect(stalled).toMatch(/thread_ts: threadTs/);
  });

  it("returns the thread anchor rather than a boolean", () => {
    // A bare true cannot be threaded on. It also has to report ok separately: an
    // "ok but no ts" reply must still count as posted, or the session goes
    // un-marked and is nudged again on the next run.
    expect(stalled).toMatch(/return \{ ok: !!data\.ok, ts: data\.ts \|\| "" \}/);
    expect(stalled).toMatch(/if \(!posted\.ok\) continue;/);
  });

  it("never lets a lookup failure cost the nudge or its dedup marker", () => {
    // The nudge is already posted by this point and dedup is what stops a client
    // being chased twice, so the lookup must not be able to throw past here.
    const fn = stalled.slice(stalled.indexOf("async function assigneeText"));
    expect(fn.slice(0, 1200)).toMatch(/catch \(err\)[\s\S]*return "";/);
    expect(fn).toMatch(/setTimeout\(\(\) => ctl\.abort\(\), 10000\)/); // bounded inside a per-session loop
    const loop = stalled.slice(stalled.indexOf("const posted = await postSlack"), stalled.indexOf("console.log(`stalled-check"));
    expect(loop).toMatch(/nudgeStore\.setJSON/); // marker still written
  });

  it("is inert when the integration is not configured", () => {
    const fn = stalled.slice(stalled.indexOf("async function assigneeText"));
    expect(fn).toMatch(/if \(!url \|\| !secret \|\| !company\) return "";/);
  });
});

describe("a matched client with nobody assigned still reaches someone", () => {
  it("escalates instead of tagging nobody", () => {
    // This is a CONFIRMED gap in the tracker, and it used to be the one branch that
    // named no one at all — the message went to the channel and to nobody.
    const fn = gs.slice(gs.indexOf("function assigneeReplyText_"), gs.indexOf("// Best fuzzy match"));
    const branch = fn.slice(fn.indexOf("no IC or TAM assigned yet"));
    expect(branch).toMatch(/escalate \? " " \+ escalate : ""/);
  });
  it("keeps the roster and the escalation list out of the repo", () => {
    // Public repo. Both come from Script Properties, as the token already does.
    expect(gs).toMatch(/SLACK_ESCALATION/);
    expect(gs).not.toMatch(/U[0-9A-Z]{8,}/); // no raw Slack user ids
    expect(gs).not.toMatch(/xoxb-[0-9]/);    // no token
  });
});

describe("a near tie is disclosed rather than presented as certainty", () => {
  it("keeps the runner-up so the gap can be measured", () => {
    const fn = gs.slice(gs.indexOf("function findBestMatch_"), gs.indexOf("function getSlackMention_"));
    expect(fn).toMatch(/best\.runnerUp = second;/);
    // The runner-up must survive the threshold check, or a near tie just below the
    // cutoff would be reported as a clean miss.
    expect(fn.indexOf("if (!best || best.score < PIPELINE_MIN_SCORE) return null;"))
      .toBeLessThan(fn.indexOf("best.runnerUp = second;"));
  });
  it("does not warn that a duplicate row scored the same as itself", () => {
    // Found on the FIRST real call against the live tracker: "Viacom" matched two
    // rows both named "Viacom Inc (main)", so the reply read "Close call — Viacom
    // Inc (main) scored almost the same", comparing a row with its own twin. A tie
    // only matters when picking the other row would change WHO gets tagged.
    const fn = gs.slice(gs.indexOf("function assigneeReplyText_"), gs.indexOf("// Best fuzzy match"));
    expect(fn).toMatch(/fuzzyNorm_\(runnerUp\.accountName\) === fuzzyNorm_\(match\.accountName\)/);
    expect(fn).toMatch(/!\(sameName && sameIc\)/);
    // Same name but a DIFFERENT IC must still speak up — the tracker contradicts
    // itself about who owns the account, which is worth more than a tie warning.
    expect(fn).toMatch(/Two rows named \*/);
  });

  it("warns only when the two are genuinely close", () => {
    expect(gs).toMatch(/const TIE_GAP = 0\.1;/);
    expect(gs).toMatch(/\(match\.score - runnerUp\.score\) < TIE_GAP/);
  });
});

describe("the alert says how the session actually went", () => {
  it("carries language and skips end to end", () => {
    // Three hops, and a gap at any one of them silently drops the field.
    expect(client).toMatch(/uiLang, skips: \[\.\.\.skipsRef\.current\] \}\)/);      // client -> /sheet
    // Assert the FIELDS are forwarded, not their neighbours: the first version of
    // this pinned "uiLang, skips, sessionId" as one string and broke the moment
    // `package` was added between them, while the behaviour was untouched.
    const payload = sheet.slice(sheet.indexOf("body: JSON.stringify({ secret: process.env.APPS_SCRIPT_SECRET"));
    const line = payload.slice(0, payload.indexOf("\n"));
    expect(line).toMatch(/\buiLang\b/);                                               // -> Apps Script
    expect(line).toMatch(/\bskips\b/);
    expect(gs).toMatch(/function runNotes_\(body\)/);                                // -> Slack
  });

  it("validates both before forwarding, like session.js already does", () => {
    // Client-POSTed and bound for a Slack message. The Apps Script escapes on the
    // way in; this keeps junk out altogether and bounds the array.
    expect(sheet).toMatch(/UI_LANGS\.includes\(body\.uiLang\)/);
    expect(sheet).toMatch(/WIDGETS\.includes\(x\)\)\.slice\(0, 20\)/);
  });

  it("stays quiet about the English default", () => {
    // Every session would otherwise carry a line saying nothing.
    const fn = gs.slice(gs.indexOf("function runNotes_"), gs.indexOf("function thinBriefNote_"));
    expect(fn).toMatch(/lang\.toLowerCase\(\) !== "english"/);
  });
});

describe("an unusable brief does not look like a good one", () => {
  it("flags an empty section, and only an empty one", () => {
    // A warning that fires on legitimately small briefs stops being read, so this
    // is deliberately not a 'sparse' heuristic.
    const fn = gs.slice(gs.indexOf("function thinBriefNote_"), gs.indexOf("// \"1. Reputation Management"));
    expect(fn).toMatch(/if \(!n\(brief\.topics\)\) missing\.push\("topics"\)/);
    expect(fn).toMatch(/if \(!missing\.length\) return "";/);
    expect(fn).not.toMatch(/< *[23]/); // no low-count thresholds crept in
  });
});
