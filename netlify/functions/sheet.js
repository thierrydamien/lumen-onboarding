// Google Sheet generation (Netlify Functions v2).
//   POST /.netlify/functions/sheet  { xlsxBase64, filename, clientEmail?, company? }
//     -> { url }   (a Google Sheet converted from the brief's XLSX)
//
// SETUP (inert until one path below is configured).
//   Path D - Apps Script Web App (PREFERRED here; runs as a real Google account,
//     so it writes into that account's Drive folder with no service account /
//     OAuth / delegation). See apps-script/onboarding-sheet-webapp.gs.
//       APPS_SCRIPT_WEBAPP_URL, APPS_SCRIPT_SECRET
//   The Google-API paths below need GOOGLE_DRIVE_FOLDER_ID for the target folder.
//   Path A - OAuth as a real user (writes into that user's My Drive folder, on
//     their quota; no Workspace admin needed):
//       GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN
//   Path B - Service account + domain-wide delegation (impersonate a real user;
//     needs a Workspace admin to authorize the SA for the Drive scope):
//       GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
//       GOOGLE_IMPERSONATE_SUBJECT (the user to act as)
//   Path C - Service account into a Shared Drive (SA is a Content Manager; no
//     impersonation). A bare SA has no personal Drive quota, so without a Shared
//     Drive or impersonation the create fails on quota:
//       GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
// Selection: if a refresh token is set, Path A is used; else the service account
// (Path B if GOOGLE_IMPERSONATE_SUBJECT is set, else Path C).
// GOVERNANCE: this writes client data (possibly PII) into Google Drive. Confirm
// folder location, sharing scope, and retention with the ISO 42001 owner before
// enabling in production.
//
// UNTESTED IN THIS ENVIRONMENT: written against the Drive v3 REST API but not
// executed here (no credentials / Google runtime). Smoke-test on a real deploy.

import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import { rateLimit, tooMany } from "../lib/ratelimit.js";

const MAX_BODY_BYTES = 3_000_000; // base64 XLSX, generous
// One accepted call creates a Drive file and can send mail FROM the organisation's
// Google account, so in reputational terms this is the most expensive endpoint here.
// A real client hits it once per completed brief; a rep testing might hit it a few
// times in a row. These ceilings sit far above either.
const RL_WRITE = { perMin: 30, perHour: 200 };
export const config = { path: "/.netlify/functions/sheet" };

// The Sheet is SHARED with this address and Google emails a notification FROM the
// organisation's account, so it must not be taken on trust from the request body:
// the Origin check is spoofable outside a browser, so an anonymous caller could
// otherwise use your Google identity to mail an arbitrary recipient (mail that
// passes SPF/DKIM for your domain) and drop files in your Drive.
//
// The client always POSTs its completed session record BEFORE calling this endpoint
// (see handleSend in src/lumen.jsx), and both values come from the same `merged`
// object, so a legitimate request always matches. When there is no record to check
// against — the session POST failed, or an older client — create the Sheet but do
// NOT share it, rather than failing the call: the client still gets their link and
// the dashboard still gets the URL, so nothing user-visible breaks.
async function verifiedClientEmail(sessionId, requested) {
  const want = String(requested || "").trim().toLowerCase();
  if (!want) return "";
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) {
    console.warn("sheet: no usable sessionId to verify clientEmail against — not sharing by email");
    return "";
  }
  try {
    const rec = await getStore("lumen-sessions").get(sessionId, { type: "json" });
    const known = String((rec && rec.merged && rec.merged.company && rec.merged.company.email) || "")
      .trim().toLowerCase();
    if (known && known === want) return String(requested).trim();
    console.warn("sheet: clientEmail does not match the stored session record — not sharing by email");
    return "";
  } catch (err) {
    console.error("sheet: could not verify clientEmail against the session store — not sharing", err);
    return "";
  }
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

