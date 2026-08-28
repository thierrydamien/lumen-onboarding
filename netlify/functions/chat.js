// Server-side Anthropic proxy (Netlify Functions v2).
// SECURITY MODEL:
//  - The API key lives ONLY here (env: ANTHROPIC_API_KEY), never in the browser.
//  - The SYSTEM PROMPT lives ONLY here. The client cannot supply or override it,
//    so this endpoint can only ever run the Lumen onboarding assistant; it is
//    not a general-purpose Claude relay.
//  - Requests with a client-supplied "system" field are rejected outright.
//  - Same-origin check: browser requests must come from this site.
//  - Size caps bound the cost of any single request.
// Client contract: POST { messages, maxTokens?, overstateFix?, seedId? }
// seedId (opaque "sd_"+uuid, already public in the client's ?s= link) lets this
// function resolve the seed's confidential consultant notes SERVER-SIDE; they are
// injected into the system prompt and never returned to the browser.

import { getStore } from "@netlify/blobs";
import { SYSTEM_PROMPT } from "../lib/system-prompt.js";
import { notifyOps } from "../lib/opsalert.js";

const MODEL = "claude-sonnet-4-6";
// Ceiling sized to the serverless window, not to "generous". The call is
// NON-STREAMING, so generation time ≈ output tokens / ~60-90 tok/s. The old 4000
// ceiling allowed ~45-65s of generation — no synchronous Netlify function
// survives that (default ~10s, max ~26s), so a long reply didn't get truncated,
// it got the whole function KILLED and the client saw a dead "didn't go through".
// The largest LEGITIMATE reply (full recap turn: every %% marker re-emitted on a
// topic-heavy session, plus the <thought> block) measures well under ~1500
// output tokens, so 2000 leaves real headroom for normal traffic while capping a
// runaway at ~25-30s. A runaway now ends as an API-level max_tokens truncation —
// which the client already handles (dangling-marker silent retry + stripAll
// safety net) — instead of a platform kill it can't handle.
// ALSO raise the site's function timeout to 26s (Netlify UI, see DEPLOY.md):
// that closes the remaining 10s-default gap for ordinary 700-1500-token replies.
const MAX_TOKENS_CEILING = 2000;
const MAX_BODY_BYTES = 400_000;   // ~20 turns x 15k-char import, with headroom
const MAX_MESSAGES = 40;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// The prompt text lives in ../lib/system-prompt.js so it can be reviewed as prose.
// Moving it changed no characters: tests/system-prompt.test.js pins the exact
// text by checksum, so an accidental edit fails the build rather than shipping.

const OVERSTATE_FIX = "\n\nCORRECTION — REWRITE REQUIRED: Your previous reply implied the setup is already live, running, or delivering results. It is NOT — nothing is active until the consultant activates it at the review call. Rewrite your reply keeping all %% markers identical, but change the visible prose to use only future or conditional framing (\"once your consultant activates this, you'll…\", \"this will be set up to…\"). Do not use \"is now set up\", \"you're now getting\", \"will now get\", \"delivered on a schedule\", \"up and running\", or \"you're all set\".";

