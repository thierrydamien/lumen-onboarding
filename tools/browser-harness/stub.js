// Network stub for the real Lumen bundle. Written as a REAL FILE and loaded via
// <script src> — inlining it into the HTML means nested escaping and it silently
// fails to parse (the handover's hard-won lesson #1).
//
// window.__ctl lets a test flip failure modes MID-SESSION from the driver, which
// is what makes timing bugs (in-flight clicks, failed saves) reachable at all.
(function () {
  const ctl = window.__ctl = {
    chatMode: "ok",        // ok | hang | http500 | malformed
    draftSave: "ok",       // ok | fail
    sessionUpsert: "ok",   // ok | fail
    sheet: "ok",           // ok | fail
    replies: [],           // queue of raw assistant strings; falls back to DEFAULT
    calls: [],             // observed requests, for assertions
    pending: new Map(),    // rid -> {resolvedAt} for the background path
    releaseAll() { for (const [, v] of ctl.pending) v.holdUntil = 0; },
  };

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
      return json({ company: "Acme Corp", contactName: "Jane Smith", email: "jane@acme.com", industry: "Retail", language: "English" });
    }
    if (url.includes("/functions/draft")) {
      if (ctl.draftSave === "fail") return json({ error: "nope" }, 500);
      if (method === "GET") return json({ snapshot: null });
      return json({ ok: true });
    }
    if (url.includes("/functions/session")) {
      if (ctl.sessionUpsert === "fail") return json({ error: "nope" }, 500);
      return json({ ok: true });
    }
    if (url.includes("/functions/sheet")) {
      if (ctl.sheet === "fail") return json({ error: "nope" }, 500);
      return json({ url: "https://docs.google.com/spreadsheets/d/FAKE/edit" });
    }
    return realFetch(input, init);
  };
})();
