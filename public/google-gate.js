// Shared Google Sign-In gate for the two internal pages (sales, dashboard).
//
// Extracted from both pages once the same ~60 lines needed the same subtle auth
// fix twice: duplicated auth logic is exactly the kind that drifts apart and
// leaves one page quietly less protected than the other.
//
// WHAT THIS IS NOT: security. The real enforcement is server-side in
// netlify/lib/google-auth.js, which verifies the token with Google on every
// write and every dashboard read. This file is the front door — it decides what
// a human sees, and getting a token to send along.
//
// TOKEN REUSE (the fix for "it asks me to sign in every single time"):
// The token used to be held in memory only, so every page load — and every hop
// between /sales and /dashboard — needed a brand new one from Google. That is
// silent ONLY when auto_select can fire, and auto_select disables itself when
// the browser has more than one Google session (work + personal, i.e. most
// people), so in practice it meant the account picker every time.
// Now the token is kept until it actually expires. Google ID tokens last about
// an hour, so a rep signs in roughly once a morning instead of once a page.
//
// Storing it is a deliberate, bounded call:
//   - it is self-expiring, unlike the dashboard/write tokens already in storage
//   - anyone able to read it via XSS could equally just make the requests
//     directly from the page, so it does not widen that hole
//   - `exp` is checked BEFORE use with a safety margin, and any 401 from the
//     server clears it — a stale token can never produce a confusing dead end
(function (global) {
  "use strict";

  // Proof-of-life for the inline safety net in each page: the net reveals the
  // page after a timeout ONLY when this stays false (the module was blocked or
  // failed to parse and can never run the gate). If the module IS running it owns
  // reveal/hide, and the net must not race it, or it would flash the internal
  // form while the gate is still legitimately deciding.
  global.__lumenGateLoaded = true;

  var KEY = "lumen_gid_token";
  var SKEW_MS = 120000; // treat a token as expired 2 min early: covers clock skew
                        // and stops a token dying mid-request
  // How long to let Google try to sign the user in SILENTLY before showing a
  // card. auto_select / FedCM auto-reauthn resolve well inside this once the
  // script is loaded; showing the card first meant a returning rep watched it
  // appear and vanish, which reads as "it asked me again" even though no click
  // was ever needed. During this window the page is hidden but no card is shown.
  var SILENT_MS = 1500;

  // Read the (UNVERIFIED) payload. Used ONLY for the expiry timestamp and to show
  // which account is signed in — never for authorisation, which happens server
  // side against Google. A forged payload here buys nothing: the server rejects it.
  function payloadOf(tok) {
    try {
      var p = tok.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    } catch (e) { return null; }
  }

  function msLeft(tok) {
    var p = tok && payloadOf(tok);
    if (!p || !p.exp) return 0;
    return (p.exp * 1000) - Date.now();
  }

  function load() {
    try {
      var t = localStorage.getItem(KEY);
      if (t && msLeft(t) > SKEW_MS) return t;
      if (t) localStorage.removeItem(KEY); // expired: drop it rather than 401 later
    } catch (e) {}
    return "";
  }
  function save(t) { try { localStorage.setItem(KEY, t); } catch (e) {} }
  function clear() { try { localStorage.removeItem(KEY); } catch (e) {} }

  /**
   * opts:
   *   gateEl, msgEl, errEl, btnEl  element ids for the sign-in card
   *   onUnlock()                   called when the page may be used
   *   onLock()                     called when it must be hidden
   */
  function create(opts) {
    var state = { on: false, clientId: "", domain: "", token: "" };
    var $ = function (id) { return document.getElementById(id); };
    var setErr = function (m) { var e = $(opts.errEl); if (e) e.textContent = m || ""; };
    var showCard = function (msg) {
      if (msg) { var m = $(opts.msgEl); if (m) m.textContent = msg; }
      var g = $(opts.gateEl); if (g) g.classList.add("show");
      opts.onLock && opts.onLock();
    };
    var hideCard = function () {
      var g = $(opts.gateEl); if (g) g.classList.remove("show");
      setErr("");
      opts.onUnlock && opts.onUnlock();
    };

    var graceTimer = null;
    function cancelGrace() { if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; } }

    function accept(tok) {
      cancelGrace();          // signed in silently: the card is never shown
      state.token = tok;
      save(tok);
      hideCard();
    }

    function onCredential(resp) {
      var t = resp && resp.credential;
      if (!t) { setErr("Sign-in did not return a credential. Try again."); return; }
      var p = payloadOf(t) || {};
      // Google's "Internal" consent screen should already prevent a foreign
      // account reaching here; this turns the server's eventual 401 into a
      // message that says what to do about it.
      if (state.domain && p.hd && String(p.hd).toLowerCase() !== state.domain.toLowerCase()) {
        setErr("That account is not a " + state.domain + " address. Switch account and try again.");
        return;
      }
      accept(t);
    }

    // Load + initialise Google Identity Services exactly once, and render the
    // button. Idempotent and shared by the first sign-in AND reauth, so a reused
    // token (which never loaded GIS) can still bring up a WORKING card later —
    // the old reauth() called prompt() on a `google` that was never loaded and
    // produced a card with no button, hit every time a reused token expired.
    // Resolves true when GIS is ready, false when it could not load (with an
    // error message already set). Times out rather than hanging forever on a
    // firewall that black-holes the socket (fires neither onload nor onerror).
    var gisReady = null; // memoised promise
    function ensureGis() {
      if (gisReady) return gisReady;
      gisReady = new Promise(function (res) {
        var done = false;
        var finish = function (ok) { if (done) return; done = true; res(ok); };
        // 8s: a real GIS load is well under this; past it we assume it is blocked
        // and fall back to a card the user can act on, never a silent hang.
        var to = setTimeout(function () { finish(false); }, 8000);
        var s = document.createElement("script");
        s.src = "https://accounts.google.com/gsi/client";
        s.async = true; s.defer = true;
        s.onload = function () { clearTimeout(to); finish(true); };
        s.onerror = function () { clearTimeout(to); finish(false); };
        document.head.appendChild(s);
      }).then(function (loaded) {
        if (!loaded || !global.google || !global.google.accounts || !global.google.accounts.id) {
          return false;
        }
        global.google.accounts.id.initialize({
          client_id: state.clientId,
          callback: onCredential,
          auto_select: true,
          cancel_on_tap_outside: false,
          // FedCM is the browser-native flow. The legacy One Tap rides on
          // third-party cookies, which Chrome is removing — without this, silent
          // re-auth degrades into the account picker.
          use_fedcm_for_prompt: true,
        });
        var btn = $(opts.btnEl);
        if (btn) global.google.accounts.id.renderButton(btn, { theme: "outline", size: "large", text: "signin_with" });
        return true;
      });
      return gisReady;
    }
    // Bring up a WORKING sign-in card: ensure GIS first, then prompt. Used by the
    // no-token path and by reauth, so both always get a rendered button.
    function presentCard(msg, silent) {
      return ensureGis().then(function (ready) {
        if (!ready) {
          showCard(msg);
          setErr("Google sign-in could not load — an ad blocker or network policy may be blocking accounts.google.com. Allow it and reload, or ask IT.");
          return;
        }
        try { global.google.accounts.id.prompt(); } catch (e) {}
        if (silent) {
          // Hold the card back briefly: if auto-reauthn signs the user in, accept()
          // cancels this and no card ever appears.
          cancelGrace();
          graceTimer = setTimeout(function () { graceTimer = null; showCard(msg); }, SILENT_MS);
        } else {
          showCard(msg);
        }
      });
    }

    return {
      /** Attach the token to a headers object, if the gate is on and the token is
       *  still valid. Re-checks expiry on EVERY call: a token can go stale in a
       *  long-open tab, and sending a dead one just earns a 401. If it is stale we
       *  drop it and send nothing — the server 401 then drives reauth. */
      headers: function (h) {
        h = h || {};
        if (state.on && state.token) {
          if (msLeft(state.token) > SKEW_MS) h["x-google-id-token"] = state.token;
          else { state.token = ""; clear(); }
        }
        return h;
      },
      isOn: function () { return state.on; },
      /** Called on a server 401 that names the Google gate: the stored token is
       *  no good, so bin it and bring up a working card rather than retrying. */
      reauth: function (msg) {
        state.token = ""; clear();
        presentCard(msg || "Your sign-in expired. Sign in again to continue.", false);
      },
      /** Resolves "unlocked" when a cached token let us in with no prompt, true
       *  when the gate is ON and waiting for sign-in (page stays locked until
       *  onUnlock fires), or false when the gate is not configured for this site. */
      init: function () {
        // Bound the config fetch: a cold Netlify function can take several seconds,
        // and without a cap a hung one would leave the page in limbo.
        var cfgP = new Promise(function (res, rej) {
          var to = setTimeout(function () { rej(new Error("config_timeout")); }, 6000);
          fetch("/.netlify/functions/app-config")
            .then(function (r) { return r.json(); })
            .then(function (c) { clearTimeout(to); res(c); })
            .catch(function (e) { clearTimeout(to); rej(e); });
        });
        return cfgP
          .then(function (cfg) {
            if (!cfg || !cfg.googleAuth || !cfg.clientId) { hideCard(); return false; }
            state.on = true;
            state.clientId = cfg.clientId;
            state.domain = cfg.domain || "";

            // A still-valid token from an earlier page view: straight in, no
            // prompt, no Google round trip. GIS is still loaded lazily in the
            // background so reauth has a working button ready when the token
            // eventually expires.
            var cached = load();
            if (cached) { state.token = cached; hideCard(); ensureGis(); return "unlocked"; }

            // Gate on, no token. Keep the page hidden (onLock) and try to sign in
            // silently before showing the card.
            opts.onLock && opts.onLock();
            return presentCard(undefined, true).then(function () { return true; });
          })
          .catch(function () {
            // Config unreachable. Deliberately FAIL CLOSED for VISIBILITY: keep
            // the page hidden and show a reload card rather than revealing the
            // internal form. The earlier version called hideCard() here, which —
            // combined with a slow config fetch racing the safety net — flashed
            // the confidential form to anyone who opened the page. The server is
            // still the real lock, so no ACTION is exposed; this only governs
            // what a stranger can READ. A reload almost always clears it.
            opts.onLock && opts.onLock();
            showCard("Couldn't verify access. Please reload to try again.");
            var btn = $(opts.btnEl); if (btn) btn.style.display = "none"; // no usable sign-in without config
            return true;
          });
      },
    };
  }

  global.LumenGoogleGate = { create: create, _payloadOf: payloadOf, _msLeft: msLeft };
})(window);