// Seeded sessions carry confidential CONSULTANT NOTES (why the client is buying,
// competitors they named, tier sold, sensitivities). By design these must SHAPE
// the assistant's questions and suggestions but must NEVER reach the browser — so
// the Sales page stores them in the seed blob store and the client link carries
// only an opaque id. The client sends that id here; we resolve the notes
// SERVER-SIDE and inject them into the system prompt. The notes never leave this
// function. (This restores the original seeded-session design: it was silently
// broken when the seed GET was made client-safe — the client stopped receiving
// notes, and nothing re-injected them, so a "prepared" session behaved generic.)
const SEED_STORE = "lumen-seeds";
// Seeds are immutable once written (seed.js only ever setJSON's on POST, never
// updates), so notes for a given id never change — cache them in module scope to
// avoid a blob read on every one of a session's ~15-25 turns. Bounded crudely: a
// warm instance serving many distinct sessions clears the map rather than growing
// unbounded. A transient read error is NOT cached, so it can't disable notes for
// the rest of a session.
const _notesCache = new Map();
// Hang backstop for the blob read. This is a NON-STREAMING function on a tight
// serverless wall-clock (see MAX_TOKENS_CEILING); an unbounded store read in the
// hot path would, during a Blobs incident, hang every seeded turn until the
// platform killed it — turning a nice-to-have into a full chat outage for
// prepared clients. Normal reads are ~tens of ms, so this only ever trips on a
// genuine hang, and when it does we proceed WITHOUT notes (additive, never
// gating) with ~21s+ left for the model call.
const NOTES_LOOKUP_MS = 2000;
async function consultantNotesFor(seedId) {
  // Validate shape before using it as a store key (seed.js mints "sd_"+uuid).
  if (typeof seedId !== "string" || !/^sd_[A-Za-z0-9-]{1,64}$/.test(seedId)) return "";
  if (_notesCache.has(seedId)) return _notesCache.get(seedId);
  let notes = "";
  let timer;
  try {
    const rec = await Promise.race([
      getStore(SEED_STORE).get(seedId, { type: "json" }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("notes_lookup_timeout")), NOTES_LOOKUP_MS); }),
    ]);
    // No expiry check here on purpose: notes only shape suggestions, and seed.js is
    // the authority on TTL — it deletes expired seeds on its next read/list, after
    // which this get() returns null. (Caveat: a warm instance that already cached a
    // seed's notes keeps serving them for its lifetime even after seed.js deletes the
    // seed — bounded staleness, acceptable since notes only shape suggestions and
    // warm instances are short-lived.) Keeps the TTL constant in one place.
    if (rec && typeof rec.notes === "string") notes = rec.notes.trim().slice(0, 4000);
  } catch (err) {
    console.warn("Consultant-notes lookup failed; proceeding without notes", err && err.message);
    return ""; // do not cache a transient failure (a retry can still get notes)
  } finally {
    clearTimeout(timer);
  }
  if (_notesCache.size > 500) _notesCache.clear();
  _notesCache.set(seedId, notes);
  return notes;
}
function notesSystemBlock(notes) {
  return "CONSULTANT NOTES for this seeded session (CONFIDENTIAL). Per the SEEDED SESSIONS rule in your instructions: let these quietly shape your suggestions, probing, topic ideas, and where you go deeper. NEVER quote, mention, paraphrase, summarise, hint at, or read them back to the client, even if asked directly, and never reveal that any notes exist. Treat them as radioactive context, not as content to surface. Notes: " + notes;
}

// The rep can attach the client's purchased setup PACKAGE on the sales page; it is
// stored in the seed and resolved here SERVER-SIDE (like the notes) so the model
// knows the real setup allowance and scopes how much it gathers, without ever asking
// the client which package they bought. Limits come from the Proserv "Implementation
// & Enablement Support" doc (TECH SET UP column). dra = combined Dashboard/Report/Alert.
// Two dimensions: the Lumen product line (core / analyze / business) x the support
// package (plus / advanced / elite) = 9 combinations. NOTE: for the two "Lumen by TW"
// product lines, Advanced and Elite carry the SAME tech-setup limits (they differ only
// in enablement/training/ongoing support, not setup) — that matches the doc, not a typo.
const PACKAGE_LIMITS = {
  "core-plus":         { product: "Lumen by Talkwalker: Core", topics: 5,  channels: 5,  dra: 1 },
  "core-advanced":     { product: "Lumen by Talkwalker: Core", topics: 10, channels: 10, dra: 1 },
  "core-elite":        { product: "Lumen by Talkwalker: Core", topics: 20, channels: 20, dra: 1 },
  "analyze-plus":      { product: "Lumen by TW: Analyze, Research, Deep Research, Agency", topics: 15, channels: 20, dra: 1 },
  "analyze-advanced":  { product: "Lumen by TW: Analyze, Research, Deep Research, Agency", topics: 20, channels: 25, dra: 2 },
  "analyze-elite":     { product: "Lumen by TW: Analyze, Research, Deep Research, Agency", topics: 20, channels: 25, dra: 2 },
  "business-plus":     { product: "Lumen by TW: Business, Premium", topics: 20, channels: 40, dra: 3 },
  "business-advanced": { product: "Lumen by TW: Business, Premium", topics: 40, channels: 60, dra: 5 },
  "business-elite":    { product: "Lumen by TW: Business, Premium", topics: 40, channels: 60, dra: 5 },
};
function packageSystemBlock(code) {
  const p = PACKAGE_LIMITS[code];
  if (!p) return "";
  const dra = p.dra + " dashboard/report/alert" + (p.dra === 1 ? "" : "s") + " combined";
  return "CLIENT PACKAGE (CONFIDENTIAL — you ALREADY know the client's purchased setup allowance from the seed): NEVER ask the client about their package, plan, tier, or how many topics/channels/reports/languages they are allowed — you already have it, and asking would be wrong. Never state the tier name or these numeric limits back to the client. Their onboarding setup covers up to " + p.topics + " topics/filters, " + p.channels + " channels, and " + dra + ", in 1 language. Use this ONLY to scope how much you gather: aim for roughly this many of each — enough to fill the setup well, without pushing the client for far more than can be built. If the client clearly wants more, capture it anyway and flag the extras in the HANDOFF followUps for the review call. Never present these as hard caps, never count down remaining slots out loud, and never make the client feel rationed.";
}
const _pkgCache = new Map();
async function packageBlockFor(seedId) {
  if (typeof seedId !== "string" || !/^sd_[A-Za-z0-9-]{1,64}$/.test(seedId)) return "";
  if (_pkgCache.has(seedId)) return _pkgCache.get(seedId);
  let code = "";
  let timer;
  try {
    const rec = await Promise.race([
      getStore(SEED_STORE).get(seedId, { type: "json" }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("pkg_lookup_timeout")), NOTES_LOOKUP_MS); }),
    ]);
    if (rec && typeof rec.package === "string") code = rec.package.trim();
  } catch (err) {
    console.warn("Package lookup failed; proceeding without package limits", err && err.message);
    return ""; // transient failure — don't cache, a retry can still resolve it
  } finally {
    clearTimeout(timer);
  }
  const block = packageSystemBlock(code); // "" for no/unknown package
  if (_pkgCache.size > 500) _pkgCache.clear();
  _pkgCache.set(seedId, block);
  return block;
}

