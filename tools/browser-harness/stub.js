// Network stub for the real Lumen bundle. Written as a REAL FILE and loaded via
// <script src> — inlining it into the HTML means nested escaping and it silently
// fails to parse (the handover's hard-won lesson #1).
//
// window.__ctl lets a test flip failure modes MID-SESSION from the driver, which
// is what makes timing bugs (in-flight clicks, failed saves) reachable at all.
(function () {
  const ctl = window.__ctl = {
    chatMode: "ok",        // ok | hang | http500 | malformed | syncFail (sync 500s, background works)
    seedMode: "ok",        // ok | expired | fail — what a client's ?s= link resolves to
    draftSave: "ok",       // ok | fail
    sessionUpsert: "ok",   // ok | fail
    sheet: "ok",           // ok | fail
    writeDelayMs: 0,       // delay session/sheet/draft responses, to stage mid-flight UI
    replies: [],           // queue of raw assistant strings; falls back to DEFAULT
    calls: [],             // observed requests, for assertions
    pending: new Map(),    // rid -> {resolvedAt} for the background path
    draftStore: null,      // in-memory server draft, so resume is actually testable
    draftSavedAt: 0,
    releaseAll() { for (const [, v] of ctl.pending) v.holdUntil = 0; },
  };

  // A test that sets a mode and then RELOADS loses it: this script re-runs on
  // every load and resets __ctl, so the reload silently tests the default path
  // while claiming to test the failure (that exact false-pass happened). Modes
  // that must survive a reload are read from sessionStorage, which persists per
  // tab: sessionStorage.setItem("__stub.seedMode", "expired"); location.reload().
  try {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith("__stub.")) ctl[k.slice(7)] = sessionStorage.getItem(k);
    }
  } catch { /* storage disabled: overrides simply unavailable */ }

  const DEFAULT =
    '%%PROGRESS%%{"section":"intro","percent":10,"collected":{}}%%END%%\n\n' +
    "Thanks — what markets matter most to you?\n\n[WIDGET:MARKETS]";

  const json = (body, status) =>
    new Response(JSON.stringify(body), { status: status || 200, headers: { "Content-Type": "application/json" } });

  const nextReply = () => (ctl.replies.length ? ctl.replies.shift() : DEFAULT);

  const realFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch { /* non-JSON */ }
    ctl.calls.push({ url, method, body, at: Date.now() });

    // ---- background chat: POST kicks off, GET polls ----
    if (url.includes("/functions/chat-background")) {
      const rid = new URL(url, location.origin).searchParams.get("rid");
      if (ctl.chatMode === "http500") return json({ error: "boom" }, 500);
      // holdUntil=Infinity keeps the turn in flight until the driver releases it,
      // which is how the "is this control dead while thinking?" tests are staged.
      ctl.pending.set(rid, { holdUntil: ctl.chatMode === "hang" ? Infinity : Date.now() + 50 });
      return new Response("", { status: 202 });
    }
    if (url.includes("/functions/chat-status")) {
      const id = new URL(url, location.origin).searchParams.get("id");
      const rec = ctl.pending.get(id);
      if (!rec) return json({ state: "pending" });
      if (Date.now() < rec.holdUntil) return json({ state: "pending" });
      ctl.pending.delete(id);
      if (ctl.chatMode === "malformed") {
        return json({ state: "done", status: 200, genMs: 10, body: { content: [{ type: "text", text: '%%COMPANY%%{"name":"Acme"' }] } });
      }
      return json({ state: "done", status: 200, genMs: 10, body: { content: [{ type: "text", text: nextReply() }], usage: { input_tokens: 5, output_tokens: 50 } } });
    }
    // ---- synchronous fallback ----
    if (url.includes("/functions/chat")) {
      if (ctl.chatMode === "http500") return json({ error: "boom" }, 500);
      // syncFail: the SYNC path dies but chat-background/chat-status above work,
      // which is exactly the fallback the client promises for heavy turns — and
      // which had never been seen SUCCEEDING until this mode existed.
      if (ctl.chatMode === "syncFail") return json({ error: "boom" }, 500);
      // NOTE: the client is SYNC-FIRST (src/lumen.jsx) — it tries this endpoint
      // before the background flow, and only falls back on failure. So this is the
      // path a test actually exercises, and "hang" must stay RELEASABLE: a bare
      // never-settling promise wedges the tab and makes __ctl.releaseAll() a lie,
      // which reads exactly like an app bug that isn't one.
      if (ctl.chatMode === "hang") {
        await new Promise((res) => {
          const tick = () => (ctl.chatMode === "hang" ? setTimeout(tick, 50) : res());
          tick();
        });
      }
      return json({ content: [{ type: "text", text: nextReply() }], usage: { input_tokens: 5, output_tokens: 50 } });
    }
    if (url.includes("/functions/seed")) {
      // 404, matching the real seed.js exactly (it sweeps the record and returns
      // 404 {error:"expired"}). A first draft of this used 410 and the app
      // CORRECTLY treated that as transient — only 404 is definitive to the client.
      if (ctl.seedMode === "expired") return json({ error: "expired" }, 404);
      if (ctl.seedMode === "fail") return json({ error: "boom" }, 500);
      // Wrapped in {seed}, matching the real seed.js (`return json(200, {seed: out})`).
      // A first draft returned the fields FLAT, which the client reads as "link
      // present but profile unloadable" — so every test ran with seedError=true, a
      // transient warning banner on the welcome screen, and no company prefill.
      // Nothing those tests asserted depended on it, but it made one banner test
      // pass vacuously. Shape fidelity in stubs is load-bearing.
      return json({ seed: { company: "Acme Corp", contactName: "Jane Smith", email: "jane@acme.com", industry: "Retail", language: "English" } });
    }
    if (url.includes("/functions/draft")) {
      if (ctl.draftSave === "fail") return json({ error: "nope" }, 500);
      if (method === "GET") {
        if (!ctl.draftStore) return json({ error: "not_found" }, 404);
        return json({ draft: ctl.draftStore, savedAt: new Date(ctl.draftSavedAt).toISOString() });
      }
      if (body && body.done) { ctl.draftStore = null; return json({ ok: true }); }
      if (body && body.snapshot) { ctl.draftStore = body.snapshot; ctl.draftSavedAt = Date.now(); }
      return json({ ok: true });
    }
    const delay = () => (ctl.writeDelayMs ? new Promise((r) => setTimeout(r, ctl.writeDelayMs)) : null);
    if (url.includes("/functions/session")) {
      await delay();
      if (ctl.sessionUpsert === "fail") return json({ error: "nope" }, 500);
      return json({ ok: true });
    }
    if (url.includes("/functions/sheet")) {
      await delay();
      if (ctl.sheet === "fail") return json({ error: "nope" }, 500);
      return json({ url: "https://docs.google.com/spreadsheets/d/FAKE/edit" });
    }
    return realFetch(input, init);
  };
})();
