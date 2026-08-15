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

    return {
      /** Attach the token to a headers object, if the gate is on and we have one. */
      headers: function (h) {
        h = h || {};
        if (state.on && state.token) h["x-google-id-token"] = state.token;
        return h;
      },
      isOn: function () { return state.on; },
      /** Called on a server 401 that names the Google gate: the stored token is
       *  no good, so bin it and ask again rather than retrying forever. */
      reauth: function (msg) {
        state.token = ""; clear();
        showCard(msg || "Your sign-in expired. Sign in again to continue.");
        try { global.google.accounts.id.prompt(); } catch (e) {}
      },
      /** Resolves true when the gate is ON (page should stay locked until
       *  onUnlock fires), false when it is not configured for this site. */
      init: function () {
        return fetch("/.netlify/functions/app-config")
          .then(function (r) { return r.json(); })
          .then(function (cfg) {
            if (!cfg || !cfg.googleAuth || !cfg.clientId) { hideCard(); return false; }
            state.on = true;
            state.clientId = cfg.clientId;
            state.domain = cfg.domain || "";

            // THE FIX: a still-valid token from an earlier page view means no
            // prompt, no Google round trip, no account picker.
            var cached = load();
            if (cached) { state.token = cached; hideCard(); return "unlocked"; }

            // Lock the page, but hold the card back — see SILENT_MS.
            opts.onLock && opts.onLock();
            return new Promise(function (res) {
              var s = document.createElement("script");
              s.src = "https://accounts.google.com/gsi/client";
              s.async = true; s.defer = true;
              s.onload = res;
              s.onerror = function () {
                // Nothing silent can happen now, so stop waiting and say so.
                showCard();
                setErr("Could not reach Google to sign in. Check your connection and reload.");
                res();
              };
              document.head.appendChild(s);
            }).then(function () {
              if (!global.google || !global.google.accounts || !global.google.accounts.id) {
                showCard();
                // The script can return 200 and still provide no API — an ad
                // blocker or corporate proxy does exactly this. Without a message
                // the rep gets a card with no button and no explanation.
                setErr("Google sign-in could not load — an ad blocker or network policy may be blocking accounts.google.com. Allow it and reload, or ask IT.");
                return true;
              }
              global.google.accounts.id.initialize({
                client_id: state.clientId,
                callback: onCredential,
                auto_select: true,
                cancel_on_tap_outside: false,
                // FedCM is the browser-native flow. The legacy One Tap rides on
                // third-party cookies, which Chrome is removing — without this,
                // silent re-auth degrades into the account picker.
                use_fedcm_for_prompt: true,
              });
              global.google.accounts.id.renderButton($(opts.btnEl), { theme: "outline", size: "large", text: "signin_with" });
              global.google.accounts.id.prompt();
              // If nothing arrived silently, surface the card. accept() cancels
              // this, so a successful auto-sign-in shows no card at all. There is
              // always exactly one outcome here, so the page can never stay
              // hidden with nothing to act on.
              graceTimer = setTimeout(function () { graceTimer = null; showCard(); }, SILENT_MS);
              return true;
            });
          })
          .catch(function () {
            // Config unreachable: fail OPEN here. The server is the real lock, so
            // the worst case is a clear 401 later rather than a blank page now.
            hideCard();
            return false;
          });
      },
    };
  }

  global.LumenGoogleGate = { create: create, _payloadOf: payloadOf, _msLeft: msLeft };
})(window);