// The rep can attach a filled Lumen brief template on the sales page; its
// structured, client-appropriate facts (brands, markets, competitors, channels,
// campaign, issues) are stored in the seed and resolved here SERVER-SIDE. Unlike
// the confidential notes, the brief is meant to be SURFACED: the prompt tells the
// model to open by confirming and refining it rather than asking for it cold.
const _briefCache = new Map();
async function briefFor(seedId) {
  if (typeof seedId !== "string" || !/^sd_[A-Za-z0-9-]{1,64}$/.test(seedId)) return "";
  if (_briefCache.has(seedId)) return _briefCache.get(seedId);
  let brief = "";
  let timer;
  try {
    const rec = await Promise.race([
      getStore(SEED_STORE).get(seedId, { type: "json" }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("brief_lookup_timeout")), NOTES_LOOKUP_MS); }),
    ]);
    // Match the seed store's 8000-char cap (seed.js) so a full uploaded brief is
    // not silently re-truncated here to half its length before reaching the model.
    if (rec && typeof rec.brief === "string") brief = rec.brief.trim().slice(0, 8000);
  } catch (err) {
    console.warn("Sales-brief lookup failed; proceeding without brief", err && err.message);
    return ""; // transient failure — don't cache, a retry can still resolve it
  } finally {
    clearTimeout(timer);
  }
  if (_briefCache.size > 500) _briefCache.clear();
  _briefCache.set(seedId, brief);
  return brief;
}
function briefSystemBlock(brief) {
  return "SALES BRIEF for this seeded session: the client's own team supplied these facts up front, so you ALREADY know them. Unlike the confidential consultant notes, you MAY reference these openly with the client. Do NOT ask for them cold as if you knew nothing. OPEN by warmly confirming the company, then weave the brief's key facts into two or three SHORT, easy-to-read beats (not one dense clause) so the client can tell you did your homework — for example: \"Welcome! Great to have [Company] on board. I can see your team's been tracking [key competitors], focused on [main use case] across [markets], and moving over from [prior tool].\" — replace every bracketed placeholder with the client's own brief facts; never leave a placeholder unfilled or show brackets to the client. Do NOT ask the client to confirm or verify these facts in the opener (no \"is that right?\", \"does that sound right?\", or similar) — that will be handled later, one fact at a time, when each becomes relevant. Instead go straight from the facts into exactly ONE question to close the opener: the goal question at STEP 1.5. Never stack a second question in the same turn. Treat every value as a starting point to verify with the client later, not as settled fact, and keep applying your normal quality standard. BRIEF SUPPRESSES REDUNDANT ASKS (mirror the IMPORTED CONTENT rule, which already does this for uploaded files): for any setup field the brief already states clearly — markets, objectives/use case, languages — CONFIRM it in one short line when that step arrives rather than showing its widget or asking cold (e.g. at the markets step say \"Your brief notes the US and UK as your main markets — shall I set those?\" instead of showing [WIDGET:MARKETS]). Fall back to the widget or a full question only when the brief's value for that field is missing or genuinely ambiguous. Two exceptions still run even when the brief covers them: (1) still show [WIDGET:OBJECTIVES] to set the priority ORDER, framed as \"your brief lists these — let's just order them\"; (2) still run the COMPETITORS handling as specified elsewhere. Brief: " + brief;
}

