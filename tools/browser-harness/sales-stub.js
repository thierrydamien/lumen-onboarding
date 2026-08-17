// Network stub for public/sales.html. Mirrors tools/browser-harness/stub.js in
// shape: a real file loaded with <script src>, and a window.__ctl the driver
// flips mid-session so failure modes need no rebuild.
(function () {
  var real = window.fetch.bind(window);

  window.__ctl = {
    seed: "ok",          // ok | http500 | http401 | http403 | slow | badjson | noid
    parseBrief: "ok",    // ok | http401 | err:<code> | slow
    previewBrief: "ok",  // ok | http401 | http500 | slow
    duplicates: [],      // what the seed POST reports back
    expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
    slowMs: 1500,
    calls: [],           // every request the page made
    seedBodies: [],      // the exact seed objects POSTed, for assertions
    nextId: 1,
    parseResult: null,   // override the parse-brief success payload
  };

  function reply(status, obj) {
    return new Response(JSON.stringify(obj), {
      status: status,
      headers: { "Content-Type": "application/json" },
    });
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  window.fetch = async function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var opts = init || {};
    var method = (opts.method || "GET").toUpperCase();
    var body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch (e) { body = String(opts.body || ""); }

    var c = window.__ctl;
    c.calls.push({ method: method, url: url, headers: opts.headers || {}, body: body });

    if (url.indexOf("/functions/seed") !== -1) {
      c.seedBodies.push(body && body.seed);
      if (c.seed === "slow") await wait(c.slowMs);
      if (c.seed === "http500") return reply(500, { error: "save_failed" });
      if (c.seed === "http401") return reply(401, { error: "unauthorized_write" });
      if (c.seed === "http403") return reply(403, { error: "forbidden_origin" });
      if (c.seed === "badjson") return new Response("<html>gateway</html>", { status: 200 });
      if (c.seed === "noid") return reply(200, { expiresAt: c.expiresAt });
      if (c.seed === "network") throw new TypeError("Failed to fetch");
      return reply(200, {
        id: "sd_stub_" + (c.nextId++),
        expiresAt: c.expiresAt,
        duplicates: c.duplicates,
      });
    }

    if (url.indexOf("/functions/parse-brief") !== -1) {
      if (c.parseBrief === "slow") await wait(c.slowMs);
      if (c.parseBrief === "http401") return reply(401, { error: "unauthorized_write" });
      if (String(c.parseBrief).indexOf("err:") === 0) {
        return reply(400, { ok: false, error: String(c.parseBrief).slice(4) });
      }
      return reply(200, c.parseResult || {
        ok: true,
        filledCount: 4,
        form: {
          company: "Northwind Traders",
          contactName: "Ada Lovelace",
          email: "ada@northwind.example",
          industry: "Logistics",
        },
        brief: "Main use case: competitive intelligence\nKey competitors: Maersk, DHL",
      });
    }

    if (url.indexOf("/functions/preview-brief") !== -1) {
      if (c.previewBrief === "slow") await wait(c.slowMs);
      if (c.previewBrief === "http401") return reply(401, { error: "unauthorized" });
      if (c.previewBrief === "http500") return reply(500, { ok: false });
      return reply(200, {
        ok: true,
        interpretation:
          "I understand this client wants competitive intelligence, tracking Maersk and DHL across the US and UK.",
      });
    }

    return real(input, init);
  };
})();