// True if any path is configured, so an unconfigured deploy degrades (501).
function sheetsConfigured() {
  return !!(process.env.APPS_SCRIPT_WEBAPP_URL ||
    process.env.GOOGLE_OAUTH_REFRESH_TOKEN ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY));
}

async function tokenFrom(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("token_failed:" + (data.error || res.status));
  return data.access_token;
}

// Path A: OAuth refresh token for a real user.
function getOAuthToken(clientId, clientSecret, refreshToken) {
  return tokenFrom({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken });
}

// Paths B/C: service account JWT. `subject` set = domain-wide delegation (act as
// that user); unset = act as the service account itself (needs a Shared Drive).
function getServiceAccountToken(email, privateKey, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = { iss: email, scope: DRIVE_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  if (subject) claim.sub = subject;
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  const assertion = `${unsigned}.${b64url(signature)}`;
  return tokenFrom({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion });
}

// Resolve an access token from whichever path is configured (A > B/C).
function resolveAccessToken() {
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (refreshToken) return getOAuthToken(process.env.GOOGLE_OAUTH_CLIENT_ID, process.env.GOOGLE_OAUTH_CLIENT_SECRET, refreshToken);
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  return getServiceAccountToken(email, privateKey, process.env.GOOGLE_IMPERSONATE_SUBJECT || "");
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // Same-origin friction (chat page is same-origin). This endpoint forwards server
  // credentials downstream, so require Origin present AND matching (like session.js),
  // and guard new URL() so a malformed/`null` Origin is a clean 403, not a 500.
  const origin = req.headers.get("origin");
  const siteURL = process.env.URL;
  if (siteURL) {
    let ok = false;
    try { ok = !!origin && new URL(origin).host === new URL(siteURL).host; } catch { ok = false; }
    if (!ok) return json(403, { error: "forbidden_origin" });
  } else {
    console.warn("URL env not set — cannot validate Origin on sheet proxy");
  }

  const rl = await rateLimit(req, "sheet", RL_WRITE);
  if (!rl.ok) return tooMany(rl.retryAfter);

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
  if (!sheetsConfigured()) {
    // Not configured — let the client degrade gracefully (brief still sends).
    return json(501, { error: "sheets_not_configured" });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });
  let body;
  try { body = JSON.parse(rawBody); }
  catch { return json(400, { error: "bad_json" }); }

  const { xlsxBase64, brief, filename, clientEmail, company, contactName, topicsCount, usersCount, sessionId } = body || {};
  // uiLang / skips are client-POSTed and end up in a Slack message, so they get the
  // same whitelist treatment session.js already applies to the identical two fields
  // rather than being forwarded raw. The Apps Script escapes them again on the way
  // into Slack; this bounds them and keeps junk out of the alert entirely.
  const UI_LANGS = ["English", "French", "German", "Spanish", "Italian", "Arabic"];
  const WIDGETS = ["MARKETS", "LANGUAGES", "OBJECTIVES", "TEAMS", "TIMEZONE", "TOPICS", "USERS", "QUERIES"];
  const uiLang = (typeof body.uiLang === "string" && UI_LANGS.includes(body.uiLang)) ? body.uiLang : "";
  const skips = Array.isArray(body.skips) ? body.skips.filter((x) => WIDGETS.includes(x)).slice(0, 20) : [];
  const name = (typeof filename === "string" && filename) || `Lumen Setup Brief${company ? " - " + company : ""}`;
  // Never pass the body's clientEmail downstream unchecked — see verifiedClientEmail.
  const shareEmail = await verifiedClientEmail(sessionId, clientEmail);

  // Path D (preferred when set): hand off to an Apps Script Web App that runs as a
  // real Google account. It COPIES the master requirements template and fills in
  // the structured brief, so the output matches the template exactly. URL + secret
  // are server-side env; the browser never sees them.
  const appsUrl = process.env.APPS_SCRIPT_WEBAPP_URL;
  if (appsUrl) {
    if (!brief || typeof brief !== "object") return json(400, { error: "missing_brief" });
    // Bound the upstream call like chat.js does. The Apps Script (copy the template,
    // fill every cell one round-trip at a time, share, Slack post) can be slow; with
    // no abort a hang runs until the platform kills the function with an opaque 502.
    // 24s sits just inside the 26s function ceiling, and the client's timeout on this
    // call is aligned to 30s (see handleSend) so it no longer waits ~19s past the
    // point the platform would already have killed the function.
    const ac = new AbortController();
    const abortT = setTimeout(() => ac.abort(), 24000);
    try {
      const r = await fetch(appsUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        // dashboardOrigin lets the Apps Script post the Sheet link back to THIS
        // site's session store when a slow run outlasts the abort below (the client
        // then never receives the URL). Passing our own origin removes the dependence
        // on a hand-set DASHBOARD_URL script property that, if unset/stale, silently
        // dropped the link on long runs.
        body: JSON.stringify({ secret: process.env.APPS_SCRIPT_SECRET || "", brief, filename: name, clientEmail: shareEmail, company: company || "", contactName: contactName || "", topicsCount, usersCount, uiLang, skips, sessionId: sessionId || "", dashboardOrigin: process.env.URL || "" }),
        signal: ac.signal,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.url) {
        console.error("Apps Script sheet failed", r.status, d && d.error);
        return json(502, { error: "sheet_failed" });
      }
      return json(200, { url: d.url });
    } catch (err) {
      if (err && err.name === "AbortError") {
        console.error("Apps Script sheet exceeded the internal 24s budget — aborted");
        return json(504, { error: "sheet_timeout" });
      }
      // Our own transport throw reaching the Apps Script. The request may well have
      // landed and be running, so signal a distinct code (not "sheet_failed") — the
      // client treats it as pending and defers to the Apps Script writeback + its own
      // alert, rather than firing a false/duplicate "Sheet could not be generated".
      console.error("Apps Script sheet unreachable", err);
      return json(502, { error: "sheet_unreachable" });
    } finally {
      clearTimeout(abortT);
    }
  }

  // Google-API fallback paths convert the client-built XLSX instead.
  if (!xlsxBase64 || typeof xlsxBase64 !== "string") return json(400, { error: "missing_xlsx" });
  try {
    const token = await resolveAccessToken();

    // Multipart upload of the XLSX with a Google-Sheets target mimeType, so Drive
    // converts it to a native Sheet on the way in.
    const boundary = "lumen" + crypto.randomUUID();
    const meta = { name: name.replace(/\.xlsx$/i, ""), mimeType: "application/vnd.google-apps.spreadsheet" };
    if (folderId) meta.parents = [folderId];
    const pre =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`;
    const post = `\r\n--${boundary}--`;
    const uploadBody = Buffer.concat([Buffer.from(pre, "utf8"), Buffer.from(xlsxBase64, "base64"), Buffer.from(post, "utf8")]);

    const up = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body: uploadBody }
    );
    const file = await up.json().catch(() => ({}));
    if (!up.ok || !file.id) {
      console.error("Drive upload failed", up.status, JSON.stringify(file && file.error));
      return json(502, { error: "upload_failed" });
    }

    // Share with the client (as editor) if we have their email. sendNotificationEmail
    // makes Google email them the link — this is the "you'll get an email" path.
    if (shareEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shareEmail)) {
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${file.id}/permissions?sendNotificationEmail=true&supportsAllDrives=true`,
        { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ role: "writer", type: "user", emailAddress: shareEmail }) }
      ).catch((e) => console.error("Share failed (non-fatal)", e));
    }

    const url = file.webViewLink || `https://docs.google.com/spreadsheets/d/${file.id}/edit`;
    return json(200, { url });
  } catch (err) {
    console.error("Sheet generation failed", err);
    return json(502, { error: "sheet_failed" });
  }
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