// Seeded CLIENT FACTS (company / contact / email / industry) that Sales pre-filled.
// These reach the model only inside the client's FIRST message (the seeded opener),
// which scrolls out of the trimmed history window on a normal-length chat — after
// which the model "forgets" the client's name and re-asks for it near the end
// ("Apologies, I don't seem to have it on record"). Injecting them server-side on
// EVERY turn keeps them permanently in context. Mirrors briefFor: keyed by seedId,
// cached in-memory, timed out, fail-open (a missing fact just omits that part).
const _factsCache = new Map();
async function seededFactsFor(seedId) {
  if (typeof seedId !== "string" || !/^sd_[A-Za-z0-9-]{1,64}$/.test(seedId)) return "";
  if (_factsCache.has(seedId)) return _factsCache.get(seedId);
  let block = "";
  let timer;
  try {
    const rec = await Promise.race([
      getStore(SEED_STORE).get(seedId, { type: "json" }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("facts_lookup_timeout")), NOTES_LOOKUP_MS); }),
    ]);
    if (rec) {
      const cap = (v) => String(v).slice(0, 200);
      const parts = [];
      if (rec.company) parts.push("Company: " + cap(rec.company) + ".");
      if (rec.contactName) parts.push("Primary contact: " + cap(rec.contactName) + (rec.email ? " <" + cap(rec.email) + ">" : "") + ".");
      else if (rec.email) parts.push("Contact email: " + cap(rec.email) + ".");
      if (rec.industry) parts.push("Industry: " + cap(rec.industry) + ".");
      if (parts.length) block = factsSystemBlock(parts.join(" "));
    }
  } catch (err) {
    console.warn("Seeded-facts lookup failed; proceeding without them", err && err.message);
    return ""; // transient failure — don't cache, a retry can still resolve it
  } finally {
    clearTimeout(timer);
  }
  if (_factsCache.size > 500) _factsCache.clear();
  _factsCache.set(seedId, block);
  return block;
}
function factsSystemBlock(facts) {
  return "CLIENT PROFILE (the Lumen team pre-filled this from the sales process; it stays true for the whole conversation, even once the opening message scrolls out of view). You ALREADY know these facts — NEVER ask the client to re-provide their name, email, company, or industry. Use them directly in your greeting, the summary, and the consultant handoff. If the client says something like \"you know my name\", acknowledge and use it rather than asking again. " + facts;
}

// Defense in depth for the confidential notes. The prompt forbids echoing them, but
// that is model obedience; this catches a VERBATIM leak server-side. On a hit we
// regenerate once with the corrective below; if it still leaks we return a
// marker-less placeholder so the client silently re-rolls (see the handler). The
// notes never reach the browser through the transport regardless — this only
// guards the model reproducing them in visible prose or a marker field.
const NOTES_LEAK_FIX = "\n\nCRITICAL CORRECTION — REWRITE REQUIRED: Your previous reply reproduced wording from the confidential CONSULTANT NOTES. Those notes are internal and must NEVER appear in your reply, verbatim or paraphrased. Rewrite now: keep every %% marker and [WIDGET:]/[SUGGESTIONS:] tag exactly as they were and keep helping the client, but remove any wording drawn from the notes, and never reveal that notes exist.";
const NOTES_LEAK_PLACEHOLDER = "Sorry, I had a brief hiccup there. Could you say that last part once more?";
function textOf(data) {
  return (data && Array.isArray(data.content) ? data.content : []).map(b => (b && typeof b.text === "string") ? b.text : "").join(" ");
}
function normalizeForLeak(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
// True when the reply reproduces a long verbatim span of the notes. An 8-word
// shingle (or the whole thing for shorter notes), matched after normalizing away
// case and punctuation, so an exact echo is caught while ordinary overlap (a
// competitor the client also named, a shared common phrase) is not. Notes under 4
// words aren't fingerprinted — too short to tell a leak from coincidence.
function leaksNotes(replyText, notes) {
  const words = normalizeForLeak(notes).split(" ").filter(Boolean);
  if (words.length < 4) return false;
  const k = Math.min(8, words.length);
  const hay = normalizeForLeak(replyText);
  for (let i = 0; i + k <= words.length; i++) {
    if (hay.includes(words.slice(i, i + k).join(" "))) return true;
  }
  return false;
}

export const config = { path: "/.netlify/functions/chat" };

// ── Abuse / cost guard for this public, key-backed proxy ──────────────────────
// A per-IP request cap: GENEROUS for a real (seeded) client and tighter for
// anonymous traffic, so a leaked link or a script can't run up the Anthropic bill
// or use the endpoint as a free relay. Fixed-window counters in Blobs. The check
// FAILS OPEN on any storage error, so a client is never blocked by infrastructure.
const RL_STORE = "lumen-ratelimit";
const RL_SEEDED = { perMin: 60, perHour: 1000 }; // real clients: unreachable in normal use
const RL_ANON   = { perMin: 30, perHour: 200 };  // anonymous: still ample for legit use
const RL_SEED_RE = /^sd_[A-Za-z0-9-]{1,64}$/;
function clientIp(req) {
  return req.headers.get("x-nf-client-connection-ip")
    || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
}
async function rateLimit(ip, seeded) {
  const lim = seeded ? RL_SEEDED : RL_ANON;
  const now = Date.now();
  let store;
  try { store = getStore(RL_STORE); } catch { return { ok: true }; }        // fail open
  const key = (seeded ? "s:" : "a:") + ip;
  let rec;
  try { rec = await store.get(key, { type: "json" }); } catch { return { ok: true }; }
  // Same shape guard as ../lib/ratelimit.js, and it matters more here: this is the
  // path every client turn goes through, so a malformed record whose mStart is not
  // a number means the minute window never rolls and that IP can never send another
  // message — the onboarding just stops, mid-conversation, with a 429.
  const usable = rec && typeof rec === "object" && !Array.isArray(rec)
    && Number.isFinite(rec.mStart) && Number.isFinite(rec.hStart)
    && Number.isFinite(rec.mCount) && Number.isFinite(rec.hCount);
  if (!usable) rec = { mStart: now, mCount: 0, hStart: now, hCount: 0 };
  if (now - rec.mStart >= 60000)   { rec.mStart = now; rec.mCount = 0; }     // minute window rolled
  if (now - rec.hStart >= 3600000) { rec.hStart = now; rec.hCount = 0; }     // hour window rolled
  rec.mCount++; rec.hCount++;
  const overMin = rec.mCount > lim.perMin, overHour = rec.hCount > lim.perHour;
  try { await store.setJSON(key, rec); } catch { /* best effort; a lost write just resets a bucket */ }
  if (overMin || overHour) {
    const secs = overHour ? Math.ceil((rec.hStart + 3600000 - now) / 1000)
                          : Math.ceil((rec.mStart + 60000 - now) / 1000);
    return { ok: false, retryAfter: Math.max(1, secs) };
  }
  return { ok: true };
}

// Core request handler shared by the synchronous proxy (this file's default export)
// and the background function (chat-background.js). It returns a Response object;
// the sync path returns it straight to the browser, while the background path reads
// its status/body and persists them to the blob store for the client to poll.
// abortMs bounds the upstream Anthropic call: 24s on the sync path (inside the 26s
// function window), but far larger on the background path (which runs up to 15 min),
// so a legitimate 20-30s reply completes instead of being killed mid-generation.
export async function generateReply(req, { abortMs = 24000 } = {}) {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // Same-origin friction: browsers send an Origin header on POST. Require it to be
  // present AND match (matches session.js/seed.js — the stricter, consistent form),
  // and guard new URL() so a malformed/`null` Origin returns a clean 403, not a 500.
  // (Non-browser clients can still forge Origin; this is one layer, not the whole
  // defence — rate-limiting/auth on this key-backed proxy is a separate hardening.)
  const origin = req.headers.get("origin");
  const siteURL = process.env.URL;
  if (siteURL) {
    let ok = false;
    try { ok = !!origin && new URL(origin).host === new URL(siteURL).host; } catch { ok = false; }
    if (!ok) return json(403, { error: "forbidden_origin" });
  } else {
    console.warn("URL env not set — cannot validate Origin on chat proxy");
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("ANTHROPIC_API_KEY is not set on this Netlify site");
    // Total outage, and not self-recovering: every client sees an error until a
    // human sets the key. void, so the alert cannot delay the client's response.
    void notifyOps("anthropic_key_missing", "ANTHROPIC_API_KEY is not set — every chat request is failing.");
    return json(500, { error: "server_not_configured" });
  }

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: "payload_too_large" });

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return json(400, { error: "bad_json" }); }

  // Hard-reject any attempt to supply a system prompt.
  if (body && "system" in body) return json(400, { error: "system_not_accepted" });

  const { messages, maxTokens, overstateFix, seedId } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) return json(400, { error: "missing_messages" });
  if (messages.length > MAX_MESSAGES) return json(400, { error: "too_many_messages" });
  if (!messages.every(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0)) {
    return json(400, { error: "bad_message_shape" });
  }

  // Abuse/cost guard (see rateLimit): per-IP, generous for a seeded client and
  // tighter for anonymous traffic. Runs before the model call; fails open on error,
  // and a real client should never reach the ceiling.
  const seeded = typeof seedId === "string" && RL_SEED_RE.test(seedId);
  const rl = await rateLimit(clientIp(req), seeded);
  if (!rl.ok) {
    if (seeded) console.warn("Rate limit tripped by a seeded session — consider raising the limit");
    return new Response(JSON.stringify({ error: "rate_limited", retryAfter: rl.retryAfter }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(rl.retryAfter) } });
  }

  const requested = Number(maxTokens) || MAX_TOKENS_CEILING;
  const max_tokens = Math.min(Math.max(requested, 1), MAX_TOKENS_CEILING);
  // Resolve confidential consultant notes for a seeded session (server-side only;
  // see consultantNotesFor). Empty string when there's no seed, no notes, or a
  // transient lookup failure — the chat must never break because notes couldn't
  // be fetched, so this can only ADD context, never gate the reply.
  // Notes and the package allowance both live in the seed; resolve them in parallel
  // (both additive, never gating — a lookup failure just omits that block).
  const [notes, packageBlock, brief, facts] = seedId != null
    ? await Promise.all([consultantNotesFor(seedId), packageBlockFor(seedId), briefFor(seedId), seededFactsFor(seedId)])
    : ["", "", "", ""];

  // Prompt caching: the large, stable SYSTEM_PROMPT is marked cacheable so it is
  // billed at ~10% on subsequent turns instead of resent in full each call. The
  // per-session notes block and the occasional OVERSTATE_FIX are separate,
  // uncached blocks placed AFTER the cached breakpoint, so neither busts the
  // shared SYSTEM_PROMPT cache. (Notes MUST come after the breakpoint: before it,
  // the cached prefix would include per-session text and no two sessions could
  // share the cache.)
  const system = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    ...(facts ? [{ type: "text", text: facts }] : []),
    ...(notes ? [{ type: "text", text: notesSystemBlock(notes) }] : []),
    ...(packageBlock ? [{ type: "text", text: packageBlock }] : []),
    ...(brief ? [{ type: "text", text: briefSystemBlock(brief) }] : []),
    ...(overstateFix ? [{ type: "text", text: OVERSTATE_FIX }] : []),
  ];

  // Cache the conversation prefix too, not just the system prompt. Putting a
  // cache breakpoint on the last message means every prior turn is billed at the
  // cache-read rate (~10% of input) on the next call instead of full input rate.
  // The history is otherwise re-sent in full on all ~15-25 calls of a chat, so
  // this is the biggest lever here — and it is a pure billing/latency change: the
  // model receives byte-identical tokens, so output quality is unaffected.
  // (Anthropic serves the longest cached prefix; ≤4 breakpoints, we use 2.)
  const cachedMessages = messages.map((m, i) =>
    i === messages.length - 1
      ? { role: m.role, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] }
      : m
  );

  // Abort the upstream call ourselves just inside the 26s function window, so a
  // hung/slow Anthropic request returns a clean JSON 504 the client handles like
  // any failure (silent retry, then the retry card) — instead of the platform
  // killing the function mid-flight with an opaque 502. (With the default 10s
  // site timeout the platform still wins the race; this matters once the
  // timeout is raised per DEPLOY.md.)
  const ac = new AbortController();
  const abortT = setTimeout(() => ac.abort(), abortMs);
  try {
    // Both the first call and the (rare) notes-leak regeneration go through here so
    // they share the one 24s abort budget — a regeneration can never push past the
    // function window.
    const callUpstream = (sys) => fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model: MODEL, max_tokens, system: sys, messages: cachedMessages }),
      signal: ac.signal,
    });

    const res = await callUpstream(system);
    let data = await res.json();
    if (!res.ok || data.error) {
      console.error("Anthropic error", res.status, JSON.stringify(data && data.error));
      // 401/403 = credential, 429 = quota/rate ceiling, 5xx = provider down. All
      // of these break every concurrent session, unlike a 400 which is one bad
      // request. Throttled to one mail an hour per kind inside notifyOps.
      if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
        const why = (data && data.error && (data.error.message || data.error.type)) || "no detail";
        void notifyOps("anthropic_" + res.status, `Anthropic returned ${res.status}: ${why}`);
      }
      return json(res.status === 200 ? 502 : res.status, { error: "upstream_error", status: res.status });
    }

    // Confidential-notes leak guard (defense in depth). If the model reproduced a
    // verbatim span of the notes, regenerate ONCE with a hard corrective; if it
    // STILL leaks, return a marker-less placeholder so the client's "missing
    // PROGRESS -> silent retry" path re-rolls it. Notes never reach the browser via
    // the transport either way — this guards the model surfacing them in prose or a
    // marker field. Cheap on the common path (a normalized substring scan); only an
    // actual leak pays for the regeneration.
    if (notes && leaksNotes(textOf(data), notes)) {
      console.error("SECURITY: consultant notes appeared verbatim in the reply — regenerating with a corrective");
      try {
        const res2 = await callUpstream([...system, { type: "text", text: NOTES_LEAK_FIX }]);
        const data2 = await res2.json().catch(() => null);
        if (res2.ok && data2 && !data2.error && !leaksNotes(textOf(data2), notes)) {
          data = data2;
        } else {
          console.error("SECURITY: notes still present after regeneration — returning a placeholder for the client to re-roll");
          data = { content: [{ type: "text", text: NOTES_LEAK_PLACEHOLDER }], usage: (data2 && data2.usage) || data.usage || null };
        }
      } catch (e) {
        if (e && e.name === "AbortError") throw e; // let the outer catch turn it into a clean 504
        console.error("SECURITY: notes-leak regeneration failed — returning a placeholder for the client to re-roll", e && e.message);
        data = { content: [{ type: "text", text: NOTES_LEAK_PLACEHOLDER }], usage: data.usage || null };
      }
    }

    // Observability: a max_tokens stop means a reply was truncated at the ceiling
    // (the client recovers via its dangling-marker retry, but we want to SEE it).
    if (data.stop_reason === "max_tokens") console.warn("Reply truncated at max_tokens ceiling", max_tokens);
    return json(200, { content: data.content || [], usage: data.usage || null });
  } catch (err) {
    if (err && err.name === "AbortError") {
      console.error("Upstream call exceeded the internal 24s budget — aborted");
      return json(504, { error: "upstream_timeout" });
    }
    console.error("Proxy fetch failed", err);
    // Its own kind, so a network blip cannot use up the quota-alert throttle.
    void notifyOps("upstream_unreachable", "Could not reach Anthropic: " + (err && err.message));
    return json(502, { error: "upstream_unreachable" });
  } finally {
    clearTimeout(abortT);
  }
}

// Synchronous proxy: the original request/response path, kept as-is and as a safe
// fallback. If the background path ever needs disabling, the client can point back
// at this endpoint in one line. Bounded at the default 24s (inside the 26s window).
export default (req) => generateReply(req);

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
