import { useState, useRef, useEffect, useCallback, useMemo, memo, Component } from "react";
// xlsx is the bulk of the JS bundle and is only needed when a client uploads a
// file (QUERIES) or exports/sends the brief — never on first paint. Load it
// lazily so it code-splits into its own chunk and doesn't tax the initial load.
let _xlsxMod = null;
async function loadXLSX() {
  if (!_xlsxMod) { const m = await import("xlsx"); _xlsxMod = m.default || m; }
  return _xlsxMod;
}

// ================= LIVE CONFIG =================
// Frontends are served from the same Netlify site as the functions, so these
// are same-origin relative paths (no CORS).
const CHAT_ENDPOINT = "/.netlify/functions/chat"; // synchronous fallback (see chat.js)
// Live path: kick off generation on a BACKGROUND function (no 26s ceiling), then
// poll for the result. See callAPI and netlify/functions/chat-background.js.
const CHAT_BG_ENDPOINT = "/.netlify/functions/chat-background";
const CHAT_STATUS_ENDPOINT = "/.netlify/functions/chat-status";
const SESSION_ENDPOINT = "/.netlify/functions/session";
const SEED_ENDPOINT = "/.netlify/functions/seed";
const SHEET_ENDPOINT = "/.netlify/functions/sheet";
// Demo-only controls (preview / simulate / rewind) are hidden on the live site.
const DEV = false;

// 100vh on mobile browsers (iOS Safari especially) does NOT shrink when the
// on-screen keyboard opens, so a 100vh-locked layout pushes the pinned composer
// behind the keyboard — on the core interaction (typing a reply). 100dvh tracks
// the actual visible viewport; where unsupported we fall back to 100vh (status quo).
const VH_FULL = (typeof CSS !== "undefined" && CSS.supports && CSS.supports("height", "100dvh")) ? "100dvh" : "100vh";

// The CSS reduce-motion query kills CSS animations, but an explicit JS
// scrollIntoView({behavior:"smooth"}) overrides it — honour the setting there too.
const REDUCE_MOTION = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The Sales page stores the profile server-side and puts only an opaque id in
// the client link (?s=<id>). Fetch the CLIENT-SAFE fields (no consultant notes;
// notes are returned only to the token-authenticated dashboard). Returns
// { seed, seedId } or { seed:null, seedId:null }.
// fetch with a hard timeout so a hung request never freezes the UI (a spinner
// that never resolves, a Send button stuck disabled). Aborts after `ms` and
// rejects like any network error; every caller already handles fetch rejection.
async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function fetchSeedFromURL() {
  const id = new URLSearchParams(location.search).get("s");
  if (!id) return { seed: null, seedId: null };
  // Retry once on a transient failure. If it still fails, KEEP the seedId so the
  // consultant-notes linkage survives (the completed record can still be joined
  // to the seed store) rather than silently downgrading a prepared session to a
  // generic one and orphaning the notes.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(`${SEED_ENDPOINT}?id=${encodeURIComponent(id)}`, {}, 15000);
      if (res.ok) {
        const data = await res.json();
        const seed = data && data.seed && data.seed.company ? data.seed : null;
        return { seed, seedId: id, seedError: !seed };
      }
      // A 404 is DEFINITIVE: the link expired (the record is swept on read) or was
      // never stored. Retrying cannot succeed, and it needs different wording —
      // "refresh to try again" is false for an expired link. Distinguish it so the
      // client is told the truth instead of being sent to reload forever.
      if (res.status === 404) {
        const body = await res.json().catch(() => null);
        return { seed: null, seedId: id, seedError: true, seedExpired: !!body && body.error === "expired" };
      }
    } catch { /* fall through to retry */ }
  }
  return { seed: null, seedId: id, seedError: true };
}

// Maps the UI language to a BCP-47 locale so a date separator reads naturally
// ("lundi 3 mars" rather than "Monday, 3 March") for the language they chose.
const LOCALE_OF = { English:"en-GB", French:"fr-FR", German:"de-DE", Spanish:"es-ES", Italian:"it-IT", Arabic:"ar" };
// Right-to-left scripts among the supported UI languages. Drives the `dir` attribute
// set by the effect in OnboardingApp, which in turn activates the [dir="rtl"] font
// rule further down and flips every marginInline*/paddingInline* logical property the
// layout already uses. Without a `dir` setter that whole RTL layer is inert.
const RTL_LANGS = new Set(["Arabic"]);
const MIN_MS = 1500;
const P = "#012B3A";
const A = "#7E48EC";   // Lumen purple (sampled from official wordmark)
const NAVY = "#1A3B7B"; // Talkwalker navy (sampled from official wordmark)
const LINK = "#6D28D9"; // interactive purple

// ---- Design tokens (H1/H3). One source of truth for radius / shadow / motion /
// type so a visual change is one edit, not forty. These are theme-invariant;
// light/dark COLOURS still live in the `C` theme object inside OnboardingApp.
// Intent, so the next person (or session) doesn't reinvent the ramp:
//   radius  sm=chips/tags · md=cards/inputs/bubbles · lg=modals/hero · pill=round
//   shadow  raise=cards · float=popovers · modal=modals · glow=primary CTA ONLY
//   motion  fast=taps · base=most · slow=large surfaces · easeOut=enter easing
//   text    caption · body · emphasis · title · hero  (weight+colour do the rest)
const T = {
  radius: { sm: 6, md: 10, lg: 16, pill: 999 },
  shadow: {
    raise: "0 1px 3px rgba(1,43,58,.08)",
    float: "0 8px 24px rgba(0,0,0,.12)",
    modal: "0 16px 48px rgba(0,0,0,.2)",
    glow:  "0 4px 14px rgba(126,72,236,.30)",
  },
  motion: { fast: "120ms", base: "200ms", slow: "320ms", easeOut: "cubic-bezier(.2,0,0,1)" },
  text: { caption: 11, body: 13, emphasis: 15, title: 20, hero: 28 },
};

const SECTION_KEYS   = ["company","path","topics","channels","reports","users"];
const SECTION_LABELS = { company:"About you", path:"Approach", topics:"What to track", channels:"Where to look", reports:"Reports", users:"Your team" };
const SECTION_LABEL_KEYS = { company:"secAbout", path:"secApproach", topics:"secTrack", channels:"secLook", reports:"secReports", users:"secTeam" };
const WIDGET_MAX     = { OBJECTIVES:3, TIMEZONE:1 };
const MARKETS_OPT    = ["United States","United Kingdom","France","Germany","Spain","Italy","Netherlands","Canada","Australia","Brazil","Japan","South Korea","India","Middle East","APAC","LATAM","Global"];
const LANG_OPT       = ["English","French","German","Spanish","Italian","Dutch","Portuguese","Japanese","Korean","Mandarin","Arabic","Hindi"];
const OBJ_OPT        = ["Competitive Intelligence","Campaign Optimization","Content Ideation & Recommendation","Reputation Management","Social Measurement","Brand Health Measurement","Issue Tracking","PR Measurement","Influencer Management","Consumer Insights","Trend Research"];
const TEAM_OPT       = ["Marketing","Communications","PR","Brand","Digital","Social Media","Legal","Product","Research","Executive","Customer Experience","Corporate Affairs"];
const TZ_OPT         = ["GMT / UTC","CET (UTC+1)","EET (UTC+2)","GST (UTC+4)","IST (UTC+5:30)","SGT (UTC+8)","JST (UTC+9)","AEST (UTC+10)","EST (UTC-5)","CST (UTC-6)","MST (UTC-7)","PST (UTC-8)"];
// Localised DISPLAY labels for the widget option lists above.
//
// The values in *_OPT are the canonical taxonomy: they are what gets stored in
// `sel`, sent to the model by widgetApiPayload, written into the %% markers, and
// carried through to the brief, the Sheet and the dashboard. Those must NOT
// change per language or the consultant's export stops matching the template.
// Only what the client READS is translated, so the canonical value and the label
// stay independent.
//
// Why this is needed: the widgets rendered these arrays raw, so a French client
// was told in French to pick "Gestion de la réputation" and then shown a chip
// reading "Reputation Management" — the label they were just given did not exist
// on screen. Confirmed live in French and Arabic against the deployed build; in
// Arabic it also put a block of LTR English chips inside an RTL layout.
//
// Order of each tuple: [French, German, Spanish, Italian, Arabic].
const OPT_LANG_ORDER = ["French", "German", "Spanish", "Italian", "Arabic"];
const OPT_LABELS = {
  // OBJ_OPT
  "Competitive Intelligence":          ["Veille concurrentielle","Wettbewerbsbeobachtung","Inteligencia competitiva","Intelligence competitiva","الذكاء التنافسي"],
  "Campaign Optimization":             ["Optimisation des campagnes","Kampagnenoptimierung","Optimización de campañas","Ottimizzazione delle campagne","تحسين الحملات"],
  "Content Ideation & Recommendation": ["Idées et recommandations de contenu","Content-Ideen & Empfehlungen","Ideación y recomendación de contenido","Ideazione e raccomandazione di contenuti","ابتكار المحتوى والتوصيات"],
  "Reputation Management":             ["Gestion de la réputation","Reputationsmanagement","Gestión de la reputación","Gestione della reputazione","إدارة السمعة"],
  "Social Measurement":                ["Mesure des réseaux sociaux","Social-Media-Messung","Medición en redes sociales","Misurazione social","قياس أداء وسائل التواصل"],
  "Brand Health Measurement":          ["Mesure de la santé de marque","Messung der Markengesundheit","Medición de la salud de marca","Misurazione della brand health","قياس صحة العلامة التجارية"],
  "Issue Tracking":                    ["Suivi des incidents","Themenverfolgung","Seguimiento de incidencias","Monitoraggio delle criticità","تتبع القضايا"],
  "PR Measurement":                    ["Mesure des relations presse","PR-Messung","Medición de relaciones públicas","Misurazione PR","قياس العلاقات العامة"],
  "Influencer Management":             ["Gestion des influenceurs","Influencer-Management","Gestión de influencers","Gestione degli influencer","إدارة المؤثرين"],
  "Consumer Insights":                 ["Insights consommateurs","Verbraucher-Insights","Insights del consumidor","Insight sui consumatori","رؤى المستهلكين"],
  "Trend Research":                    ["Analyse des tendances","Trendforschung","Investigación de tendencias","Ricerca sui trend","أبحاث الاتجاهات"],
  // TEAM_OPT
  "Marketing":            ["Marketing","Marketing","Marketing","Marketing","التسويق"],
  "Communications":       ["Communication","Kommunikation","Comunicación","Comunicazione","الاتصال المؤسسي"],
  "PR":                   ["Relations presse","PR","Relaciones públicas","Relazioni pubbliche","العلاقات العامة"],
  "Brand":                ["Marque","Marke","Marca","Brand","العلامة التجارية"],
  "Digital":              ["Digital","Digital","Digital","Digital","القسم الرقمي"],
  "Social Media":         ["Réseaux sociaux","Social Media","Redes sociales","Social media","وسائل التواصل الاجتماعي"],
  "Legal":                ["Juridique","Recht","Legal","Legale","الشؤون القانونية"],
  "Product":              ["Produit","Produkt","Producto","Prodotto","المنتج"],
  "Research":             ["Études","Marktforschung","Investigación","Ricerca","الأبحاث"],
  "Executive":            ["Direction","Geschäftsleitung","Dirección","Direzione","الإدارة التنفيذية"],
  "Customer Experience":  ["Expérience client","Kundenerlebnis","Experiencia del cliente","Customer experience","تجربة العملاء"],
  "Corporate Affairs":    ["Affaires institutionnelles","Unternehmenskommunikation","Asuntos corporativos","Affari societari","الشؤون المؤسسية"],
  // MARKETS_OPT
  "United States":  ["États-Unis","USA","Estados Unidos","Stati Uniti","الولايات المتحدة"],
  "United Kingdom": ["Royaume-Uni","Vereinigtes Königreich","Reino Unido","Regno Unito","المملكة المتحدة"],
  "France":         ["France","Frankreich","Francia","Francia","فرنسا"],
  "Germany":        ["Allemagne","Deutschland","Alemania","Germania","ألمانيا"],
  "Spain":          ["Espagne","Spanien","España","Spagna","إسبانيا"],
  "Italy":          ["Italie","Italien","Italia","Italia","إيطاليا"],
  "Netherlands":    ["Pays-Bas","Niederlande","Países Bajos","Paesi Bassi","هولندا"],
  "Canada":         ["Canada","Kanada","Canadá","Canada","كندا"],
  "Australia":      ["Australie","Australien","Australia","Australia","أستراليا"],
  "Brazil":         ["Brésil","Brasilien","Brasil","Brasile","البرازيل"],
  "Japan":          ["Japon","Japan","Japón","Giappone","اليابان"],
  "South Korea":    ["Corée du Sud","Südkorea","Corea del Sur","Corea del Sud","كوريا الجنوبية"],
  "India":          ["Inde","Indien","India","India","الهند"],
  "Middle East":    ["Moyen-Orient","Naher Osten","Oriente Medio","Medio Oriente","الشرق الأوسط"],
  "APAC":           ["APAC","APAC","APAC","APAC","آسيا والمحيط الهادئ"],
  "LATAM":          ["LATAM","LATAM","LATAM","LATAM","أمريكا اللاتينية"],
  "Global":         ["International","Weltweit","Global","Globale","عالمي"],
  // LANG_OPT
  "English":    ["Anglais","Englisch","Inglés","Inglese","الإنجليزية"],
  "German":     ["Allemand","Deutsch","Alemán","Tedesco","الألمانية"],
  "Spanish":    ["Espagnol","Spanisch","Español","Spagnolo","الإسبانية"],
  "Italian":    ["Italien","Italienisch","Italiano","Italiano","الإيطالية"],
  "Dutch":      ["Néerlandais","Niederländisch","Neerlandés","Olandese","الهولندية"],
  "Portuguese": ["Portugais","Portugiesisch","Portugués","Portoghese","البرتغالية"],
  "Japanese":   ["Japonais","Japanisch","Japonés","Giapponese","اليابانية"],
  "Korean":     ["Coréen","Koreanisch","Coreano","Coreano","الكورية"],
  "Mandarin":   ["Mandarin","Mandarin","Mandarín","Mandarino","الماندرين"],
  "Hindi":      ["Hindi","Hindi","Hindi","Hindi","الهندية"],
  "Arabic":     ["Arabe","Arabisch","Árabe","Arabo","العربية"],
  // "French" is intentionally absent as a key: it collides with the MARKETS entry
  // for the country France only if spelled the same, which it is not, but the
  // language "French" still needs its own row.
  "French":     ["Français","Französisch","Francés","Francese","الفرنسية"],
};
// TZ_OPT is deliberately NOT translated: its entries are international offset
// codes ("CET (UTC+1)") that are used verbatim in every language.
//
// Falls back to the canonical string for English, an unknown language, or an
// option with no translation (including anything the client typed themselves),
// so a missing row degrades to today's behaviour rather than a blank chip.
export function optLabel(option, lang) {
  const i = OPT_LANG_ORDER.indexOf(lang);
  if (i === -1) return option;
  const row = OPT_LABELS[option];
  return (row && row[i]) || option;
}
// Exported for tests/: the lists that render through optLabel, so a completeness
// check can fail the build when an option is added without its translations —
// the failure mode here is silent (the chip just reverts to English for every
// non-English client) and would otherwise only surface in front of a client.
export const TRANSLATED_OPTION_LISTS = { OBJ_OPT, TEAM_OPT, MARKETS_OPT, LANG_OPT };
export const UNTRANSLATED_OPTION_LISTS = { TZ_OPT };
export const OPT_LANGS = OPT_LANG_ORDER;

const EMAIL_RE       = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// OBJECTIVES widget data was a plain array before ranking was added; normalize
// both shapes so saved/resumed sessions from older versions keep working.
const normObjectives = d => Array.isArray(d) ? {ranked:d, details:""}
  : (d && typeof d === "object") ? {ranked:d.ranked||[], details:d.details||""}
  : {ranked:[], details:""};
const fmtRanked = d => { const n = normObjectives(d); return n.ranked.length ? n.ranked.map((o,i)=>`${i+1}. ${o}`).join(", ") : ""; };

// The exact first message a real client link produces (used by startConvo).
// Carries a language directive when the session isn't in English.
function seededOpener(sd, uiLang) {
  const langDirective = uiLang && uiLang !== "English" ? ` Please conduct the entire conversation in ${uiLang}.` : "";
  if (sd) {
    // Contact name is optional at seeding: include it only when present, otherwise
    // fall back to just the email (if any). The system prompt tells the model to open
    // with a general welcome, no name, when none is provided.
    const contactPart = sd.contactName
      ? ` Contact: ${sd.contactName}${sd.email?` (${sd.email})`:""}.`
      : (sd.email ? ` Contact email: ${sd.email}.` : "");
    return `[SEEDED SESSION] Prepared by the Lumen team. Company: ${sd.company}.${contactPart}${sd.industry?` Industry: ${sd.industry}.`:""}${sd.notes?` Consultant notes (do not read back to the client): ${sd.notes}.`:""} The client has just opened their link.${langDirective}`;
  }
  return `Hello, I'm ready to get started.${langDirective}`;
}

// ================= CLIENT-SIDE LANGUAGE ==================
// Sales seeds a language; the client can override it on the welcome screen with one
// tap. The choice drives the welcome-screen copy, RTL for Arabic, the seeded opener,
// and the simulated client persona. Only the welcome-screen shell is translated; the
// live conversation follows the LANGUAGE rule in the system prompt.
const UI_LANGS = [
  { code:"English", native:"English" },
  { code:"French",  native:"Français" },
  { code:"German",  native:"Deutsch" },
  { code:"Spanish", native:"Español" },
  { code:"Italian", native:"Italiano" },
  { code:"Arabic",  native:"العربية" },
];

const I18N = {
  English: {
    welcomeTitle:       "Welcome to Lumen Onboarding",
    welcomeTitleSeeded: "Welcome, {name}!",
    welcomeSub:         "We\u2019ll ask about your goals, markets, and team \u2014 then generate your Lumen setup brief.",
    welcomeSubSeeded:   "We\u2019ll talk through your goals, markets, and team \u2014 and build your setup brief as we go.",
    step1Title: "About 15 minutes",
    step1Desc:  "Pause anytime — reopen this link on the same device and you'll pick up where you left off.",
    step1DescNoSave: "Heads up: this browser isn't saving your progress (private mode?), so please try to finish in one sitting.",
    welcomeBackTitle: "Welcome back!",
    welcomeBackDesc:  "You have an onboarding session in progress.",
    savedPercent:     "{pct}% complete",
    savedOnDevice:    "Your answers are saved on this device",
    savedAnyDevice:   "Your answers are saved. Reopen this link on any device to continue.",
    savedFullAny: "\u2713 Progress saved",
    step1DescAny: "Pause anytime. Reopen this link on any device and you'll pick up where you left off.",
    resumeBtn:        "Resume session",
    startOverBtn:     "Start over",
    eraseWarn:        "Starting over permanently erases your saved answers. This can't be undone.",
    keepBtn:          "Keep my progress",
    eraseBtn:         "Erase and start over",
    step2Title: "A conversation, not a form",
    step2Desc:  "We'll cover your goals, what to track, where your audience talks, reports, and your team.",
    step3Title: "Then we take it from there",
    step3Desc:  "Your setup brief goes straight to your Lumen team. A consultant follows up to book your review call.",
    disclaimer: "You'll be chatting with an AI assistant. Your answers go only to your Lumen onboarding team, and a consultant reviews everything before any setup begins.",
    startBtn:       "Start",
    startBtnSeeded: "Start {company}'s setup",
    thinking:       "Assistant is thinking\u2026",
    chooseLang:     "Choose your language to begin",
    preparedFor:    "Prepared for {company}",
    think1:         "Reading your answer\u2026",
    think2:         "Updating your setup brief\u2026",
    think3:         "Preparing the next step\u2026",
    docThink1:      "Reading your document\u2026",
    docThink2:      "Pulling out the useful details\u2026",
    docThink3:      "This can take a bit longer for bigger files\u2026",
    privacyNote:    "Your answers are shared only with your Lumen onboarding team.",
    panelTitle: "Captured so far",
    panelEmpty: "Your answers will appear here as we go.",
    panelPending: "{n} more to fill in as you chat.",
    panelStillTo: "Still to capture",
    gapToday: "Today",
    seedErrTransient: "We couldn't load your prepared setup just now, so we'll start fresh below. Your details are still safe with your Lumen contact, or refresh the page to try loading them again.",
    seedErrExpired: "This link has expired, so we'll start fresh below. Everything still reaches your Lumen team, but they can send you a new link if you'd rather pick up where you left off.",
    gapYesterday: "Yesterday",
    panelHide: "Hide",
    panelFixAria: "Correct {label} in the chat",
    panelFixStarter: "Actually, {label} should be ",
    pnlSkipped: "Skipped",
    pnlCompany: "Company",
    pnlEmail: "Email",
    pnlIndustry: "Industry",
    pnlGoal: "Goal",
    pnlMarkets: "Markets",
    pnlLanguages: "Languages",
    pnlObjectives: "Priorities",
    pnlTeams: "Teams",
    pnlTimezone: "Timezone",
    pnlTopics: "Topics",
    pnlChannels: "Channels",
    pnlReports: "Reports",
    pnlAlerts: "Alerts",
    pnlUsers: "Users",
    retryFail: "That didn't go through. Tap Try again to resend.",
    tryAgain: "Try again",
    youChose: "You chose:",
    initErrMsg: "We couldn't reach the assistant. Please check your connection and try again.",
    showEarlier: "Show {n} earlier messages",
    secAbout: "About you",
    secApproach: "Approach",
    secTrack: "What to track",
    secLook: "Where to look",
    secReports: "Reports",
    secTeam: "Your team",
    stepN: "Step {n} of {total}",
    divDone: "{label} — done",
    divToGo: "{n} to go",
    hdrAssistant: "Onboarding Assistant",
    hdrTagline: "Your answers go straight to your Lumen onboarding team",
    savedFull: "✓ Saved on this device",
    savedShort: "✓ Saved",
    phReply: "Type your reply…",
    phAnswerAbove: "Answer above — or just type it here",
    reviewBtn: "Finished early, or stuck? Review and send your brief",
    sendNowBtn: "Review and send what you have",
    sendHint: "↵ to send · Shift+↵ for a new line",
    expTitle: "Your setup brief",
    expSubtitle: "Everything you’ve shared, in one place. Open a section to adjust anything.",
    expClose: "Close review",
    expReady: "Ready to send",
    expAlmost: "Almost there",
    expReadyDesc: "All required fields complete and all topics confirmed.",
    expStillNeeded: "Still needed: {gaps}",
    expFooterReady: "✓ Ready to send",
    expMore: "+{n} more",
    expRequired: "Required",
    expOptional: "Optional",
    expTopic: "topic", expTopics: "topics",
    expChannel: "channel", expChannels: "channels",
    expReport: "report", expReports: "reports",
    expUser: "user", expUsers: "users",
    expReqCompany: "Company name",
    expReqEmail: "Contact email",
    expReqMarkets: "Markets",
    expReqLanguages: "Languages",
    expReqObjectives: "Priorities",
    expReqTopic: "At least one topic",
    expReqTopicsConfirmed: "All topics confirmed",
    expReqUser: "At least one user",
    expSecBusiness: "About your business",
    expSecTeam: "Your team",
    expSecTrack: "What we’ll track",
    expSecLook: "Where we’ll look",
    expSecReports: "Reports and alerts",
    expFldName: "Company Name",
    expFldEmail: "Contact Email",
    expFldIndustry: "Industry",
    expFldMarkets: "Geographic Markets",
    expFldLanguages: "Key Languages",
    expFldObjectives: "Priorities",
    expFldObjDetails: "Priority details",
    expFldUseCases: "Goal",
    expFldTimezone: "Preferred Time Zone",
    expFldTeams: "Teams / Departments",
    expFldContact: "Main Point of Contact",
    expNoUsers: "No users captured.",
    expUFirst: "First name",
    expULast: "Last name",
    expUEmail: "Email",
    expURole: "Role",
    expRemoveUser: "Remove user {name}",
    expAddUser: "+ Add user",
    expNoTopics: "No topics captured.",
    expUnconfirmedOne: "{n} topic was suggested by the assistant. Confirm or drop it before handing off.",
    expUnconfirmedMany: "{n} topics were suggested by the assistant. Confirm or drop them before handing off.",
    expGuess: "Assistant guess",
    expConfirmed: "Confirmed",
    expConfirm: "Confirm",
    expDrop: "Drop",
    expRemoveTopic: "Remove topic {name}",
    expTopicName: "Topic name",
    expKeywords: "Keywords…",
    expRationale: "Rationale / comments…",
    expAddTopic: "+ Add topic",
    expPasteLabel: "Have a list already? Paste it",
    expPasteTopicPh: "One topic per line. Optionally add keywords and a note separated by | (e.g. Nike | \"Nike\" OR @Nike | main competitor)",
    expNoChannels: "No channels captured.",
    expChName: "Name / handle",
    expChPlatform: "Platform",
    expChUrl: "URL",
    expChOwned: "Owned or competitor?",
    expRemoveChannel: "Remove channel {name}",
    expAddChannel: "+ Add channel",
    expPasteChannelPh: "One channel per line: a URL, a name, or both (e.g. Nike https://twitter.com/nike)",
    expReportsHdr: "Reports and dashboards",
    expNoReports: "No reports captured.",
    expRepName: "Report name",
    expRepKind: "Type",
    expRepKindDashboard: "Dashboard",
    expRepKindReport: "Report",
    expObjective: "Objective",
    expDetails: "Details",
    expComments: "Comments",
    expRemoveReport: "Remove report {name}",
    expAddReport: "+ Add report",
    expAlertsHdr: "Alerts",
    expNoAlerts: "No alerts captured.",
    expAlName: "Alert name",
    expType: "Type",
    expRemoveAlert: "Remove alert {name}",
    expAddAlert: "+ Add alert",
    expSendFailed: "We couldn’t send your brief just now. Please check your connection and press Send again.",
    expCancel: "Cancel",
    expDownload: "Download a copy",
    expSending: "Sending…",
    expSend: "Send to my Lumen team",
    expIncompleteTitle: "Your brief isn’t complete yet",
    expIncompleteBody: "That’s okay. You can send what you have now, and we’ll go through the rest together at your review session.",
    expSendAnyway: "Send it anyway",
    expKeepGoing: "Keep going",
    expImport: "Import",
    editPrefill: "Correction, earlier I said \"{quote}\". What I actually meant: ",
    editTitle: "Send a correction without deleting any messages",
    editLabel: "Edit",
    focusWidgetGroup: "Interactive options",
    focusRepliesGroup: "Suggested replies",
  },
  French: {
    welcomeTitle:       "Bienvenue dans l'onboarding Lumen",
    welcomeTitleSeeded: "Bienvenue, {name} !",
    welcomeSub:         "Nous vous poserons des questions sur vos objectifs, vos marchés et votre équipe, puis nous générerons votre brief de configuration Lumen.",
    welcomeSubSeeded:   "Nous aborderons vos objectifs, vos marchés et votre équipe, et construirons votre brief au fur et à mesure.",
    step1Title: "Environ 15 minutes",
    step1Desc:  "Faites une pause quand vous voulez : rouvrez ce lien sur le même appareil et vous reprendrez là où vous vous étiez arrêté.",
    step1DescNoSave: "À noter : ce navigateur n'enregistre pas votre progression (mode privé ?). Essayez de terminer en une seule fois.",
    welcomeBackTitle: "Bon retour !",
    welcomeBackDesc:  "Vous avez une session d'onboarding en cours.",
    savedPercent:     "Terminé à {pct} %",
    savedOnDevice:    "Vos réponses sont enregistrées sur cet appareil",
    savedAnyDevice:   "Vos réponses sont enregistrées. Rouvrez ce lien sur n'importe quel appareil pour continuer.",
    savedFullAny: "\u2713 Progression enregistrée",
    step1DescAny: "Faites une pause quand vous voulez. Rouvrez ce lien sur n'importe quel appareil et vous reprendrez là où vous vous étiez arrêté.",
    resumeBtn:        "Reprendre la session",
    startOverBtn:     "Recommencer",
    eraseWarn:        "Recommencer efface définitivement vos réponses enregistrées. Cette action est irréversible.",
    keepBtn:          "Conserver ma progression",
    eraseBtn:         "Effacer et recommencer",
    step2Title: "Une conversation, pas un formulaire",
    step2Desc:  "Nous aborderons vos objectifs, ce qu'il faut suivre, où votre audience s'exprime, les rapports et votre équipe.",
    step3Title: "Ensuite, nous prenons le relais",
    step3Desc:  "Votre brief de configuration est transmis directement à votre équipe Lumen. Un consultant vous contacte pour planifier votre appel de révision.",
    disclaimer: "Vous échangez avec un assistant IA. Vos réponses sont transmises uniquement à votre équipe d'onboarding Lumen, et un consultant vérifie tout avant le début de la configuration.",
    startBtn:       "Commencer",
    startBtnSeeded: "Démarrer la configuration de {company}",
    thinking:       "L'assistant réfléchit\u2026",
    chooseLang:     "Choisissez votre langue pour commencer",
    preparedFor:    "Préparé pour {company}",
    think1:         "Je lis votre réponse…",
    think2:         "Je mets à jour votre brief…",
    think3:         "Je prépare la suite…",
    docThink1:      "Je lis votre document…",
    docThink2:      "J'en extrais les informations utiles…",
    docThink3:      "Cela peut prendre un peu plus de temps pour les fichiers volumineux…",
    privacyNote:    "Vos réponses ne sont partagées qu'avec votre équipe d'onboarding Lumen.",
    panelTitle: "Saisi jusqu'ici",
    panelEmpty: "Vos réponses apparaîtront ici au fur et à mesure.",
    panelPending: "encore {n} à compléter au fil de la conversation.",
    panelStillTo: "Reste à renseigner",
    gapToday: "Aujourd'hui",
    seedErrTransient: "Nous n'avons pas pu charger votre configuration préparée pour le moment, nous repartons donc de zéro ci-dessous. Vos informations restent en sécurité auprès de votre contact Lumen, ou actualisez la page pour réessayer.",
    seedErrExpired: "Ce lien a expiré, nous repartons donc de zéro ci-dessous. Tout parvient toujours à votre équipe Lumen, mais elle peut vous envoyer un nouveau lien si vous préférez reprendre où vous en étiez.",
    gapYesterday: "Hier",
    panelHide: "Masquer",
    panelFixAria: "Corriger {label} dans le chat",
    panelFixStarter: "En fait, {label} devrait être ",
    pnlSkipped: "Passé",
    pnlCompany: "Entreprise",
    pnlEmail: "E-mail",
    pnlIndustry: "Secteur",
    pnlGoal: "Objectif",
    pnlMarkets: "Marchés",
    pnlLanguages: "Langues",
    pnlObjectives: "Priorités",
    pnlTeams: "Équipes",
    pnlTimezone: "Fuseau horaire",
    pnlTopics: "Sujets",
    pnlChannels: "Canaux",
    pnlReports: "Rapports",
    pnlAlerts: "Alertes",
    pnlUsers: "Utilisateurs",
    retryFail: "Le message n'est pas passé. Touchez Réessayer pour le renvoyer.",
    tryAgain: "Réessayer",
    youChose: "Votre choix :",
    initErrMsg: "Impossible de joindre l'assistant. Vérifiez votre connexion et réessayez.",
    showEarlier: "Afficher les {n} messages précédents",
    secAbout: "À propos de vous",
    secApproach: "Approche",
    secTrack: "À surveiller",
    secLook: "Où chercher",
    secReports: "Rapports",
    secTeam: "Votre équipe",
    stepN: "Étape {n} sur {total}",
    divDone: "{label} — terminé",
    divToGo: "encore {n}",
    hdrAssistant: "Assistant d'onboarding",
    hdrTagline: "Vos réponses sont transmises directement à votre équipe d'onboarding Lumen",
    savedFull: "✓ Enregistré sur cet appareil",
    savedShort: "✓ Enregistré",
    phReply: "Écrivez votre réponse…",
    phAnswerAbove: "Répondez ci-dessus — ou écrivez-le ici",
    reviewBtn: "Terminé plus tôt ou bloqué ? Revoyez et envoyez votre brief",
    sendNowBtn: "Vérifier et envoyer ce que vous avez",
    sendHint: "↵ pour envoyer · Maj+↵ pour un saut de ligne",
    expTitle: "Votre brief de configuration",
    expSubtitle: "Tout ce que vous avez partagé, au même endroit. Ouvrez une section pour ajuster ce que vous voulez.",
    expClose: "Fermer la revue",
    expReady: "Prêt à envoyer",
    expAlmost: "Presque terminé",
    expReadyDesc: "Tous les champs obligatoires sont remplis et tous les sujets sont confirmés.",
    expStillNeeded: "Encore nécessaire : {gaps}",
    expFooterReady: "✓ Prêt à envoyer",
    expMore: "+{n} de plus",
    expRequired: "Obligatoire",
    expOptional: "Facultatif",
    expTopic: "sujet", expTopics: "sujets",
    expChannel: "canal", expChannels: "canaux",
    expReport: "rapport", expReports: "rapports",
    expUser: "utilisateur", expUsers: "utilisateurs",
    expReqCompany: "Nom de l'entreprise",
    expReqEmail: "E-mail de contact",
    expReqMarkets: "Marchés",
    expReqLanguages: "Langues",
    expReqObjectives: "Priorités",
    expReqTopic: "Au moins un sujet",
    expReqTopicsConfirmed: "Tous les sujets confirmés",
    expReqUser: "Au moins un utilisateur",
    expSecBusiness: "À propos de votre entreprise",
    expSecTeam: "Votre équipe",
    expSecTrack: "Ce que nous suivrons",
    expSecLook: "Où nous chercherons",
    expSecReports: "Rapports et alertes",
    expFldName: "Nom de l'entreprise",
    expFldEmail: "E-mail de contact",
    expFldIndustry: "Secteur",
    expFldMarkets: "Marchés géographiques",
    expFldLanguages: "Langues clés",
    expFldObjectives: "Priorités",
    expFldObjDetails: "Détails des priorités",
    expFldUseCases: "Objectif",
    expFldTimezone: "Fuseau horaire préféré",
    expFldTeams: "Équipes / services",
    expFldContact: "Interlocuteur principal",
    expNoUsers: "Aucun utilisateur enregistré.",
    expUFirst: "Prénom",
    expULast: "Nom",
    expUEmail: "E-mail",
    expURole: "Rôle",
    expRemoveUser: "Supprimer l'utilisateur {name}",
    expAddUser: "+ Ajouter un utilisateur",
    expNoTopics: "Aucun sujet enregistré.",
    expUnconfirmedOne: "{n} sujet a été suggéré par l'assistant. Confirmez-le ou supprimez-le avant la transmission.",
    expUnconfirmedMany: "{n} sujets ont été suggérés par l'assistant. Confirmez-les ou supprimez-les avant la transmission.",
    expGuess: "Suggestion de l'assistant",
    expConfirmed: "Confirmé",
    expConfirm: "Confirmer",
    expDrop: "Supprimer",
    expRemoveTopic: "Supprimer le sujet {name}",
    expTopicName: "Nom du sujet",
    expKeywords: "Mots-clés…",
    expRationale: "Justification / commentaires…",
    expAddTopic: "+ Ajouter un sujet",
    expPasteLabel: "Vous avez déjà une liste ? Collez-la",
    expPasteTopicPh: "Un sujet par ligne. Ajoutez éventuellement des mots-clés et une note séparés par | (par ex. Nike | \"Nike\" OR @Nike | principal concurrent)",
    expNoChannels: "Aucun canal enregistré.",
    expChName: "Nom / identifiant",
    expChPlatform: "Plateforme",
    expChUrl: "URL",
    expChOwned: "Propre ou concurrent ?",
    expRemoveChannel: "Supprimer le canal {name}",
    expAddChannel: "+ Ajouter un canal",
    expPasteChannelPh: "Un canal par ligne : une URL, un nom, ou les deux (par ex. Nike https://twitter.com/nike)",
    expReportsHdr: "Rapports et tableaux de bord",
    expNoReports: "Aucun rapport enregistré.",
    expRepName: "Nom du rapport",
    expRepKind: "Type",
    expRepKindDashboard: "Tableau de bord",
    expRepKindReport: "Rapport",
    expObjective: "Objectif",
    expDetails: "Détails",
    expComments: "Commentaires",
    expRemoveReport: "Supprimer le rapport {name}",
    expAddReport: "+ Ajouter un rapport",
    expAlertsHdr: "Alertes",
    expNoAlerts: "Aucune alerte enregistrée.",
    expAlName: "Nom de l'alerte",
    expType: "Type",
    expRemoveAlert: "Supprimer l'alerte {name}",
    expAddAlert: "+ Ajouter une alerte",
    expSendFailed: "Nous n'avons pas pu envoyer votre brief à l'instant. Vérifiez votre connexion et appuyez de nouveau sur Envoyer.",
    expCancel: "Annuler",
    expDownload: "Télécharger une copie",
    expSending: "Envoi…",
    expSend: "Envoyer à mon équipe Lumen",
    expIncompleteTitle: "Votre brief n’est pas encore complet",
    expIncompleteBody: "Ce n’est pas grave. Vous pouvez envoyer ce que vous avez, et nous compléterons le reste ensemble lors de votre session de revue.",
    expSendAnyway: "Envoyer quand même",
    expKeepGoing: "Continuer",
    expImport: "Importer",
    editPrefill: "Correction, j'avais dit précédemment : « {quote} ». Ce que je voulais vraiment dire : ",
    editTitle: "Envoyer une correction sans supprimer de messages",
    editLabel: "Modifier",
    focusWidgetGroup: "Options interactives",
    focusRepliesGroup: "Réponses suggérées",
  },
  German: {
    welcomeTitle:       "Willkommen beim Lumen-Onboarding",
    welcomeTitleSeeded: "Willkommen, {name}!",
    welcomeSub:         "Wir fragen nach Ihren Zielen, Märkten und Ihrem Team und erstellen anschließend Ihr Lumen-Setup-Briefing.",
    welcomeSubSeeded:   "Wir besprechen Ihre Ziele, Märkte und Ihr Team und erstellen Ihr Setup-Briefing Schritt für Schritt.",
    step1Title: "Etwa 15 Minuten",
    step1Desc:  "Jederzeit pausieren: Öffnen Sie diesen Link auf demselben Gerät erneut und Sie machen dort weiter, wo Sie aufgehört haben.",
    step1DescNoSave: "Hinweis: Dieser Browser speichert Ihren Fortschritt nicht (Privatmodus?). Bitte schließen Sie die Sitzung möglichst in einem Durchgang ab.",
    welcomeBackTitle: "Willkommen zurück!",
    welcomeBackDesc:  "Sie haben eine laufende Onboarding-Sitzung.",
    savedPercent:     "{pct} % abgeschlossen",
    savedOnDevice:    "Ihre Antworten sind auf diesem Gerät gespeichert",
    savedAnyDevice:   "Ihre Antworten sind gespeichert. Öffnen Sie diesen Link auf einem beliebigen Gerät, um fortzufahren.",
    savedFullAny: "\u2713 Fortschritt gespeichert",
    step1DescAny: "Jederzeit pausieren. Öffnen Sie diesen Link auf einem beliebigen Gerät erneut und Sie machen dort weiter, wo Sie aufgehört haben.",
    resumeBtn:        "Sitzung fortsetzen",
    startOverBtn:     "Neu beginnen",
    eraseWarn:        "Wenn Sie neu beginnen, werden Ihre gespeicherten Antworten dauerhaft gelöscht. Das kann nicht rückgängig gemacht werden.",
    keepBtn:          "Fortschritt behalten",
    eraseBtn:         "Löschen und neu beginnen",
    step2Title: "Ein Gespräch, kein Formular",
    step2Desc:  "Wir behandeln Ihre Ziele, was Sie beobachten möchten, wo Ihr Publikum spricht, Berichte und Ihr Team.",
    step3Title: "Dann machen wir weiter",
    step3Desc:  "Ihr Setup-Briefing geht direkt an Ihr Lumen-Team. Ein Berater kontaktiert Sie, um Ihren Review-Termin zu vereinbaren.",
    disclaimer: "Sie chatten mit einem KI-Assistenten. Ihre Antworten gehen nur an Ihr Lumen-Onboarding-Team, und ein Berater prüft alles, bevor die Einrichtung beginnt.",
    startBtn:       "Starten",
    startBtnSeeded: "Einrichtung für {company} starten",
    thinking:       "Der Assistent denkt nach\u2026",
    chooseLang:     "Wählen Sie Ihre Sprache, um zu beginnen",
    preparedFor:    "Vorbereitet für {company}",
    think1:         "Ich lese Ihre Antwort…",
    think2:         "Ich aktualisiere Ihr Briefing…",
    think3:         "Ich bereite den nächsten Schritt vor…",
    docThink1:      "Ich lese Ihr Dokument…",
    docThink2:      "Ich extrahiere die relevanten Details…",
    docThink3:      "Das kann bei größeren Dateien etwas länger dauern…",
    privacyNote:    "Ihre Antworten werden nur mit Ihrem Lumen-Onboarding-Team geteilt.",
    panelTitle: "Bisher erfasst",
    panelEmpty: "Ihre Antworten erscheinen hier nach und nach.",
    panelPending: "noch {n} werden im Gespräch ergänzt.",
    panelStillTo: "Noch zu erfassen",
    gapToday: "Heute",
    seedErrTransient: "Wir konnten Ihre vorbereitete Einrichtung gerade nicht laden, daher beginnen wir unten neu. Ihre Angaben sind bei Ihrem Lumen-Kontakt weiterhin sicher, oder laden Sie die Seite neu, um es noch einmal zu versuchen.",
    seedErrExpired: "Dieser Link ist abgelaufen, daher beginnen wir unten neu. Alles erreicht weiterhin Ihr Lumen-Team, aber es kann Ihnen einen neuen Link senden, wenn Sie dort weitermachen möchten, wo Sie aufgehört haben.",
    gapYesterday: "Gestern",
    panelHide: "Ausblenden",
    panelFixAria: "{label} im Chat korrigieren",
    panelFixStarter: "Eigentlich sollte {label} sein: ",
    pnlSkipped: "Übersprungen",
    pnlCompany: "Unternehmen",
    pnlEmail: "E-Mail",
    pnlIndustry: "Branche",
    pnlGoal: "Ziel",
    pnlMarkets: "Märkte",
    pnlLanguages: "Sprachen",
    pnlObjectives: "Prioritäten",
    pnlTeams: "Teams",
    pnlTimezone: "Zeitzone",
    pnlTopics: "Themen",
    pnlChannels: "Kanäle",
    pnlReports: "Berichte",
    pnlAlerts: "Warnungen",
    pnlUsers: "Benutzer",
    retryFail: "Das hat nicht geklappt. Tippen Sie auf Erneut versuchen.",
    tryAgain: "Erneut versuchen",
    youChose: "Ihre Wahl:",
    initErrMsg: "Der Assistent ist nicht erreichbar. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut.",
    showEarlier: "{n} frühere Nachrichten anzeigen",
    secAbout: "Über Sie",
    secApproach: "Vorgehen",
    secTrack: "Was verfolgen",
    secLook: "Wo suchen",
    secReports: "Berichte",
    secTeam: "Ihr Team",
    stepN: "Schritt {n} von {total}",
    divDone: "{label} — fertig",
    divToGo: "noch {n}",
    hdrAssistant: "Onboarding-Assistent",
    hdrTagline: "Ihre Antworten gehen direkt an Ihr Lumen-Onboarding-Team",
    savedFull: "✓ Auf diesem Gerät gespeichert",
    savedShort: "✓ Gespeichert",
    phReply: "Antwort eingeben…",
    phAnswerAbove: "Oben antworten — oder hier eintippen",
    reviewBtn: "Früher fertig oder festgefahren? Briefing prüfen und senden",
    sendNowBtn: "Vorhandene Angaben prüfen und senden",
    sendHint: "↵ zum Senden · Umschalt+↵ für neue Zeile",
    expTitle: "Ihr Setup-Briefing",
    expSubtitle: "Alles, was Sie geteilt haben, an einem Ort. Öffnen Sie einen Abschnitt, um etwas anzupassen.",
    expClose: "Überprüfung schließen",
    expReady: "Bereit zum Senden",
    expAlmost: "Fast geschafft",
    expReadyDesc: "Alle Pflichtfelder ausgefüllt und alle Themen bestätigt.",
    expStillNeeded: "Noch erforderlich: {gaps}",
    expFooterReady: "✓ Bereit zum Senden",
    expMore: "+{n} weitere",
    expRequired: "Erforderlich",
    expOptional: "Optional",
    expTopic: "Thema", expTopics: "Themen",
    expChannel: "Kanal", expChannels: "Kanäle",
    expReport: "Bericht", expReports: "Berichte",
    expUser: "Benutzer", expUsers: "Benutzer",
    expReqCompany: "Firmenname",
    expReqEmail: "Kontakt-E-Mail",
    expReqMarkets: "Märkte",
    expReqLanguages: "Sprachen",
    expReqObjectives: "Prioritäten",
    expReqTopic: "Mindestens ein Thema",
    expReqTopicsConfirmed: "Alle Themen bestätigt",
    expReqUser: "Mindestens ein Benutzer",
    expSecBusiness: "Über Ihr Unternehmen",
    expSecTeam: "Ihr Team",
    expSecTrack: "Was wir verfolgen",
    expSecLook: "Wo wir suchen",
    expSecReports: "Berichte und Benachrichtigungen",
    expFldName: "Firmenname",
    expFldEmail: "Kontakt-E-Mail",
    expFldIndustry: "Branche",
    expFldMarkets: "Geografische Märkte",
    expFldLanguages: "Wichtige Sprachen",
    expFldObjectives: "Prioritäten",
    expFldObjDetails: "Details zu den Prioritäten",
    expFldUseCases: "Ziel",
    expFldTimezone: "Bevorzugte Zeitzone",
    expFldTeams: "Teams / Abteilungen",
    expFldContact: "Wichtigster Ansprechpartner",
    expNoUsers: "Keine Benutzer erfasst.",
    expUFirst: "Vorname",
    expULast: "Nachname",
    expUEmail: "E-Mail",
    expURole: "Rolle",
    expRemoveUser: "Benutzer {name} entfernen",
    expAddUser: "+ Benutzer hinzufügen",
    expNoTopics: "Keine Themen erfasst.",
    expUnconfirmedOne: "{n} Thema wurde vom Assistenten vorgeschlagen. Bestätigen oder verwerfen Sie es vor der Übergabe.",
    expUnconfirmedMany: "{n} Themen wurden vom Assistenten vorgeschlagen. Bestätigen oder verwerfen Sie sie vor der Übergabe.",
    expGuess: "Vorschlag des Assistenten",
    expConfirmed: "Bestätigt",
    expConfirm: "Bestätigen",
    expDrop: "Verwerfen",
    expRemoveTopic: "Thema {name} entfernen",
    expTopicName: "Themenname",
    expKeywords: "Schlüsselwörter…",
    expRationale: "Begründung / Kommentare…",
    expAddTopic: "+ Thema hinzufügen",
    expPasteLabel: "Haben Sie bereits eine Liste? Fügen Sie sie ein",
    expPasteTopicPh: "Ein Thema pro Zeile. Optional Schlüsselwörter und eine Notiz mit | trennen (z. B. Nike | \"Nike\" OR @Nike | Hauptkonkurrent)",
    expNoChannels: "Keine Kanäle erfasst.",
    expChName: "Name / Handle",
    expChPlatform: "Plattform",
    expChUrl: "URL",
    expChOwned: "Eigener Kanal oder Konkurrent?",
    expRemoveChannel: "Kanal {name} entfernen",
    expAddChannel: "+ Kanal hinzufügen",
    expPasteChannelPh: "Ein Kanal pro Zeile: eine URL, ein Name oder beides (z. B. Nike https://twitter.com/nike)",
    expReportsHdr: "Berichte und Dashboards",
    expNoReports: "Keine Berichte erfasst.",
    expRepName: "Berichtsname",
    expRepKind: "Typ",
    expRepKindDashboard: "Dashboard",
    expRepKindReport: "Bericht",
    expObjective: "Ziel",
    expDetails: "Details",
    expComments: "Kommentare",
    expRemoveReport: "Bericht {name} entfernen",
    expAddReport: "+ Bericht hinzufügen",
    expAlertsHdr: "Benachrichtigungen",
    expNoAlerts: "Keine Benachrichtigungen erfasst.",
    expAlName: "Name der Benachrichtigung",
    expType: "Typ",
    expRemoveAlert: "Benachrichtigung {name} entfernen",
    expAddAlert: "+ Benachrichtigung hinzufügen",
    expSendFailed: "Wir konnten Ihr Briefing gerade nicht senden. Bitte prüfen Sie Ihre Verbindung und klicken Sie erneut auf Senden.",
    expCancel: "Abbrechen",
    expDownload: "Kopie herunterladen",
    expSending: "Wird gesendet…",
    expSend: "An mein Lumen-Team senden",
    expIncompleteTitle: "Ihr Briefing ist noch nicht vollständig",
    expIncompleteBody: "Das ist in Ordnung. Sie können das Vorhandene jetzt senden, und wir gehen den Rest gemeinsam in Ihrer Review-Sitzung durch.",
    expSendAnyway: "Trotzdem senden",
    expKeepGoing: "Weitermachen",
    expImport: "Importieren",
    editPrefill: "Korrektur, ich sagte zuvor: „{quote}“. Was ich eigentlich meinte: ",
    editTitle: "Eine Korrektur senden, ohne Nachrichten zu löschen",
    editLabel: "Bearbeiten",
    focusWidgetGroup: "Interaktive Optionen",
    focusRepliesGroup: "Vorgeschlagene Antworten",
  },
  Spanish: {
    welcomeTitle:       "Bienvenido al onboarding de Lumen",
    welcomeTitleSeeded: "¡Bienvenido, {name}!",
    welcomeSub:         "Le preguntaremos por sus objetivos, mercados y equipo, y luego generaremos su resumen de configuración de Lumen.",
    welcomeSubSeeded:   "Hablaremos de sus objetivos, mercados y equipo, y crearemos su resumen de configuración sobre la marcha.",
    step1Title: "Unos 15 minutos",
    step1Desc:  "Haga una pausa cuando quiera: vuelva a abrir este enlace en el mismo dispositivo y continuará donde lo dejó.",
    step1DescNoSave: "Aviso: este navegador no está guardando su progreso (¿modo privado?). Intente completarlo de una sola vez.",
    welcomeBackTitle: "¡Bienvenido de nuevo!",
    welcomeBackDesc:  "Tiene una sesión de onboarding en curso.",
    savedPercent:     "{pct} % completado",
    savedOnDevice:    "Sus respuestas están guardadas en este dispositivo",
    savedAnyDevice:   "Sus respuestas están guardadas. Vuelva a abrir este enlace en cualquier dispositivo para continuar.",
    savedFullAny: "\u2713 Progreso guardado",
    step1DescAny: "Pause cuando quiera. Vuelva a abrir este enlace en cualquier dispositivo y continuará donde lo dejó.",
    resumeBtn:        "Reanudar la sesión",
    startOverBtn:     "Empezar de nuevo",
    eraseWarn:        "Empezar de nuevo borra permanentemente sus respuestas guardadas. Esta acción no se puede deshacer.",
    keepBtn:          "Conservar mi progreso",
    eraseBtn:         "Borrar y empezar de nuevo",
    step2Title: "Una conversación, no un formulario",
    step2Desc:  "Cubriremos sus objetivos, qué monitorizar, dónde habla su audiencia, los informes y su equipo.",
    step3Title: "Después seguimos nosotros",
    step3Desc:  "Su resumen de configuración va directamente a su equipo de Lumen. Un consultor le contactará para agendar su llamada de revisión.",
    disclaimer: "Está chateando con un asistente de IA. Sus respuestas solo se envían a su equipo de onboarding de Lumen, y un consultor lo revisa todo antes de iniciar la configuración.",
    startBtn:       "Comenzar",
    startBtnSeeded: "Comenzar la configuración de {company}",
    thinking:       "El asistente está pensando\u2026",
    chooseLang:     "Elija su idioma para comenzar",
    preparedFor:    "Preparado para {company}",
    think1:         "Leyendo su respuesta…",
    think2:         "Actualizando su resumen…",
    think3:         "Preparando el siguiente paso…",
    docThink1:      "Leyendo su documento…",
    docThink2:      "Extrayendo los detalles útiles…",
    docThink3:      "Esto puede tardar un poco más con archivos grandes…",
    privacyNote:    "Sus respuestas solo se comparten con su equipo de onboarding de Lumen.",
    panelTitle: "Capturado hasta ahora",
    panelEmpty: "Sus respuestas aparecerán aquí a medida que avancemos.",
    panelPending: "quedan {n} por completar sobre la marcha.",
    panelStillTo: "Pendiente de registrar",
    gapToday: "Hoy",
    seedErrTransient: "No hemos podido cargar su configuración preparada en este momento, así que empezaremos de nuevo abajo. Sus datos siguen a salvo con su contacto de Lumen, o actualice la página para volver a intentarlo.",
    seedErrExpired: "Este enlace ha caducado, así que empezaremos de nuevo abajo. Todo sigue llegando a su equipo de Lumen, pero pueden enviarle un enlace nuevo si prefiere continuar donde lo dejó.",
    gapYesterday: "Ayer",
    panelHide: "Ocultar",
    panelFixAria: "Corregir {label} en el chat",
    panelFixStarter: "En realidad, {label} debería ser ",
    pnlSkipped: "Omitido",
    pnlCompany: "Empresa",
    pnlEmail: "Correo",
    pnlIndustry: "Sector",
    pnlGoal: "Objetivo",
    pnlMarkets: "Mercados",
    pnlLanguages: "Idiomas",
    pnlObjectives: "Prioridades",
    pnlTeams: "Equipos",
    pnlTimezone: "Zona horaria",
    pnlTopics: "Temas",
    pnlChannels: "Canales",
    pnlReports: "Informes",
    pnlAlerts: "Alertas",
    pnlUsers: "Usuarios",
    retryFail: "No se pudo enviar. Toque Reintentar para reenviar.",
    tryAgain: "Reintentar",
    youChose: "Su elección:",
    initErrMsg: "No pudimos conectar con el asistente. Compruebe su conexión e inténtelo de nuevo.",
    showEarlier: "Mostrar {n} mensajes anteriores",
    secAbout: "Sobre usted",
    secApproach: "Enfoque",
    secTrack: "Qué monitorizar",
    secLook: "Dónde buscar",
    secReports: "Informes",
    secTeam: "Su equipo",
    stepN: "Paso {n} de {total}",
    divDone: "{label} — listo",
    divToGo: "quedan {n}",
    hdrAssistant: "Asistente de onboarding",
    hdrTagline: "Sus respuestas se envían directamente a su equipo de onboarding de Lumen",
    savedFull: "✓ Guardado en este dispositivo",
    savedShort: "✓ Guardado",
    phReply: "Escriba su respuesta…",
    phAnswerAbove: "Responda arriba — o escríbalo aquí",
    reviewBtn: "¿Terminó antes o está atascado? Revise y envíe su resumen",
    sendNowBtn: "Revisar y enviar lo que tiene",
    sendHint: "↵ para enviar · Mayús+↵ para nueva línea",
    expTitle: "Su resumen de configuración",
    expSubtitle: "Todo lo que ha compartido, en un solo lugar. Abra una sección para ajustar lo que quiera.",
    expClose: "Cerrar revisión",
    expReady: "Listo para enviar",
    expAlmost: "Casi listo",
    expReadyDesc: "Todos los campos obligatorios están completos y todos los temas confirmados.",
    expStillNeeded: "Aún falta: {gaps}",
    expFooterReady: "✓ Listo para enviar",
    expMore: "+{n} más",
    expRequired: "Obligatorio",
    expOptional: "Opcional",
    expTopic: "tema", expTopics: "temas",
    expChannel: "canal", expChannels: "canales",
    expReport: "informe", expReports: "informes",
    expUser: "usuario", expUsers: "usuarios",
    expReqCompany: "Nombre de la empresa",
    expReqEmail: "Correo de contacto",
    expReqMarkets: "Mercados",
    expReqLanguages: "Idiomas",
    expReqObjectives: "Prioridades",
    expReqTopic: "Al menos un tema",
    expReqTopicsConfirmed: "Todos los temas confirmados",
    expReqUser: "Al menos un usuario",
    expSecBusiness: "Sobre su empresa",
    expSecTeam: "Su equipo",
    expSecTrack: "Qué monitorizaremos",
    expSecLook: "Dónde buscaremos",
    expSecReports: "Informes y alertas",
    expFldName: "Nombre de la empresa",
    expFldEmail: "Correo de contacto",
    expFldIndustry: "Sector",
    expFldMarkets: "Mercados geográficos",
    expFldLanguages: "Idiomas clave",
    expFldObjectives: "Prioridades",
    expFldObjDetails: "Detalles de las prioridades",
    expFldUseCases: "Objetivo",
    expFldTimezone: "Zona horaria preferida",
    expFldTeams: "Equipos / departamentos",
    expFldContact: "Contacto principal",
    expNoUsers: "No se han registrado usuarios.",
    expUFirst: "Nombre",
    expULast: "Apellidos",
    expUEmail: "Correo electrónico",
    expURole: "Rol",
    expRemoveUser: "Eliminar al usuario {name}",
    expAddUser: "+ Añadir usuario",
    expNoTopics: "No se han registrado temas.",
    expUnconfirmedOne: "El asistente sugirió {n} tema. Confírmelo o descártelo antes de la entrega.",
    expUnconfirmedMany: "El asistente sugirió {n} temas. Confírmelos o descártelos antes de la entrega.",
    expGuess: "Sugerencia del asistente",
    expConfirmed: "Confirmado",
    expConfirm: "Confirmar",
    expDrop: "Descartar",
    expRemoveTopic: "Eliminar el tema {name}",
    expTopicName: "Nombre del tema",
    expKeywords: "Palabras clave…",
    expRationale: "Justificación / comentarios…",
    expAddTopic: "+ Añadir tema",
    expPasteLabel: "¿Ya tiene una lista? Péguela",
    expPasteTopicPh: "Un tema por línea. Opcionalmente añada palabras clave y una nota separadas por | (p. ej. Nike | \"Nike\" OR @Nike | competidor principal)",
    expNoChannels: "No se han registrado canales.",
    expChName: "Nombre / usuario",
    expChPlatform: "Plataforma",
    expChUrl: "URL",
    expChOwned: "¿Propio o competidor?",
    expRemoveChannel: "Eliminar el canal {name}",
    expAddChannel: "+ Añadir canal",
    expPasteChannelPh: "Un canal por línea: una URL, un nombre, o ambos (p. ej. Nike https://twitter.com/nike)",
    expReportsHdr: "Informes y paneles",
    expNoReports: "No se han registrado informes.",
    expRepName: "Nombre del informe",
    expRepKind: "Tipo",
    expRepKindDashboard: "Panel",
    expRepKindReport: "Informe",
    expObjective: "Objetivo",
    expDetails: "Detalles",
    expComments: "Comentarios",
    expRemoveReport: "Eliminar el informe {name}",
    expAddReport: "+ Añadir informe",
    expAlertsHdr: "Alertas",
    expNoAlerts: "No se han registrado alertas.",
    expAlName: "Nombre de la alerta",
    expType: "Tipo",
    expRemoveAlert: "Eliminar la alerta {name}",
    expAddAlert: "+ Añadir alerta",
    expSendFailed: "No pudimos enviar su resumen en este momento. Compruebe su conexión y pulse Enviar de nuevo.",
    expCancel: "Cancelar",
    expDownload: "Descargar una copia",
    expSending: "Enviando…",
    expSend: "Enviar a mi equipo de Lumen",
    expIncompleteTitle: "Su resumen aún no está completo",
    expIncompleteBody: "No pasa nada. Puede enviar lo que tiene ahora y completaremos el resto juntos en su sesión de revisión.",
    expSendAnyway: "Enviar de todos modos",
    expKeepGoing: "Seguir",
    expImport: "Importar",
    editPrefill: "Corrección, antes dije: «{quote}». Lo que realmente quería decir: ",
    editTitle: "Enviar una corrección sin eliminar ningún mensaje",
    editLabel: "Editar",
    focusWidgetGroup: "Opciones interactivas",
    focusRepliesGroup: "Respuestas sugeridas",
  },
  Italian: {
    welcomeTitle:       "Benvenuto nell'onboarding di Lumen",
    welcomeTitleSeeded: "Benvenuto, {name}!",
    welcomeSub:         "Ti chiederemo i tuoi obiettivi, i mercati e il team, poi genereremo il tuo brief di configurazione Lumen.",
    welcomeSubSeeded:   "Parleremo dei tuoi obiettivi, dei mercati e del team, e costruiremo il tuo brief di configurazione strada facendo.",
    step1Title: "Circa 15 minuti",
    step1Desc:  "Metti in pausa quando vuoi: riapri questo link sullo stesso dispositivo e riprenderai da dove avevi lasciato.",
    step1DescNoSave: "Nota: questo browser non sta salvando i tuoi progressi (modalità privata?). Cerca di completare la sessione in una volta sola.",
    welcomeBackTitle: "Bentornato!",
    welcomeBackDesc:  "Hai una sessione di onboarding in corso.",
    savedPercent:     "{pct} % completato",
    savedOnDevice:    "Le tue risposte sono salvate su questo dispositivo",
    savedAnyDevice:   "Le tue risposte sono salvate. Riapri questo link su qualsiasi dispositivo per continuare.",
    savedFullAny: "\u2713 Progressi salvati",
    step1DescAny: "Fai una pausa quando vuoi. Riapri questo link su qualsiasi dispositivo e riprenderai da dove avevi lasciato.",
    resumeBtn:        "Riprendi la sessione",
    startOverBtn:     "Ricomincia",
    eraseWarn:        "Ricominciando, le tue risposte salvate verranno eliminate definitivamente. L'operazione non può essere annullata.",
    keepBtn:          "Mantieni i miei progressi",
    eraseBtn:         "Elimina e ricomincia",
    step2Title: "Una conversazione, non un modulo",
    step2Desc:  "Copriremo i tuoi obiettivi, cosa monitorare, dove parla il tuo pubblico, i report e il tuo team.",
    step3Title: "Poi continuiamo noi",
    step3Desc:  "Il tuo brief di configurazione va direttamente al tuo team Lumen. Un consulente ti contatterà per fissare la tua call di revisione.",
    disclaimer: "Stai chattando con un assistente IA. Le tue risposte vanno solo al tuo team di onboarding Lumen, e un consulente verifica tutto prima di iniziare la configurazione.",
    startBtn:       "Inizia",
    startBtnSeeded: "Avvia la configurazione di {company}",
    thinking:       "L'assistente sta pensando\u2026",
    chooseLang:     "Scegli la tua lingua per iniziare",
    preparedFor:    "Preparato per {company}",
    think1:         "Sto leggendo la tua risposta…",
    think2:         "Sto aggiornando il tuo brief…",
    think3:         "Sto preparando il passo successivo…",
    docThink1:      "Sto leggendo il tuo documento…",
    docThink2:      "Sto estraendo i dettagli utili…",
    docThink3:      "Per i file più grandi può volerci un po' più di tempo…",
    privacyNote:    "Le tue risposte sono condivise solo con il tuo team di onboarding Lumen.",
    panelTitle: "Raccolto finora",
    panelEmpty: "Le tue risposte appariranno qui man mano.",
    panelPending: "ancora {n} da completare durante la chat.",
    panelStillTo: "Ancora da raccogliere",
    gapToday: "Oggi",
    seedErrTransient: "Non abbiamo potuto caricare la tua configurazione preparata in questo momento, quindi ricominciamo qui sotto. I tuoi dati sono al sicuro presso il tuo contatto Lumen, oppure aggiorna la pagina per riprovare.",
    seedErrExpired: "Questo link è scaduto, quindi ricominciamo qui sotto. Tutto arriva comunque al tuo team Lumen, ma può inviarti un nuovo link se preferisci riprendere da dove avevi lasciato.",
    gapYesterday: "Ieri",
    panelHide: "Nascondi",
    panelFixAria: "Correggi {label} nella chat",
    panelFixStarter: "In realtà, {label} dovrebbe essere ",
    pnlSkipped: "Saltato",
    pnlCompany: "Azienda",
    pnlEmail: "E-mail",
    pnlIndustry: "Settore",
    pnlGoal: "Obiettivo",
    pnlMarkets: "Mercati",
    pnlLanguages: "Lingue",
    pnlObjectives: "Priorità",
    pnlTeams: "Team",
    pnlTimezone: "Fuso orario",
    pnlTopics: "Argomenti",
    pnlChannels: "Canali",
    pnlReports: "Report",
    pnlAlerts: "Avvisi",
    pnlUsers: "Utenti",
    retryFail: "Non è andato a buon fine. Tocca Riprova per inviare di nuovo.",
    tryAgain: "Riprova",
    youChose: "La tua scelta:",
    initErrMsg: "Impossibile raggiungere l'assistente. Controlla la connessione e riprova.",
    showEarlier: "Mostra i {n} messaggi precedenti",
    secAbout: "Su di te",
    secApproach: "Approccio",
    secTrack: "Cosa monitorare",
    secLook: "Dove cercare",
    secReports: "Report",
    secTeam: "Il tuo team",
    stepN: "Passo {n} di {total}",
    divDone: "{label} — completato",
    divToGo: "ancora {n}",
    hdrAssistant: "Assistente di onboarding",
    hdrTagline: "Le tue risposte vanno direttamente al tuo team di onboarding Lumen",
    savedFull: "✓ Salvato su questo dispositivo",
    savedShort: "✓ Salvato",
    phReply: "Scrivi la tua risposta…",
    phAnswerAbove: "Rispondi sopra — o scrivilo qui",
    reviewBtn: "Finito prima o bloccato? Rivedi e invia il tuo brief",
    sendNowBtn: "Rivedi e invia quello che hai",
    sendHint: "↵ per inviare · Maiusc+↵ per andare a capo",
    expTitle: "Il tuo brief di configurazione",
    expSubtitle: "Tutto ciò che hai condiviso, in un unico posto. Apri una sezione per modificare qualcosa.",
    expClose: "Chiudi revisione",
    expReady: "Pronto per l'invio",
    expAlmost: "Ci siamo quasi",
    expReadyDesc: "Tutti i campi obbligatori sono compilati e tutti gli argomenti confermati.",
    expStillNeeded: "Ancora necessario: {gaps}",
    expFooterReady: "✓ Pronto per l'invio",
    expMore: "+{n} altri",
    expRequired: "Obbligatorio",
    expOptional: "Facoltativo",
    expTopic: "argomento", expTopics: "argomenti",
    expChannel: "canale", expChannels: "canali",
    expReport: "report", expReports: "report",
    expUser: "utente", expUsers: "utenti",
    expReqCompany: "Nome dell'azienda",
    expReqEmail: "E-mail di contatto",
    expReqMarkets: "Mercati",
    expReqLanguages: "Lingue",
    expReqObjectives: "Priorità",
    expReqTopic: "Almeno un argomento",
    expReqTopicsConfirmed: "Tutti gli argomenti confermati",
    expReqUser: "Almeno un utente",
    expSecBusiness: "La tua azienda",
    expSecTeam: "Il tuo team",
    expSecTrack: "Cosa monitoreremo",
    expSecLook: "Dove cercheremo",
    expSecReports: "Report e avvisi",
    expFldName: "Nome dell'azienda",
    expFldEmail: "E-mail di contatto",
    expFldIndustry: "Settore",
    expFldMarkets: "Mercati geografici",
    expFldLanguages: "Lingue principali",
    expFldObjectives: "Priorità",
    expFldObjDetails: "Dettagli sulle priorità",
    expFldUseCases: "Obiettivo",
    expFldTimezone: "Fuso orario preferito",
    expFldTeams: "Team / reparti",
    expFldContact: "Referente principale",
    expNoUsers: "Nessun utente registrato.",
    expUFirst: "Nome",
    expULast: "Cognome",
    expUEmail: "E-mail",
    expURole: "Ruolo",
    expRemoveUser: "Rimuovi l'utente {name}",
    expAddUser: "+ Aggiungi utente",
    expNoTopics: "Nessun argomento registrato.",
    expUnconfirmedOne: "L'assistente ha suggerito {n} argomento. Confermalo o scartalo prima della consegna.",
    expUnconfirmedMany: "L'assistente ha suggerito {n} argomenti. Confermali o scartali prima della consegna.",
    expGuess: "Suggerimento dell'assistente",
    expConfirmed: "Confermato",
    expConfirm: "Conferma",
    expDrop: "Scarta",
    expRemoveTopic: "Rimuovi l'argomento {name}",
    expTopicName: "Nome dell'argomento",
    expKeywords: "Parole chiave…",
    expRationale: "Motivazione / commenti…",
    expAddTopic: "+ Aggiungi argomento",
    expPasteLabel: "Hai già un elenco? Incollalo",
    expPasteTopicPh: "Un argomento per riga. Facoltativamente aggiungi parole chiave e una nota separate da | (per es. Nike | \"Nike\" OR @Nike | concorrente principale)",
    expNoChannels: "Nessun canale registrato.",
    expChName: "Nome / handle",
    expChPlatform: "Piattaforma",
    expChUrl: "URL",
    expChOwned: "Proprio o concorrente?",
    expRemoveChannel: "Rimuovi il canale {name}",
    expAddChannel: "+ Aggiungi canale",
    expPasteChannelPh: "Un canale per riga: un URL, un nome, o entrambi (per es. Nike https://twitter.com/nike)",
    expReportsHdr: "Report e dashboard",
    expNoReports: "Nessun report registrato.",
    expRepName: "Nome del report",
    expRepKind: "Tipo",
    expRepKindDashboard: "Dashboard",
    expRepKindReport: "Report",
    expObjective: "Obiettivo",
    expDetails: "Dettagli",
    expComments: "Commenti",
    expRemoveReport: "Rimuovi il report {name}",
    expAddReport: "+ Aggiungi report",
    expAlertsHdr: "Avvisi",
    expNoAlerts: "Nessun avviso registrato.",
    expAlName: "Nome dell'avviso",
    expType: "Tipo",
    expRemoveAlert: "Rimuovi l'avviso {name}",
    expAddAlert: "+ Aggiungi avviso",
    expSendFailed: "Non siamo riusciti a inviare il tuo brief in questo momento. Controlla la connessione e premi di nuovo Invia.",
    expCancel: "Annulla",
    expDownload: "Scarica una copia",
    expSending: "Invio in corso…",
    expSend: "Invia al mio team Lumen",
    expIncompleteTitle: "Il tuo brief non è ancora completo",
    expIncompleteBody: "Va bene così. Puoi inviare quello che hai ora e completeremo il resto insieme durante la sessione di revisione.",
    expSendAnyway: "Invia comunque",
    expKeepGoing: "Continua",
    expImport: "Importa",
    editPrefill: "Correzione, prima avevo detto: «{quote}». Ciò che intendevo davvero: ",
    editTitle: "Invia una correzione senza eliminare alcun messaggio",
    editLabel: "Modifica",
    focusWidgetGroup: "Opzioni interattive",
    focusRepliesGroup: "Risposte suggerite",
  },
  Arabic: {
    welcomeTitle:       "مرحبًا بك في إعداد Lumen",
    welcomeTitleSeeded: "مرحبًا، {name}!",
    welcomeSub:         "سنسألك عن أهدافك وأسواقك وفريقك، ثم ننشئ ملخص إعداد Lumen الخاص بك.",
    welcomeSubSeeded:   "سنتحدث عن أهدافك وأسواقك وفريقك، وننشئ ملخص الإعداد الخاص بك خطوة بخطوة.",
    step1Title: "حوالي 15 دقيقة",
    step1Desc:  "توقف مؤقتًا متى شئت: أعد فتح هذا الرابط على الجهاز نفسه وستتابع من حيث توقفت.",
    step1DescNoSave: "تنبيه: هذا المتصفح لا يحفظ تقدمك (هل أنت في وضع التصفح الخاص؟)، لذا حاول إكمال الجلسة دفعة واحدة.",
    welcomeBackTitle: "أهلًا بعودتك!",
    welcomeBackDesc:  "لديك جلسة إعداد قيد التقدم.",
    savedPercent:     "اكتمل {pct}%",
    savedOnDevice:    "إجاباتك محفوظة على هذا الجهاز",
    savedAnyDevice:   "إجاباتك محفوظة. أعد فتح هذا الرابط على أي جهاز للمتابعة.",
    savedFullAny: "\u2713 تم حفظ التقدّم",
    step1DescAny: "توقّف وقتما تشاء. أعد فتح هذا الرابط على أي جهاز وستتابع من حيث توقفت.",
    resumeBtn:        "استئناف الجلسة",
    startOverBtn:     "البدء من جديد",
    eraseWarn:        "البدء من جديد يحذف إجاباتك المحفوظة نهائيًا. لا يمكن التراجع عن هذا الإجراء.",
    keepBtn:          "الاحتفاظ بتقدمي",
    eraseBtn:         "حذف والبدء من جديد",
    step2Title: "محادثة، وليست نموذجًا",
    step2Desc:  "سنغطي أهدافك، وما الذي تريد متابعته، وأين يتحدث جمهورك، والتقارير، وفريقك.",
    step3Title: "ثم نُكمل نحن من هناك",
    step3Desc:  "يُرسل ملخص الإعداد الخاص بك مباشرةً إلى فريق Lumen. سيتواصل معك أحد الاستشاريين لتحديد موعد مكالمة المراجعة.",
    disclaimer: "أنت تتحدث مع مساعد ذكاء اصطناعي. تُرسَل إجاباتك إلى فريق إعداد Lumen الخاص بك فقط، ويراجع أحد الاستشاريين كل شيء قبل بدء الإعداد.",
    startBtn:       "ابدأ",
    startBtnSeeded: "ابدأ إعداد {company}",
    thinking:       "المساعد يفكّر\u2026",
    chooseLang:     "اختر لغتك للبدء",
    preparedFor:    "أُعدّ لأجل {company}",
    think1:         "أقرأ إجابتك…",
    think2:         "أُحدّث ملخص الإعداد…",
    think3:         "أُجهّز الخطوة التالية…",
    docThink1:      "أقرأ مستندك…",
    docThink2:      "أستخرج التفاصيل المفيدة…",
    docThink3:      "قد يستغرق هذا وقتًا أطول قليلاً مع الملفات الكبيرة…",
    privacyNote:    "لا تتم مشاركة إجاباتك إلا مع فريق إعداد Lumen الخاص بك.",
    panelTitle: "ما تم جمعه حتى الآن",
    panelEmpty: "ستظهر إجاباتك هنا أثناء تقدمنا.",
    panelPending: "متبقٍ {n} سيُكمَل أثناء المحادثة.",
    panelStillTo: "ما زال يجب تسجيله",
    gapToday: "اليوم",
    seedErrTransient: "لم نتمكّن من تحميل الإعداد المُهيّأ لك الآن، لذا سنبدأ من جديد أدناه. بياناتك لا تزال آمنة مع جهة اتصالك في Lumen، أو حدّث الصفحة للمحاولة مرة أخرى.",
    seedErrExpired: "انتهت صلاحية هذا الرابط، لذا سنبدأ من جديد أدناه. كل شيء يصل إلى فريق Lumen الخاص بك، ويمكنهم إرسال رابط جديد إذا كنت تفضّل المتابعة من حيث توقفت.",
    gapYesterday: "أمس",
    panelHide: "إخفاء",
    panelFixAria: "تصحيح {label} في المحادثة",
    panelFixStarter: "في الواقع، {label} يجب أن يكون ",
    pnlSkipped: "تم التخطي",
    pnlCompany: "الشركة",
    pnlEmail: "البريد الإلكتروني",
    pnlIndustry: "القطاع",
    pnlGoal: "الهدف",
    pnlMarkets: "الأسواق",
    pnlLanguages: "اللغات",
    pnlObjectives: "الأولويات",
    pnlTeams: "الفرق",
    pnlTimezone: "المنطقة الزمنية",
    pnlTopics: "المواضيع",
    pnlChannels: "القنوات",
    pnlReports: "التقارير",
    pnlAlerts: "التنبيهات",
    pnlUsers: "المستخدمون",
    retryFail: "لم يتم الإرسال. اضغط \"حاول مجددًا\" لإعادة الإرسال.",
    tryAgain: "حاول مجددًا",
    youChose: "اخترت:",
    initErrMsg: "تعذر الوصول إلى المساعد. تحقق من اتصالك وحاول مجددًا.",
    showEarlier: "عرض {n} من الرسائل السابقة",
    secAbout: "عنك",
    secApproach: "النهج",
    secTrack: "ما نراقبه",
    secLook: "أين نبحث",
    secReports: "التقارير",
    secTeam: "فريقك",
    stepN: "الخطوة {n} من {total}",
    divDone: "{label} — تم",
    divToGo: "متبقٍ {n}",
    hdrAssistant: "مساعد الإعداد",
    hdrTagline: "تُرسَل إجاباتك مباشرةً إلى فريق الإعداد لديك في Lumen",
    savedFull: "✓ محفوظ على هذا الجهاز",
    savedShort: "✓ محفوظ",
    phReply: "اكتب ردك…",
    phAnswerAbove: "أجب أعلاه — أو اكتبه هنا",
    reviewBtn: "انتهيت مبكرًا أو تواجه صعوبة؟ راجع وأرسل ملخصك",
    sendNowBtn: "راجع وأرسل ما لديك",
    sendHint: "↵ للإرسال · Shift+↵ لسطر جديد",
    expTitle: "ملخص الإعداد الخاص بك",
    expSubtitle: "كل ما شاركته في مكان واحد. افتح أي قسم لتعديل ما تشاء.",
    expClose: "إغلاق المراجعة",
    expReady: "جاهز للإرسال",
    expAlmost: "أوشكت على الانتهاء",
    expReadyDesc: "جميع الحقول المطلوبة مكتملة وجميع المواضيع مؤكَّدة.",
    expStillNeeded: "لا يزال مطلوبًا: {gaps}",
    expFooterReady: "✓ جاهز للإرسال",
    expMore: "+{n} أخرى",
    expRequired: "مطلوب",
    expOptional: "اختياري",
    expTopic: "موضوع", expTopics: "مواضيع",
    expChannel: "قناة", expChannels: "قنوات",
    expReport: "تقرير", expReports: "تقارير",
    expUser: "مستخدم", expUsers: "مستخدمون",
    expReqCompany: "اسم الشركة",
    expReqEmail: "بريد جهة الاتصال",
    expReqMarkets: "الأسواق",
    expReqLanguages: "اللغات",
    expReqObjectives: "الأولويات",
    expReqTopic: "موضوع واحد على الأقل",
    expReqTopicsConfirmed: "تأكيد جميع المواضيع",
    expReqUser: "مستخدم واحد على الأقل",
    expSecBusiness: "عن شركتك",
    expSecTeam: "فريقك",
    expSecTrack: "ما سنراقبه",
    expSecLook: "أين سنبحث",
    expSecReports: "التقارير والتنبيهات",
    expFldName: "اسم الشركة",
    expFldEmail: "بريد جهة الاتصال",
    expFldIndustry: "القطاع",
    expFldMarkets: "الأسواق الجغرافية",
    expFldLanguages: "اللغات الرئيسية",
    expFldObjectives: "الأولويات",
    expFldObjDetails: "تفاصيل الأولويات",
    expFldUseCases: "الهدف",
    expFldTimezone: "المنطقة الزمنية المفضّلة",
    expFldTeams: "الفرق / الأقسام",
    expFldContact: "جهة الاتصال الرئيسية",
    expNoUsers: "لم يُسجَّل أي مستخدم.",
    expUFirst: "الاسم الأول",
    expULast: "اسم العائلة",
    expUEmail: "البريد الإلكتروني",
    expURole: "الدور",
    expRemoveUser: "إزالة المستخدم {name}",
    expAddUser: "+ إضافة مستخدم",
    expNoTopics: "لم يُسجَّل أي موضوع.",
    expUnconfirmedOne: "اقترح المساعد موضوعًا واحدًا. أكِّده أو استبعده قبل التسليم.",
    expUnconfirmedMany: "اقترح المساعد {n} مواضيع. أكِّدها أو استبعدها قبل التسليم.",
    expGuess: "اقتراح المساعد",
    expConfirmed: "مؤكَّد",
    expConfirm: "تأكيد",
    expDrop: "استبعاد",
    expRemoveTopic: "إزالة الموضوع {name}",
    expTopicName: "اسم الموضوع",
    expKeywords: "الكلمات المفتاحية…",
    expRationale: "المبرر / التعليقات…",
    expAddTopic: "+ إضافة موضوع",
    expPasteLabel: "لديك قائمة جاهزة؟ الصقها",
    expPasteTopicPh: "موضوع واحد في كل سطر. يمكنك اختياريًا إضافة كلمات مفتاحية وملاحظة مفصولة بـ | (مثل Nike | \"Nike\" OR @Nike | المنافس الرئيسي)",
    expNoChannels: "لم تُسجَّل أي قناة.",
    expChName: "الاسم / المعرّف",
    expChPlatform: "المنصّة",
    expChUrl: "الرابط",
    expChOwned: "مملوكة أم منافِسة؟",
    expRemoveChannel: "إزالة القناة {name}",
    expAddChannel: "+ إضافة قناة",
    expPasteChannelPh: "قناة واحدة في كل سطر: رابط أو اسم أو كلاهما (مثل Nike https://twitter.com/nike)",
    expReportsHdr: "التقارير ولوحات المعلومات",
    expNoReports: "لم يُسجَّل أي تقرير.",
    expRepName: "اسم التقرير",
    expRepKind: "النوع",
    expRepKindDashboard: "لوحة معلومات",
    expRepKindReport: "تقرير",
    expObjective: "الهدف",
    expDetails: "التفاصيل",
    expComments: "التعليقات",
    expRemoveReport: "إزالة التقرير {name}",
    expAddReport: "+ إضافة تقرير",
    expAlertsHdr: "التنبيهات",
    expNoAlerts: "لم يُسجَّل أي تنبيه.",
    expAlName: "اسم التنبيه",
    expType: "النوع",
    expRemoveAlert: "إزالة التنبيه {name}",
    expAddAlert: "+ إضافة تنبيه",
    expSendFailed: "تعذّر إرسال ملخصك الآن. تحقّق من اتصالك واضغط إرسال مرة أخرى.",
    expCancel: "إلغاء",
    expDownload: "تنزيل نسخة",
    expSending: "جارٍ الإرسال…",
    expSend: "إرسال إلى فريق Lumen الخاص بي",
    expIncompleteTitle: "ملخصك غير مكتمل بعد",
    expIncompleteBody: "لا بأس بذلك. يمكنك إرسال ما لديك الآن، وسنكمل الباقي معًا في جلسة المراجعة.",
    expSendAnyway: "إرسال على أي حال",
    expKeepGoing: "المتابعة",
    expImport: "استيراد",
    editPrefill: "تصحيح، قلت سابقًا: «{quote}». ما قصدته فعلًا: ",
    editTitle: "إرسال تصحيح دون حذف أي رسائل",
    editLabel: "تعديل",
    focusWidgetGroup: "خيارات تفاعلية",
    focusRepliesGroup: "ردود مقترحة",
  },
};

function L(key, lang, vars) {
  const dict = I18N[lang] || I18N.English;
  let s = (dict[key] != null ? dict[key] : I18N.English[key]) || "";
  // Function replacement so $-sequences in the value ($$, $&, $`, $') are inserted
  // literally rather than interpreted as regex replacement patterns. Matters because
  // editPrefill feeds arbitrary user text (m.content) through {quote}.
  if (vars) for (const k in vars) s = s.replace(new RegExp("\\{" + k + "\\}", "g"), () => String(vars[k]));
  return s;
}

// Widget-chrome localization. Option VALUES (markets, objectives, teams,
// timezones) stay in English on purpose — they are Lumen's product taxonomy and
// are stored in English in the brief. Only the chrome (buttons, hints,
// placeholders, tooltips) follows the client's language, so a non-English chat
// no longer renders an all-English form.
const WI18N = {
  English: { "confirm":"Confirm", "skip":"Skip", "add":"+ Add", "customValue":"Type a custom value…", "somethingElse":"Something else? Type it here…", "max":"max", "selected":"selected", "limitReached":"limit reached", "prioritiesHdr":"Your priorities — #1 is where we start", "confirmPriorities":"Confirm priorities", "objDetailsPh":"Anything else about your priorities? (optional)", "firstName":"First name", "lastName":"Last name", "roleDept":"Role / dept", "email":"Email", "invalidEmail":"Invalid email", "addUser":"+ Add user", "confirmUsers":"Confirm users", "topicName":"Topic name", "keywordsPh":"Keywords…", "dragPrioritize":"Drag to prioritize", "kept":"kept", "discarded":"discarded", "pending":"pending", "submitQueries":"Submit queries", "noQueries":"No queries", "importFile":"Or import a file (.txt, .csv, .xlsx, .docx)", "pasteQueries":"Paste your existing queries here…", "hintSelectAll":"Select all that apply.", "hintTeams":"Select all teams that will use Lumen.", "hintObjectives":"Pick up to 3, then set their priority — your #1 decides what we build first.", "hintTimezone":"Select your primary timezone.", "phMarket":"Type a market…", "phLanguage":"Type a language…", "phTeam":"Type a team…", "whyMarkets":"So results are scoped to the regions you actually operate in.", "whyTeams":"Helps us tailor dashboards to the people who'll use them.", "whyUsers":"Who should have access — just you for now is fine.", "whyQueries":"If you already track queries elsewhere, we can migrate them.", "whyTopics":"Topics are the subjects Lumen will monitor for you.", "topicHint":"All suggested topics start as kept. Tap ✕ to drop any that don't fit.", "confirmUsersHint":"Each person needs at least a first name and a valid email.", "submittedLbl":"✓ Submitted", "skippedLbl":"✓ Skipped", "editBtn":"Edit", "moveUp":"Move up", "moveDown":"Move down", "removeItem":"Remove" },
  French: { "confirm":"Confirmer", "skip":"Passer", "add":"+ Ajouter", "customValue":"Saisir une valeur personnalisée…", "somethingElse":"Autre chose ? Saisissez-le ici…", "max":"max", "selected":"sélectionné(s)", "limitReached":"limite atteinte", "prioritiesHdr":"Vos priorités — le n°1 est notre point de départ", "confirmPriorities":"Confirmer les priorités", "objDetailsPh":"Autre chose au sujet de vos priorités ? (facultatif)", "firstName":"Prénom", "lastName":"Nom", "roleDept":"Rôle / service", "email":"E-mail", "invalidEmail":"E-mail invalide", "addUser":"+ Ajouter un utilisateur", "confirmUsers":"Confirmer les utilisateurs", "topicName":"Nom du sujet", "keywordsPh":"Mots-clés…", "dragPrioritize":"Glissez pour classer par priorité", "kept":"conservés", "discarded":"écartés", "pending":"en attente", "submitQueries":"Envoyer les requêtes", "noQueries":"Aucune requête", "importFile":"Ou importer un fichier (.txt, .csv, .xlsx, .docx)", "pasteQueries":"Collez vos requêtes existantes ici…", "hintSelectAll":"Sélectionnez toutes les options applicables.", "hintTeams":"Sélectionnez toutes les équipes qui utiliseront Lumen.", "hintObjectives":"Choisissez-en jusqu'à 3, puis définissez leur priorité : votre n°1 détermine ce que nous configurons en premier.", "hintTimezone":"Sélectionnez votre fuseau horaire principal.", "phMarket":"Saisir un marché…", "phLanguage":"Saisir une langue…", "phTeam":"Saisir une équipe…", "whyMarkets":"Pour que les résultats soient limités aux régions où vous opérez réellement.", "whyTeams":"Nous aide à adapter les tableaux de bord aux personnes qui les utiliseront.", "whyUsers":"Qui doit avoir accès — vous seul pour l'instant, c'est parfait.", "whyQueries":"Si vous suivez déjà des requêtes ailleurs, nous pouvons les migrer.", "whyTopics":"Les sujets sont les thèmes que Lumen surveillera pour vous.", "topicHint":"Tous les sujets suggérés sont conservés par défaut. Touchez ✕ pour écarter ceux qui ne conviennent pas.", "confirmUsersHint":"Chaque personne doit avoir au moins un prénom et un e-mail valide.", "submittedLbl":"✓ Envoyé", "skippedLbl":"✓ Passé", "editBtn":"Modifier", "moveUp":"Monter", "moveDown":"Descendre", "removeItem":"Retirer" },
  German: { "confirm":"Bestätigen", "skip":"Überspringen", "add":"+ Hinzufügen", "customValue":"Eigenen Wert eingeben…", "somethingElse":"Etwas anderes? Hier eingeben…", "max":"max.", "selected":"ausgewählt", "limitReached":"Limit erreicht", "prioritiesHdr":"Ihre Prioritäten — Nr. 1 ist unser Ausgangspunkt", "confirmPriorities":"Prioritäten bestätigen", "objDetailsPh":"Sonst noch etwas zu Ihren Prioritäten? (optional)", "firstName":"Vorname", "lastName":"Nachname", "roleDept":"Rolle / Abteilung", "email":"E-Mail", "invalidEmail":"Ungültige E-Mail", "addUser":"+ Benutzer hinzufügen", "confirmUsers":"Benutzer bestätigen", "topicName":"Themenname", "keywordsPh":"Schlüsselwörter…", "dragPrioritize":"Zum Priorisieren ziehen", "kept":"behalten", "discarded":"verworfen", "pending":"offen", "submitQueries":"Abfragen senden", "noQueries":"Keine Abfragen", "importFile":"Oder eine Datei importieren (.txt, .csv, .xlsx, .docx)", "pasteQueries":"Fügen Sie hier Ihre bestehenden Abfragen ein…", "hintSelectAll":"Wählen Sie alles Zutreffende aus.", "hintTeams":"Wählen Sie alle Teams aus, die Lumen nutzen werden.", "hintObjectives":"Wählen Sie bis zu 3 aus und legen Sie die Priorität fest — Ihre Nr. 1 bestimmt, was wir zuerst einrichten.", "hintTimezone":"Wählen Sie Ihre primäre Zeitzone.", "phMarket":"Markt eingeben…", "phLanguage":"Sprache eingeben…", "phTeam":"Team eingeben…", "whyMarkets":"Damit die Ergebnisse auf die Regionen beschränkt sind, in denen Sie tatsächlich tätig sind.", "whyTeams":"Hilft uns, die Dashboards auf die Personen zuzuschneiden, die sie nutzen.", "whyUsers":"Wer Zugriff haben soll — vorerst reicht es völlig, wenn nur Sie Zugriff haben.", "whyQueries":"Wenn Sie Abfragen bereits anderswo verfolgen, können wir sie migrieren.", "whyTopics":"Themen sind die Bereiche, die Lumen für Sie überwacht.", "topicHint":"Alle vorgeschlagenen Themen sind zunächst behalten. Tippen Sie auf ✕, um unpassende zu verwerfen.", "confirmUsersHint":"Jede Person braucht mindestens einen Vornamen und eine gültige E-Mail.", "submittedLbl":"✓ Übermittelt", "skippedLbl":"✓ Übersprungen", "editBtn":"Bearbeiten", "moveUp":"Nach oben", "moveDown":"Nach unten", "removeItem":"Entfernen" },
  Spanish: { "confirm":"Confirmar", "skip":"Omitir", "add":"+ Añadir", "customValue":"Escriba un valor personalizado…", "somethingElse":"¿Algo más? Escríbalo aquí…", "max":"máx.", "selected":"seleccionado(s)", "limitReached":"límite alcanzado", "prioritiesHdr":"Sus prioridades: el n.º 1 es donde empezamos", "confirmPriorities":"Confirmar prioridades", "objDetailsPh":"¿Algo más sobre sus prioridades? (opcional)", "firstName":"Nombre", "lastName":"Apellidos", "roleDept":"Rol / departamento", "email":"Correo electrónico", "invalidEmail":"Correo no válido", "addUser":"+ Añadir usuario", "confirmUsers":"Confirmar usuarios", "topicName":"Nombre del tema", "keywordsPh":"Palabras clave…", "dragPrioritize":"Arrastre para priorizar", "kept":"conservados", "discarded":"descartados", "pending":"pendientes", "submitQueries":"Enviar consultas", "noQueries":"Sin consultas", "importFile":"O importe un archivo (.txt, .csv, .xlsx, .docx)", "pasteQueries":"Pegue aquí sus consultas existentes…", "hintSelectAll":"Seleccione todo lo que corresponda.", "hintTeams":"Seleccione todos los equipos que usarán Lumen.", "hintObjectives":"Elija hasta 3 y ordene su prioridad: su n.º 1 decide qué configuramos primero.", "hintTimezone":"Seleccione su zona horaria principal.", "phMarket":"Escriba un mercado…", "phLanguage":"Escriba un idioma…", "phTeam":"Escriba un equipo…", "whyMarkets":"Para que los resultados se limiten a las regiones donde realmente opera.", "whyTeams":"Nos ayuda a adaptar los paneles a las personas que los usarán.", "whyUsers":"Quién debe tener acceso: por ahora, con usted basta.", "whyQueries":"Si ya sigue consultas en otro sitio, podemos migrarlas.", "whyTopics":"Los temas son los asuntos que Lumen monitorizará para usted.", "topicHint":"Todos los temas sugeridos empiezan como conservados. Toque ✕ para descartar los que no encajen.", "confirmUsersHint":"Cada persona necesita al menos un nombre y un correo válido.", "submittedLbl":"✓ Enviado", "skippedLbl":"✓ Omitido", "editBtn":"Editar", "moveUp":"Subir", "moveDown":"Bajar", "removeItem":"Quitar" },
  Italian: { "confirm":"Conferma", "skip":"Salta", "add":"+ Aggiungi", "customValue":"Inserisci un valore personalizzato…", "somethingElse":"Qualcos'altro? Scrivilo qui…", "max":"max", "selected":"selezionato/i", "limitReached":"limite raggiunto", "prioritiesHdr":"Le tue priorità — la n.1 è il punto di partenza", "confirmPriorities":"Conferma priorità", "objDetailsPh":"Altro sulle tue priorità? (facoltativo)", "firstName":"Nome", "lastName":"Cognome", "roleDept":"Ruolo / reparto", "email":"E-mail", "invalidEmail":"E-mail non valida", "addUser":"+ Aggiungi utente", "confirmUsers":"Conferma utenti", "topicName":"Nome dell'argomento", "keywordsPh":"Parole chiave…", "dragPrioritize":"Trascina per dare priorità", "kept":"mantenuti", "discarded":"scartati", "pending":"in sospeso", "submitQueries":"Invia query", "noQueries":"Nessuna query", "importFile":"Oppure importa un file (.txt, .csv, .xlsx, .docx)", "pasteQueries":"Incolla qui le tue query esistenti…", "hintSelectAll":"Seleziona tutte le opzioni pertinenti.", "hintTeams":"Seleziona tutti i team che useranno Lumen.", "hintObjectives":"Scegline fino a 3, poi imposta la priorità: la n.1 decide cosa configuriamo per primo.", "hintTimezone":"Seleziona il tuo fuso orario principale.", "phMarket":"Inserisci un mercato…", "phLanguage":"Inserisci una lingua…", "phTeam":"Inserisci un team…", "whyMarkets":"Così i risultati sono limitati alle aree in cui operi davvero.", "whyTeams":"Ci aiuta ad adattare le dashboard alle persone che le useranno.", "whyUsers":"Chi deve avere accesso — per ora solo tu va benissimo.", "whyQueries":"Se monitori già delle query altrove, possiamo migrarle.", "whyTopics":"Gli argomenti sono i temi che Lumen monitorerà per te.", "topicHint":"Tutti gli argomenti suggeriti partono come mantenuti. Tocca ✕ per scartare quelli che non servono.", "confirmUsersHint":"Ogni persona deve avere almeno un nome e un'e-mail valida.", "submittedLbl":"✓ Inviato", "skippedLbl":"✓ Saltato", "editBtn":"Modifica", "moveUp":"Sposta su", "moveDown":"Sposta giù", "removeItem":"Rimuovi" },
  Arabic: { "confirm":"تأكيد", "skip":"تخطّي", "add":"+ إضافة", "customValue":"أدخل قيمة مخصّصة…", "somethingElse":"شيء آخر؟ اكتبه هنا…", "max":"حد أقصى", "selected":"محدد", "limitReached":"تم بلوغ الحد", "prioritiesHdr":"أولوياتك — رقم 1 هو نقطة البداية", "confirmPriorities":"تأكيد الأولويات", "objDetailsPh":"أي شيء آخر بخصوص أولوياتك؟ (اختياري)", "firstName":"الاسم الأول", "lastName":"اسم العائلة", "roleDept":"الدور / القسم", "email":"البريد الإلكتروني", "invalidEmail":"بريد إلكتروني غير صالح", "addUser":"+ إضافة مستخدم", "confirmUsers":"تأكيد المستخدمين", "topicName":"اسم الموضوع", "keywordsPh":"الكلمات المفتاحية…", "dragPrioritize":"اسحب لترتيب الأولوية", "kept":"محتفظ بها", "discarded":"مستبعدة", "pending":"قيد الانتظار", "submitQueries":"إرسال الاستعلامات", "noQueries":"لا توجد استعلامات", "importFile":"أو استورد ملفًا (‎.txt، ‎.csv، ‎.xlsx، ‎.docx)", "pasteQueries":"الصق استعلاماتك الحالية هنا…", "hintSelectAll":"اختر كل ما ينطبق.", "hintTeams":"اختر جميع الفرق التي ستستخدم Lumen.", "hintObjectives":"اختر ما يصل إلى 3، ثم رتّب أولوياتها — رقم 1 يحدد ما نُعدّه أولًا.", "hintTimezone":"اختر منطقتك الزمنية الأساسية.", "phMarket":"أدخل سوقًا…", "phLanguage":"أدخل لغة…", "phTeam":"أدخل فريقًا…", "whyMarkets":"لكي تقتصر النتائج على المناطق التي تعمل فيها فعليًا.", "whyTeams":"يساعدنا على تخصيص لوحات المعلومات للأشخاص الذين سيستخدمونها.", "whyUsers":"من ينبغي أن يملك حق الوصول — الاكتفاء بك وحدك الآن أمر جيد.", "whyQueries":"إذا كنت تتابع استعلامات في مكان آخر، يمكننا نقلها.", "whyTopics":"المواضيع هي ما سيراقبه Lumen نيابةً عنك.", "topicHint":"جميع المواضيع المقترحة محتفظ بها افتراضيًا. اضغط ✕ لاستبعاد ما لا يناسبك.", "confirmUsersHint":"كل شخص يحتاج على الأقل إلى اسم أول وبريد إلكتروني صالح.", "submittedLbl":"✓ تم الإرسال", "skippedLbl":"✓ تم التخطي", "editBtn":"تعديل", "moveUp":"تحريك لأعلى", "moveDown":"تحريك لأسفل", "removeItem":"إزالة" },
};
function WL(key, lang) {
  const dict = WI18N[lang] || WI18N.English;
  return (dict[key] != null ? dict[key] : WI18N.English[key]) || "";
}

// QUERIES-widget file-import feedback (shown in the expert flow). Parametrized:
// {name} filename, {n} line cap, {mb} size. QN() substitutes and falls back to English.
const QN18N = {
  English: { "importedTruncated":"Imported the first {n} lines of {name}. Hit Submit and I'll pick out what's relevant — with a file this size, double-check the queries you care about most made it in.", "imported":"Imported {name}. Hit Submit and I'll pick out what's relevant — no need to tidy it up.", "noText":"Couldn't find any text in {name}.", "tooLarge":"That file is {mb} MB — too large to read here. Export just the queries (or paste them directly) and try again.", "unsupported":"That file type isn't supported — use .txt, .csv, .xlsx or .docx, or paste the queries directly.", "readError":"Couldn't read that file — try pasting the queries directly instead.", "docxUnavailable":"This browser can't read .docx files here. Open the document, copy the text, and paste it in — or save it as .txt." },
  French: { "importedTruncated":"Les {n} premières lignes de {name} ont été importées. Cliquez sur Envoyer et je repérerai ce qui est pertinent — avec un fichier de cette taille, vérifiez que les requêtes les plus importantes y figurent.", "imported":"{name} importé. Cliquez sur Envoyer et je repérerai ce qui est pertinent — inutile de faire le tri.", "noText":"Aucun texte trouvé dans {name}.", "tooLarge":"Ce fichier fait {mb} Mo — trop volumineux pour être lu ici. Exportez uniquement les requêtes (ou collez-les directement) et réessayez.", "unsupported":"Ce type de fichier n'est pas pris en charge — utilisez .txt, .csv, .xlsx ou .docx, ou collez les requêtes directement.", "readError":"Impossible de lire ce fichier — essayez plutôt de coller les requêtes directement.", "docxUnavailable":"Ce navigateur ne peut pas lire les fichiers .docx ici. Ouvrez le document, copiez le texte et collez-le — ou enregistrez-le en .txt." },
  German: { "importedTruncated":"Die ersten {n} Zeilen von {name} wurden importiert. Klicken Sie auf Senden und ich filtere das Relevante heraus — prüfen Sie bei einer Datei dieser Größe, ob die wichtigsten Abfragen enthalten sind.", "imported":"{name} importiert. Klicken Sie auf Senden und ich filtere das Relevante heraus — Aufräumen ist nicht nötig.", "noText":"In {name} wurde kein Text gefunden.", "tooLarge":"Diese Datei ist {mb} MB groß — zu groß, um sie hier zu lesen. Exportieren Sie nur die Abfragen (oder fügen Sie sie direkt ein) und versuchen Sie es erneut.", "unsupported":"Dieser Dateityp wird nicht unterstützt — verwenden Sie .txt, .csv, .xlsx oder .docx, oder fügen Sie die Abfragen direkt ein.", "readError":"Diese Datei konnte nicht gelesen werden — fügen Sie die Abfragen stattdessen direkt ein.", "docxUnavailable":"Dieser Browser kann .docx-Dateien hier nicht lesen. Öffnen Sie das Dokument, kopieren Sie den Text und fügen Sie ihn ein — oder speichern Sie es als .txt." },
  Spanish: { "importedTruncated":"Se importaron las primeras {n} líneas de {name}. Pulse Enviar y seleccionaré lo relevante — con un archivo de este tamaño, compruebe que se incluyeron las consultas que más le importan.", "imported":"{name} importado. Pulse Enviar y seleccionaré lo relevante — no hace falta ordenarlo.", "noText":"No se encontró texto en {name}.", "tooLarge":"Este archivo ocupa {mb} MB — demasiado grande para leerlo aquí. Exporte solo las consultas (o péguelas directamente) e inténtelo de nuevo.", "unsupported":"Ese tipo de archivo no es compatible — use .txt, .csv, .xlsx o .docx, o pegue las consultas directamente.", "readError":"No se pudo leer ese archivo — pruebe a pegar las consultas directamente.", "docxUnavailable":"Este navegador no puede leer archivos .docx aquí. Abra el documento, copie el texto y péguelo — o guárdelo como .txt." },
  Italian: { "importedTruncated":"Importate le prime {n} righe di {name}. Premi Invia e selezionerò ciò che è pertinente — con un file di queste dimensioni, verifica che le query più importanti siano incluse.", "imported":"{name} importato. Premi Invia e selezionerò ciò che è pertinente — non serve riordinare.", "noText":"Nessun testo trovato in {name}.", "tooLarge":"Questo file è di {mb} MB — troppo grande da leggere qui. Esporta solo le query (o incollale direttamente) e riprova.", "unsupported":"Questo tipo di file non è supportato — usa .txt, .csv, .xlsx o .docx, oppure incolla le query direttamente.", "readError":"Impossibile leggere il file — prova a incollare le query direttamente.", "docxUnavailable":"Questo browser non può leggere i file .docx qui. Apri il documento, copia il testo e incollalo — oppure salvalo come .txt." },
  Arabic: { "importedTruncated":"تم استيراد أول {n} سطرًا من {name}. اضغط إرسال وسأختار ما هو مهم — مع ملف بهذا الحجم، تأكّد من أن أهم الاستعلامات قد أُدرجت.", "imported":"تم استيراد {name}. اضغط إرسال وسأختار ما هو مهم — لا حاجة للترتيب.", "noText":"لم يُعثر على نص في {name}.", "tooLarge":"حجم هذا الملف {mb} ميغابايت — أكبر من أن يُقرأ هنا. صدّر الاستعلامات فقط (أو الصقها مباشرة) وحاول مرة أخرى.", "unsupported":"نوع الملف غير مدعوم — استخدم ‎.txt أو ‎.csv أو ‎.xlsx أو ‎.docx، أو الصق الاستعلامات مباشرة.", "readError":"تعذّرت قراءة الملف — جرّب لصق الاستعلامات مباشرة بدلاً من ذلك.", "docxUnavailable":"لا يمكن لهذا المتصفح قراءة ملفات ‎.docx هنا. افتح المستند وانسخ النص والصقه — أو احفظه بصيغة ‎.txt." },
};
function QN(key, lang, vars) {
  const dict = QN18N[lang] || QN18N.English;
  // Fall through to the attach table for keys that only exist there (staleVersion).
  // Without this the QUERIES widget would render an empty note for those, which reads
  // as nothing happening at all.
  let s = dict[key] != null ? dict[key] : QN18N.English[key];
  if (s == null) { const a = AT18N[lang] || AT18N.English; s = a[key] != null ? a[key] : AT18N.English[key]; }
  s = s || "";
  if (vars) for (const k in vars) s = s.split("{"+k+"}").join(vars[k]);
  return s;
}

// Finish-card localization. The card is React-rendered (not model output), so
// unlike the conversation it does NOT follow the language automatically — a
// French client would otherwise hit an English wall at the payoff moment. These
// cover the titles, the "what happens next" timeline, and the action buttons.
const FN18N = {
  English: { titleSent:"Brief sent to your Lumen team", titlePre:"One last step: send your brief", descSheet:"Your setup brief has been sent, and we've shared an editable Google Sheet with you (check your email). Update it anytime before your review call and your consultant will see the changes.", descPlain:"Your setup brief has been sent to your Lumen team. Here's what happens next.", descPre:"Review your brief, then send it straight to your Lumen team, nothing to download or email.", s1a:"We review your brief", s1b:"and follow up with you", s2a:"Your review call", s2b:"we finalise the plan together", s3a:"Setup & configuration", s3b:"your Lumen team builds it out", s4a:"Go live", s4b:"your dashboards start tracking", openSheet:"Open your brief (Google Sheet)", review:"Review", reviewDl:"Review / download a copy", reviewSend:"Review & send" },
  French: { titleSent:"Brief envoyé à votre équipe Lumen", titlePre:"Dernière étape : envoyez votre brief", descSheet:"Votre brief de configuration a été envoyé, et nous avons partagé avec vous un Google Sheet modifiable (vérifiez votre e-mail). Mettez-le à jour à tout moment avant votre appel de révision, et votre consultant verra les changements.", descPlain:"Votre brief de configuration a été envoyé à votre équipe Lumen. Voici la suite.", descPre:"Vérifiez votre brief, puis envoyez-le directement à votre équipe Lumen : rien à télécharger ni à envoyer par e-mail.", s1a:"Nous examinons votre brief", s1b:"et vous recontactons", s2a:"Votre appel de révision", s2b:"nous finalisons le plan ensemble", s3a:"Configuration", s3b:"votre équipe Lumen la met en place", s4a:"Mise en service", s4b:"vos tableaux de bord commencent le suivi", openSheet:"Ouvrir votre brief (Google Sheet)", review:"Consulter", reviewDl:"Consulter / télécharger une copie", reviewSend:"Vérifier et envoyer" },
  German: { titleSent:"Briefing an Ihr Lumen-Team gesendet", titlePre:"Letzter Schritt: Briefing senden", descSheet:"Ihr Setup-Briefing wurde gesendet, und wir haben ein bearbeitbares Google Sheet mit Ihnen geteilt (prüfen Sie Ihre E-Mail). Aktualisieren Sie es jederzeit vor Ihrem Review-Termin, und Ihr Berater sieht die Änderungen.", descPlain:"Ihr Setup-Briefing wurde an Ihr Lumen-Team gesendet. So geht es weiter.", descPre:"Prüfen Sie Ihr Briefing und senden Sie es direkt an Ihr Lumen-Team, ganz ohne Download oder E-Mail.", s1a:"Wir prüfen Ihr Briefing", s1b:"und melden uns bei Ihnen", s2a:"Ihr Review-Termin", s2b:"wir finalisieren den Plan gemeinsam", s3a:"Einrichtung", s3b:"Ihr Lumen-Team richtet es ein", s4a:"Go-live", s4b:"Ihre Dashboards starten das Tracking", openSheet:"Ihr Briefing öffnen (Google Sheet)", review:"Ansehen", reviewDl:"Ansehen / Kopie herunterladen", reviewSend:"Prüfen und senden" },
  Spanish: { titleSent:"Resumen enviado a su equipo de Lumen", titlePre:"Último paso: envíe su resumen", descSheet:"Su resumen de configuración se ha enviado y hemos compartido con usted una hoja de Google editable (revise su correo). Actualícela cuando quiera antes de su llamada de revisión y su consultor verá los cambios.", descPlain:"Su resumen de configuración se ha enviado a su equipo de Lumen. Esto es lo que sigue.", descPre:"Revise su resumen y envíelo directamente a su equipo de Lumen, sin nada que descargar ni enviar por correo.", s1a:"Revisamos su resumen", s1b:"y nos ponemos en contacto", s2a:"Su llamada de revisión", s2b:"finalizamos el plan juntos", s3a:"Configuración", s3b:"su equipo de Lumen la implementa", s4a:"Puesta en marcha", s4b:"sus paneles empiezan a monitorizar", openSheet:"Abrir su resumen (Google Sheet)", review:"Revisar", reviewDl:"Revisar / descargar una copia", reviewSend:"Revisar y enviar" },
  Italian: { titleSent:"Brief inviato al tuo team Lumen", titlePre:"Ultimo passo: invia il tuo brief", descSheet:"Il tuo brief di configurazione è stato inviato e abbiamo condiviso con te un Foglio Google modificabile (controlla la tua e-mail). Aggiornalo quando vuoi prima della call di revisione e il tuo consulente vedrà le modifiche.", descPlain:"Il tuo brief di configurazione è stato inviato al tuo team Lumen. Ecco cosa succede ora.", descPre:"Controlla il tuo brief e invialo direttamente al tuo team Lumen, senza nulla da scaricare o inviare via e-mail.", s1a:"Esaminiamo il tuo brief", s1b:"e ti ricontattiamo", s2a:"La tua call di revisione", s2b:"finalizziamo insieme il piano", s3a:"Configurazione", s3b:"il tuo team Lumen la realizza", s4a:"Go-live", s4b:"le tue dashboard iniziano il monitoraggio", openSheet:"Apri il tuo brief (Foglio Google)", review:"Rivedi", reviewDl:"Rivedi / scarica una copia", reviewSend:"Rivedi e invia" },
  Arabic: { titleSent:"تم إرسال الملخص إلى فريق Lumen", titlePre:"خطوة أخيرة: أرسل ملخصك", descSheet:"تم إرسال ملخص الإعداد الخاص بك، وشاركنا معك جدول Google قابلًا للتعديل (تحقق من بريدك الإلكتروني). حدّثه في أي وقت قبل مكالمة المراجعة وسيرى استشاريك التغييرات.", descPlain:"تم إرسال ملخص الإعداد الخاص بك إلى فريق Lumen. إليك ما سيحدث بعد ذلك.", descPre:"راجع ملخصك، ثم أرسله مباشرةً إلى فريق Lumen، دون أي شيء لتنزيله أو إرساله بالبريد.", s1a:"نراجع ملخصك", s1b:"ونتواصل معك", s2a:"مكالمة المراجعة", s2b:"ننهي الخطة معًا", s3a:"الإعداد والتهيئة", s3b:"يقوم فريق Lumen الخاص بك بتنفيذها", s4a:"الانطلاق", s4b:"تبدأ لوحاتك في التتبع", openSheet:"افتح ملخصك (جدول Google)", review:"مراجعة", reviewDl:"مراجعة / تنزيل نسخة", reviewSend:"مراجعة وإرسال" },
};
function FN(key, lang) { const d = FN18N[lang] || FN18N.English; return (d[key] != null ? d[key] : FN18N.English[key]) || ""; }

// Composer attach (upload a supporting document at any point) strings, by language.
const AT18N = {
  English: { label:"Attach a document", trunc:"Only the first part was shared (large file).", failed:"That didn't go through — something timed out on our end, not a problem with your document. Give it a moment and try again, or send a smaller section.", pasteTooBig:"That's a lot of text to paste. Attach it as a file with the paperclip instead (.txt, .csv, .xlsx or .docx) and I'll read the whole thing.", tooLarge:"That document is {mb} MB, which is too large to read here. Attach a shorter section, or save it as .txt and attach that.", unsupported:"I can read .txt, .csv, .xlsx and .docx files. If yours is a PDF or another format, copy the text and paste it into the message box instead.", readError:"I couldn't read that document. Copy the text and paste it into the message box instead and I'll pick out what's useful.", staleVersion:"This page needs a refresh before it can read spreadsheets. Reload it and attach the file again, your conversation is saved." },
  French:  { label:"Joindre un document", trunc:"Seule la première partie a été partagée (fichier volumineux).", failed:"L'envoi n'a pas abouti — un délai a été dépassé de notre côté, ce n'est pas un problème avec votre document. Patientez un instant et réessayez, ou envoyez une section plus courte.", pasteTooBig:"Cela fait beaucoup de texte à coller. Joignez-le plutôt sous forme de fichier avec le trombone (.txt, .csv, .xlsx ou .docx) et je lirai l'ensemble.", tooLarge:"Ce document fait {mb} Mo, c'est trop volumineux pour être lu ici. Joignez une section plus courte, ou enregistrez-le en .txt et joignez ce fichier.", unsupported:"Je peux lire les fichiers .txt, .csv, .xlsx et .docx. Si le vôtre est un PDF ou un autre format, copiez le texte et collez-le dans la zone de message.", readError:"Je n'ai pas réussi à lire ce document. Copiez le texte et collez-le dans la zone de message, j'en extrairai ce qui est utile.", staleVersion:"Cette page doit être actualisée avant de pouvoir lire des feuilles de calcul. Rechargez-la et joignez le fichier à nouveau, votre conversation est enregistrée." },
  German:  { label:"Dokument anhängen", trunc:"Nur der erste Teil wurde geteilt (große Datei).", failed:"Das hat nicht geklappt — bei uns ist eine Zeitüberschreitung aufgetreten, es liegt nicht an Ihrem Dokument. Warten Sie einen Moment und versuchen Sie es erneut, oder senden Sie einen kürzeren Abschnitt.", pasteTooBig:"Das ist viel Text zum Einfügen. Hängen Sie ihn stattdessen als Datei über die Büroklammer an (.txt, .csv, .xlsx oder .docx), dann lese ich das Ganze.", tooLarge:"Dieses Dokument ist {mb} MB groß und damit zu groß, um es hier zu lesen. Hängen Sie einen kürzeren Abschnitt an, oder speichern Sie es als .txt und hängen Sie diese Datei an.", unsupported:"Ich kann .txt-, .csv-, .xlsx- und .docx-Dateien lesen. Wenn Ihre Datei ein PDF oder ein anderes Format ist, kopieren Sie den Text und fügen Sie ihn in das Nachrichtenfeld ein.", readError:"Ich konnte dieses Dokument nicht lesen. Kopieren Sie den Text und fügen Sie ihn in das Nachrichtenfeld ein, dann suche ich das Passende heraus.", staleVersion:"Diese Seite muss neu geladen werden, bevor sie Tabellen lesen kann. Laden Sie sie neu und hängen Sie die Datei erneut an, Ihre Unterhaltung ist gespeichert." },
  Spanish: { label:"Adjuntar un documento", trunc:"Solo se compartió la primera parte (archivo grande).", failed:"No se pudo enviar — se agotó el tiempo de espera por nuestra parte, no es un problema con su documento. Espere un momento y vuelva a intentarlo, o envíe una sección más corta.", pasteTooBig:"Es mucho texto para pegar. Adjúntelo como archivo con el clip (.txt, .csv, .xlsx o .docx) y lo leeré completo.", tooLarge:"Ese documento ocupa {mb} MB, demasiado para leerlo aquí. Adjunte una sección más corta, o guárdelo como .txt y adjunte ese archivo.", unsupported:"Puedo leer archivos .txt, .csv, .xlsx y .docx. Si el suyo es un PDF u otro formato, copie el texto y péguelo en el cuadro de mensaje.", readError:"No he podido leer ese documento. Copie el texto y péguelo en el cuadro de mensaje y yo seleccionaré lo relevante.", staleVersion:"Esta página necesita actualizarse antes de poder leer hojas de cálculo. Recárguela y adjunte el archivo de nuevo, su conversación está guardada." },
  Italian: { label:"Allega un documento", trunc:"È stata condivisa solo la prima parte (file grande).", failed:"Invio non riuscito — si è verificato un timeout dalla nostra parte, non è un problema del tuo documento. Attendi un momento e riprova, oppure invia una sezione più breve.", pasteTooBig:"È molto testo da incollare. Allegalo invece come file con la graffetta (.txt, .csv, .xlsx o .docx) e lo leggerò tutto.", tooLarge:"Questo documento è di {mb} MB, troppo grande da leggere qui. Allega una sezione più breve, oppure salvalo come .txt e allega quel file.", unsupported:"Posso leggere file .txt, .csv, .xlsx e .docx. Se il tuo è un PDF o un altro formato, copia il testo e incollalo nella casella del messaggio.", readError:"Non sono riuscito a leggere questo documento. Copia il testo e incollalo nella casella del messaggio, selezionerò ciò che serve.", staleVersion:"Questa pagina va ricaricata prima di poter leggere i fogli di calcolo. Ricaricala e allega di nuovo il file, la tua conversazione è salvata." },
  Arabic:  { label:"إرفاق مستند", trunc:"تمت مشاركة الجزء الأول فقط (ملف كبير).", failed:"لم يتم الإرسال — حدث تجاوز للمهلة من جانبنا، وليست مشكلة في مستندك. انتظر لحظة ثم أعد المحاولة، أو أرسل قسمًا أقصر.", pasteTooBig:"هذا نص كبير للصقه. أرفقه كملف باستخدام المشبك بدلاً من ذلك (‎.txt أو ‎.csv أو ‎.xlsx أو ‎.docx) وسأقرؤه بالكامل.", tooLarge:"حجم هذا المستند {mb} ميغابايت، وهو أكبر من أن يُقرأ هنا. أرفق قسمًا أقصر، أو احفظه بصيغة ‎.txt وأرفق ذلك الملف.", unsupported:"يمكنني قراءة ملفات ‎.txt و‎.csv و‎.xlsx و‎.docx. إذا كان ملفك بصيغة PDF أو صيغة أخرى، انسخ النص والصقه في مربع الرسالة.", readError:"تعذّرت عليّ قراءة هذا المستند. انسخ النص والصقه في مربع الرسالة وسأختار منه ما يفيد.", staleVersion:"تحتاج هذه الصفحة إلى إعادة تحميل قبل أن تتمكن من قراءة جداول البيانات. أعد تحميلها وأرفق الملف مرة أخرى، محادثتك محفوظة." },
};
function AT(key, lang) { const d = AT18N[lang] || AT18N.English; return (d[key] != null ? d[key] : AT18N.English[key]) || ""; }
// Error text for the composer-attach path. Tries the ATTACH table first, so a client
// who attached a requirements document is no longer told to "export just the queries"
// (the queries wording is correct in the QUERIES widget and wrong here). Falls back to
// the queries table for the messages that read correctly in both contexts — noText,
// docxUnavailable — rather than duplicating them into six languages for no gain.
export function ATERR(key, lang, vars) {
  const d = AT18N[lang] || AT18N.English;
  const s = d[key] != null ? d[key] : AT18N.English[key];
  if (s == null) return QN(key, lang, vars);
  let out = s;
  if (vars) for (const k in vars) out = out.split("{"+k+"}").join(vars[k]);
  return out;
}


const gts   = () => new Date().toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
// Epoch stamp stored beside the display time. gts() is HH:MM only, which was fine
// when a session was one sitting, but resume now spans days: without a real date we
// cannot tell that two adjacent bubbles are three days apart. Older saved drafts have
// no `at`, so every consumer must treat it as optional.
const gat   = () => Date.now();
// Insert a date separator when consecutive messages straddle a real gap: a different
// calendar day, or more than 6h (a client who pauses over lunch and returns the same
// evening). Returns null when either side lacks a stamp, so old drafts simply show no
// separator rather than a wrong one.
const GAP_MS = 6 * 3600 * 1000;
function gapLabel(prevAt, at, lang) {
  if (!prevAt || !at) return null;
  const a = new Date(prevAt), b = new Date(at);
  const sameDay = a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
  if (sameDay && (at - prevAt) < GAP_MS) return null;
  const today = new Date(), yest = new Date(today.getTime() - 86400000);
  const isSame = (x,y) => x.getFullYear()===y.getFullYear() && x.getMonth()===y.getMonth() && x.getDate()===y.getDate();
  const loc = LOCALE_OF[lang] || undefined;
  if (isSame(b, today)) return L("gapToday", lang);
  if (isSame(b, yest))  return L("gapYesterday", lang);
  try { return b.toLocaleDateString(loc, { weekday:"long", day:"numeric", month:"long" }); }
  catch { return b.toLocaleDateString(); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// In-progress autosave to localStorage for same-device pause/resume. Keyed by the
// seed id when present, else a single default slot. Best-effort: any failure
// (private mode, quota, storage disabled) degrades to no-resume without throwing.
// Minimum viewport width at which the captured-answers panel can sit BESIDE the
// conversation rather than on top of it. ONE constant on purpose: the panel's
// default-open test and the transform that makes room for it used to be two separate
// numbers (>1080 and >=1280). Between them the panel opened but nothing moved, so on
// any 1081-1279px window — a very common laptop size, and the DEFAULT state there —
// it covered the right edge of the chat. Right-aligned content suffers most, which
// means the client's own answers were the part getting cut off mid-word.
const SIDE_COL_MIN = 1280;

const LS_PREFIX = "lumen_onb_v1_";
const lsKey = seedId => LS_PREFIX + (seedId || "default");
function lsLoadDraft(seedId) {
  try {
    const raw = localStorage.getItem(lsKey(seedId));
    if (!raw) return null;
    const o = JSON.parse(raw);
    // Deliberately NOT gated on percent < 100. That test conflated "finished
    // answering" with "sent", and 100%-but-unsent is a completely ordinary state: the
    // client answers everything, sees "One last step: send your brief", and closes the
    // tab. They came back to a blank Start screen, and starting again overwrote the
    // finished brief — 27 messages destroyed in the case that surfaced this.
    // Sent-ness is already handled without it: the autosave effect bails once `sent`
    // is true, so no draft is ever written after a send, and handleSend clears both
    // copies on success. The one draft that deliberately survives a send is the
    // save-failed-but-Sheet-delivered case, which is kept precisely so it CAN be
    // resumed and re-sent — something the old guard made impossible.
    return (o && Array.isArray(o.messages) && o.messages.length && o.progress) ? o : null;
  } catch { return null; }
}
function lsSaveDraft(seedId, snap) { try { localStorage.setItem(lsKey(seedId), JSON.stringify(snap)); return true; } catch { return false; } }
// A tiny receipt written once the brief is delivered. `sent` and `sheetLink` are plain
// component state and the draft is deliberately cleared on a successful send, so before
// this a refresh (or simply re-opening the emailed link to find the Sheet again) dropped
// the client back on the untouched Start screen as if they had never sent anything —
// confirmation gone, Sheet link gone. Pressing Start there mints a NEW session id, so
// the consultant gets a second dashboard row for the same client. Deliberately tiny: no
// messages, no history, nothing that could resurrect a conversation.
const lsSentKey = seedId => LS_PREFIX + "sent_" + (seedId || "default");
function lsSaveReceipt(seedId, r) { try { localStorage.setItem(lsSentKey(seedId), JSON.stringify(r)); } catch {} }
function lsLoadReceipt(seedId) {
  try {
    const raw = localStorage.getItem(lsSentKey(seedId));
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && o.sentAt) ? o : null;
  } catch { return null; }
}
function lsClearReceipt(seedId) { try { localStorage.removeItem(lsSentKey(seedId)); } catch {} }
// Is localStorage actually writable? (Private mode / quota / disabled storage
// all throw.) Used so the "Saved on this device" badge isn't shown when saving
// silently fails.
function lsProbe() { try { const k = "__lumen_probe__"; localStorage.setItem(k, "1"); localStorage.removeItem(k); return true; } catch { return false; } }
function lsClearDraft(seedId) { try { localStorage.removeItem(lsKey(seedId)); } catch {} }

// Server-side draft, keyed by the LINK's seed id, so a client who reopens their link
// on ANY device resumes exactly where they left off. localStorage alone was
// same-browser only: start on a laptop, reopen on a phone, and the work was gone —
// which pressured busy clients into sending an incomplete brief. Both sinks are kept:
// the local copy is instant and survives a network blip, the server copy travels.
// All three helpers are best-effort and never throw into the chat.
// Non-seeded sessions have no stable key, so they stay local-only (unchanged).
const DRAFT_ENDPOINT = "/.netlify/functions/draft";
// Trim the model history before storing: callAPI only ever sends the last
// MAX_HIST_TURNS (20) entries, so keeping ~4x that is far more than a resume needs
// while stopping a very long session from bloating the stored snapshot.
const DRAFT_HIST_KEEP = 80;
export function draftPayload(snap) {
  const hist = Array.isArray(snap.history) ? snap.history.slice(-DRAFT_HIST_KEEP) : [];
  // Belt and braces on `raw` (the unstripped model output, including the hidden
  // <thought> block). Messages no longer carry it at all, but this is the one payload
  // that LEAVES the browser and is retrievable by any holder of the client link, so
  // strip it here too: a future change that re-adds raw to a message object then
  // cannot silently start persisting it server-side.
  //
  // It was also the largest growth term in the draft — unlike `history`, `messages` is
  // never trimmed, and a marker-heavy turn's raw runs several times its visible text.
  // Overflowing the 1MB cap in draft.js fails SILENTLY (srvSaveDraft's result is
  // ignored by its caller), so cross-device resume would just quietly stop updating.
  const messages = Array.isArray(snap.messages)
    ? snap.messages.map(({ raw, ...rest }) => rest)
    : snap.messages;
  return { ...snap, messages, history: hist };
}
async function srvSaveDraft(seedId, snap, opts) {
  if (!seedId) return false;
  try {
    const res = await fetch(DRAFT_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seedId, snapshot: draftPayload(snap) }),
      // keepalive lets the write survive the page being backgrounded/closed, which is
      // exactly when the last-moment save matters most.
      keepalive: !!(opts && opts.keepalive),
    });
    return res.ok;
  } catch { return false; }
}
async function srvLoadDraft(seedId) {
  if (!seedId) return null;
  try {
    const res = await fetchWithTimeout(`${DRAFT_ENDPOINT}?seedId=${encodeURIComponent(seedId)}`, {}, 12000);
    if (!res.ok) return null; // 404 = nothing saved yet, which is the normal first visit
    const data = await res.json();
    const d = data && data.draft;
    // Same validity bar as the local draft: a real conversation. No percent ceiling —
    // see the note in lsLoadDraft for why 100%-but-unsent must stay resumable.
    return (d && Array.isArray(d.messages) && d.messages.length && d.progress)
      ? { ...d, savedAt: Date.parse(data.savedAt) || d.savedAt || 0 }
      : null;
  } catch { return null; }
}
// Choose between the on-device draft and the server draft: most recently saved wins,
// so continuing on a second device picks up the latest state and a same-device return
// still wins if it got further while the network was down. Either side may be null.
// Both stamps are wall-clock, so a device whose clock is badly wrong could prefer a
// slightly older draft. Accepted: modern devices sync time, and the downside is
// resuming a turn or two earlier (the assistant simply continues), not a corrupt brief.
function pickDraft(local, remote) {
  const at = d => (d && Number(d.savedAt)) || 0;
  if (remote && at(remote) > at(local)) return remote;
  return local || remote || null;
}
function srvClearDraft(seedId) {
  if (!seedId) return;
  try {
    fetch(DRAFT_ENDPOINT, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seedId, done: true }), keepalive: true,
    }).catch(() => {});
  } catch {}
}

// Pure fold of one parsed reply's markers onto a cdata object. Used live and to
// rebuild cdata from surviving messages after a rewind.
// Arrays REPLACE wholesale: the system prompt re-emits the FULL array each time,
// so a new non-empty array is the complete current set. (An earlier attempt to
// union by name silently collapsed distinct entries that share a key — e.g. one
// brand's Instagram/X/TikTok channels all keyed on author "Nike" — so it was
// reverted. The rare partial re-emit is recoverable in the editable review modal.)
function mergeCdata(base, pr) {
  const { companyData,topicsData,channelsData,reportsData,alertsData,usersData,handoffData } = pr;
  if (!(companyData||topicsData||channelsData||reportsData||alertsData||usersData||handoffData)) return base;
  // Wipe guards: a stray re-emit of an EMPTY array (model slip) must not erase
  // data already captured — arrays replace wholesale only when the new one has
  // items. Objects (company/handoff) merge field-by-field with blanks dropped,
  // so a re-emit that forgot a field can't null out a value we already have.
  // The editable review modal remains the human backstop for true removals.
  const keepArr = (next, prev) => (Array.isArray(next) && next.length) ? next : prev;
  const mergeObj = (next, prev) => next ? { ...prev, ...pruneEmpty(next) } : prev;
  return {...base,
    company: mergeObj(companyData, base.company),
    topics: keepArr(topicsData, base.topics),
    channels: keepArr(channelsData, base.channels),
    reports: keepArr(reportsData, base.reports),
    alerts: keepArr(alertsData, base.alerts),
    users: keepArr(usersData, base.users),
    handoff: mergeObj(handoffData, base.handoff)};
}
// Drop null/undefined/blank values so a marker re-emit with empty fields never
// overwrites a previously captured value.
const pruneEmpty = o => {
  const r = {};
  for (const k in o) { const v = o[k]; if (v != null && v !== "") r[k] = v; }
  return r;
};
const emptyCdata = () => ({company:{},topics:[],channels:[],reports:[],alerts:[],users:[]});
// Union users captured two ways — the submitted [WIDGET:USERS] value and the
// %%USERS%% marker (people named in conversation, e.g. report recipients) — so a
// user recorded either way reaches the brief. Dedupe by email (else by name);
// blank rows (no email or name) are dropped. Widget entries come first.
// Identity is the (email, name) PAIR, not the email alone. Keying on email only
// silently dropped a real person whenever two of them shared one mailbox — a
// team alias like info@ or marketing@, a PA on the director's address. The chat
// had reported both, the brief kept one, and the missing person simply never got
// access provisioned. Losing someone invisibly is worse than showing a duplicate
// the review modal can delete, so the pair wins ties.
export const unionUsers = (a, b) => {
  const norm = s => String(s == null ? "" : s).trim().toLowerCase();
  const emailOf = u => norm(u && u.email);
  const nameOf = u => (norm(u && u.firstName) + " " + norm(u && u.lastName)).trim();
  const out = [], seen = new Set();
  for (const list of [Array.isArray(a) ? a : [], Array.isArray(b) ? b : []]) {
    for (const u of list) {
      const e = emailOf(u), n = nameOf(u);
      if (!e && !n) continue;                       // blank row: nothing to identify
      const k = e && n ? e + "|" + n : (e || "n|" + n);
      if (seen.has(k)) continue;
      seen.add(k); out.push(u);
    }
  }
  // One person captured twice — once before their name was known (the %%USERS%%
  // marker can name a recipient by email alone) and once with it — is still one
  // person, so drop the nameless copy when a named entry shares that email.
  return out.filter(u => {
    const e = emailOf(u);
    if (!e || nameOf(u)) return true;
    return !out.some(v => emailOf(v) === e && nameOf(v));
  });
};
// Reconcile confirmed topic CARDS (client-facing; may be renamed/edited inline) with
// the %%TOPICS%% MARKER (re-emitted by the model, carrying urls/hashtags/comments and
// any noise-check NOT exclusions). Cards are the authoritative SET when present. Match
// a card to its marker by name; a renamed card whose marker didn't name-match is paired
// to a leftover marker BY POSITION (so a rename merges into one topic instead of
// duplicating). Markers beyond the card count are genuinely new topics (e.g. a later
// suggestion batch) and are appended. Marker wins on the fields it updates
// (keywords/urls/hashtags/comments); card wins on name/rationale/group. No cards -> the
// marker is the set. The review modal remains the human backstop for edits.
function mergeTopics(cards, markers) {
  cards = Array.isArray(cards) ? cards : [];
  markers = Array.isArray(markers) ? markers : [];
  const nm = x => String((x && x.name) || "").trim().toLowerCase();
  const shape = (c, m, i) => ({ name:c.name||m.name||"",
    keywords:m.keywords||c.keywords||"", urls:m.urls||c.urls||"",
    hashtags:m.hashtags||c.hashtags||"", comments:m.comments||c.comments||"",
    rationale:c.rationale||m.rationale||"", group:c.group||m.group||"", type:m.type||c.type||"",
    id:i, confirmed:!(isGuess(c)||isGuess(m)) });
  if (!cards.length) return markers.map((m, i) => shape({}, m, i));
  const markBy = {};
  markers.forEach(m => { const k = nm(m); if (k && !(k in markBy)) markBy[k] = m; });
  const used = new Set();
  const rows = cards.map(c => { const m = markBy[nm(c)]; if (m) used.add(nm(m)); return { c, m: m || null }; });
  const leftover = markers.filter(m => !used.has(nm(m)));
  let li = 0;
  rows.forEach(r => { if (!r.m && li < leftover.length) r.m = leftover[li++]; }); // renamed card absorbs its orphan marker
  const extras = leftover.slice(li).map(m => ({ c: null, m })); // genuinely-new marker-only topics
  return rows.concat(extras).map((r, i) => shape(r.c || {}, r.m || {}, i));
}
function pProg(t) { const m = t.match(/%%PROGRESS%%([\s\S]*?)%%END%%/); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } }
function pMark(t, k) { const m = t.match(new RegExp("%%"+k+"%%(\\[?[\\s\\S]*?\\]?)%%END%%")); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } }
// Neutralize marker delimiters in CLIENT-authored text before it reaches the
// model. Markers are `%%NAME%%...%%END%%`; if a client types "%%END%%" (or the
// model echoes a client value containing it back into a marker), parsing would
// truncate and silently drop that field. Collapsing runs of %% to a single %
// keeps ordinary "50%" intact while removing any delimiter a client could inject.
const sanitizeIn = s => String(s == null ? "" : s).replace(/%%+/g, "%");
// The prompt requires a hidden <thought> block on every reply. It is only needed
// for that turn's planning; re-sending past thoughts back in the history wastes
// input tokens on every call. Strip them before an assistant turn re-enters history
// (markers/widgets stay, so the model keeps the structured context it needs).
const stripThoughtForHistory = t => String(t == null ? "" : t)
  .replace(/<(thought|thoughts|thinking|think)>[\s\S]*?<\/(thought|thoughts|thinking|think)>/g, "")
  .replace(/<(thought|thoughts|thinking|think)>[\s\S]*$/, "")
  .trim();
// Exported for tests/. These are pure and are the highest-risk untested path in the
// app: everything the client sees is what survives stripAll, and a marker the parser
// mishandles silently drops captured brief data.
export function stripAll(t) {
  let s = t
    .replace(/%%[A-Z]+%%[\s\S]*?%%END%%/g, "")
    .replace(/\[WIDGET:[A-Z_]+\]/g, "")
    .replace(/<(thought|thoughts|thinking|think)>[\s\S]*?<\/(thought|thoughts|thinking|think)>/g, "")
    .replace(/^\s*<(thought|thoughts|thinking|think)>[\s\S]*$/, "")
    .replace(/\[SUGGESTIONS:[\s\S]*?\]/g, "")
    .replace(/\[OFFER_SEND\]/g, "")
    .replace(/TOPIC_SUGGESTION\s*\{[^{}]*\}/g, "")
    .replace(/^TOPIC_SUGGESTION\|.*$/gm, "");
  // Safety net: a reply truncated mid-marker leaves an opening %%MARKER%% with no
  // closing %%END%%, which would otherwise render as raw JSON. Markers are always
  // emitted at the start of a reply, so anything from a leftover opener onward is
  // truncated junk — cut it. Same for a half-written [WIDGET:/[SUGGESTIONS: tag.
  const mk = s.search(/%%[A-Z]+%%/);
  if (mk !== -1) s = s.slice(0, mk);
  const tag = s.search(/\[(WIDGET|SUGGESTIONS):[^\]]*$/);
  if (tag !== -1) s = s.slice(0, tag);
  const th = s.search(/<(thought|thoughts|thinking|think)>/);
  if (th !== -1) s = s.slice(0, th);
  // Collapse the blank-line gaps left where stripped markers used to sit, so a
  // reply that was mostly markers doesn't render with a big hole in the middle.
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
// True when a reply contains an opening %%MARKER%% with no matching %%END%% — the
// signature of a response that was cut off mid-emit.
export function hasDanglingMarker(t) {
  return /%%[A-Z]+%%/.test(t.replace(/%%[A-Z]+%%[\s\S]*?%%END%%/g, ""));
}
// True when a COMPLETE marker (has %%END%%) carries a body that isn't valid JSON —
// every marker's payload is JSON by protocol. A malformed body (a literal newline
// or an unescaped quote in a free-text field like a HANDOFF tip) parses to null and
// is silently dropped with no other signal: worst case the rich HANDOFF vanishes on
// the very summary turn it matters. Treated like a dangling marker so callAPILive
// retries once — a regeneration almost always fixes a transient JSON glitch.
export function hasUnparseableMarker(t) {
  const re = /%%[A-Z]+%%([\s\S]*?)%%END%%/g;
  let m;
  while ((m = re.exec(t))) {
    try { JSON.parse(m[1].trim()); } catch { return true; }
  }
  return false;
}
// True when the visible prose implies the setup is already live/running/delivering,
// which it never is until the consultant activates it at the review call. High-
// precision phrase list — the prompt rule handles the long tail; this catches the
// specific overstatements testers flagged and triggers a corrective rewrite.
function overstatesCompletion(t) {
  // Strong present-completion claims (the "now" cases testers flagged) + always-wrong phrases.
  if (/\b((is|are|you'?re|you are) now (set up|live|active|running|configured|enabled|getting|receiving|monitoring|tracking|all set)|will now (get|receive|start|begin)|now getting proactive|delivered on a schedule|you'?re all set|is now live)\b/i.test(t)) return true;
  // Bare "is live/active/running" claims — but NOT when framed conditionally ("once this is live, you'll…"), which is correct.
  if (/\b(this|it|your setup|the setup|everything) is (live|active|running)\b/i.test(t) && !/\b(once|when|after|as soon as|until)\b/i.test(t)) return true;
  return false;
}
// PATH is deliberately dropped: STEP 2 routes the client silently (guided vs
// expert) and the "Guided Setup / Recommendations" chooser was retired. The model
// is instructed never to emit [WIDGET:PATH], but if it slips we must not render
// the chooser — so ignore it here regardless of what the model sends.
function exWid(t) { return [...new Set((t.match(/\[WIDGET:[A-Z_]+\]/g)||[]).map(x => x.replace(/\[WIDGET:|\]/g, "")))].filter(w => w !== "PATH"); }
function procTopics(t) {
  const s = [];
  // A topic suggestion arrives in two shapes and BOTH must be parsed into cards AND
  // removed from the visible text, or the raw marker leaks to the client (the live-
  // build bug where a client saw TOPIC_SUGGESTION{...}).
  //  (a) JSON form: TOPIC_SUGGESTION{...} (or "TOPIC_SUGGESTION: {...}"), mirroring
  //      the %%TOPICS%% schema (group/name/keywords/urls/hashtags/comments). We find
  //      the object by STRING-AWARE brace counting, not a regex, so a payload with a
  //      quoted/nested brace or a colon prefix is still caught and stripped (a flat
  //      \{[^{}]*\} regex missed both and leaked them).
  //  (b) Legacy pipe form: TOPIC_SUGGESTION|name|keywords|rationale — one per line.
  const cut = []; // [start,end) ranges of matched JSON markers to remove from the text
  const re = /TOPIC_SUGGESTION\s*:?\s*\{/g;
  let m;
  while ((m = re.exec(t))) {
    const objStart = t.indexOf("{", m.index);
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = objStart; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) { cut.push([m.index, t.length]); break; } // unterminated (truncated) — drop to end
    try {
      const o = JSON.parse(t.slice(objStart, end));
      if (o && (o.name || o.keywords)) s.push({
        name: String(o.name || "").trim(),
        keywords: String(o.keywords || "").trim(),
        rationale: String(o.comments || o.rationale || "").trim(),
        group: String(o.group || "").trim(),
        urls: String(o.urls || "").trim(),
        hashtags: String(o.hashtags || "").trim(),
      });
    } catch { /* malformed JSON — still cut below so nothing leaks */ }
    cut.push([m.index, end]);
    re.lastIndex = end;
  }
  let text = t;
  for (let i = cut.length - 1; i >= 0; i--) text = text.slice(0, cut[i][0]) + text.slice(cut[i][1]);
  const k = [];
  for (const l of text.split("\n")) {
    if (l.trim().startsWith("TOPIC_SUGGESTION|")) {
      const p = l.split("|");
      if (p.length >= 4) s.push({ name:p[1].trim(), keywords:p[2].trim(), rationale:p[3].trim() });
    } else k.push(l);
  }
  return { suggestions:s, stripped:k.join("\n").trim() };
}
// Chips are pipe-separated per the SP, but models sometimes emit commas anyway.
// Fall back to comma-splitting only at 3+ segments so legitimate single chips
// containing one comma ("Yes, looks good") stay intact.
function splitChips(s) {
  if (s.includes("|")) return s.split("|").map(x=>x.trim()).filter(Boolean);
  const byComma = s.split(",").map(x=>x.trim()).filter(Boolean);
  return byComma.length >= 3 ? byComma : [s.trim()].filter(Boolean);
}
// Exported for tests/. EVERY extraction below runs on the reply with the hidden
// <thought> block removed first, never on the raw text.
//
// This is load-bearing, not tidiness. The model plans out loud in <thought> and
// routinely writes control tokens there while planning — observed live, e.g.
// "next: STEP 4B — [WIDGET:MARKETS] with one context sentence". Extracting from
// the raw text treats those planning mentions as real instructions:
//   - a thought naming a DIFFERENT widget than the turn emits renders BOTH,
//     stacking a widget the model never meant to show;
//   - the prompt says never to show [WIDGET:LANGUAGES]/[WIDGET:TIMEZONE], but a
//     thought reasoning about that rule made the client render exactly those;
//   - quickReplies are suppressed whenever widgets.length > 0, so a single
//     phantom widget silently deletes the quick-reply chips from a turn whose
//     chips the prompt requires "every time and without exception";
//   - a thought weighing whether to offer an early send ("[OFFER_SEND]? not
//     yet") put the send button on screen, inviting a half-empty brief.
// The thought is invisible to the client, so any of these look like the app
// malfunctioning for no reason. Stripping once, here, closes all of them.
export function parseReply(r) {
  const v = stripThoughtForHistory(r);
  const progress = pProg(v), widgets = exWid(v);
  const sm = v.match(/\[SUGGESTIONS:\s*(.+?)\]/);
  const quickReplies = sm && widgets.length === 0 ? splitChips(sm[1]) : [];
  const { suggestions:topicSuggestions, stripped } = procTopics(v);
  const clean = stripAll(stripped);
  if (topicSuggestions.length > 0 && !widgets.includes("TOPICS")) widgets.push("TOPICS");
  return { clean, widgets, topicSuggestions, quickReplies, progress, offerSend: /\[OFFER_SEND\]/.test(v),
    companyData:pMark(v,"COMPANY"), topicsData:pMark(v,"TOPICS"),
    channelsData:pMark(v,"CHANNELS"), reportsData:pMark(v,"REPORTS"), alertsData:pMark(v,"ALERTS"), usersData:pMark(v,"USERS"), handoffData:pMark(v,"HANDOFF"), raw:r };
}
function renderText(text) {
  const parts = [], rx = /(\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\)]+)\))/g;
  let last = 0, m, k = 0;
  while ((m = rx.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[0].startsWith("**")) parts.push(<strong key={k++}>{m[2]}</strong>);
    else parts.push(<a key={k++} href={m[4]} target="_blank" rel="noopener noreferrer" style={{color:LINK,textDecoration:"underline"}}>{m[3]}</a>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
const MsgText = memo(({ text }) => (
  <span>{text.split("\n").map((l,i,a) => <span key={i}>{renderText(l)}{i < a.length-1 ? <br/> : null}</span>)}</span>
));

function useAudio() {
  const r = useRef(null);
  const init  = useCallback(() => { if (!r.current) r.current = new (window.AudioContext || window.webkitAudioContext)(); }, []);
  const pop   = useCallback(() => { const c=r.current; if (!c||c.state==="suspended") return; const o=c.createOscillator(),g=c.createGain(); o.connect(g); g.connect(c.destination); o.type="sine"; o.frequency.setValueAtTime(450,c.currentTime); o.frequency.exponentialRampToValueAtTime(700,c.currentTime+0.1); g.gain.setValueAtTime(0,c.currentTime); g.gain.linearRampToValueAtTime(0.08,c.currentTime+0.02); g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+0.15); o.start(c.currentTime); o.stop(c.currentTime+0.15); }, []);
  const chime = useCallback(() => { const c=r.current; if (!c||c.state==="suspended") return; [523.25,659.25,783.99,1046.5].forEach((f,i)=>{ const o=c.createOscillator(),g=c.createGain(); o.connect(g); g.connect(c.destination); o.type="sine"; o.frequency.value=f; const t=c.currentTime+i*0.08; g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(0.05,t+0.02); g.gain.exponentialRampToValueAtTime(0.001,t+0.6); o.start(t); o.stop(t+0.6); }); }, []);
  return { init, pop, chime };
}

// Assistant message avatar: the real Hootsuite Owly mark (official asset in
// public/, not a reproduction). Used ONLY on the assistant message rows — the
// header runs on the "Lumen by Talkwalker" wordmark and the welcome/boot heroes
// stay mark-less. The PNG is transparent, so it sits directly on the chat bg.
function OwlAvatar({ size=28 }) {
  return <img src="/Owly-Logo-Cherry.png" alt="" width={size} height={size} style={{display:"block",flexShrink:0}}/>;
}
// Lumen product mark: the real waveform asset (public/lumen-mark.png) on a soft
// lavender disc, matching the brand lockup the client showed. Used on the "main
// page" — the header and the welcome hero. (The chat's assistant avatar uses the
// Hootsuite Owly instead, per the brand split.)
function LumenMark({ size=32 }) {
  const inner = Math.round(size * 0.6);
  return <div style={{width:size,height:size,borderRadius:"50%",background:"#EDE7FB",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
    <img src="/lumen-mark.png" alt="Lumen" width={inner} height={inner} style={{display:"block"}}/>
  </div>;
}
function Spinner({ dark=false }) {
  const faint = dark ? "rgba(100,116,139,0.25)" : "rgba(255,255,255,0.3)", solid = dark ? "#64748b" : "white";
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" style={{animation:"spin 0.8s linear infinite"}}><circle cx="9" cy="9" r="7" stroke={faint} strokeWidth="2"/><path d="M9 2a7 7 0 0 1 7 7" stroke={solid} strokeWidth="2" strokeLinecap="round"/></svg>;
}

// Branded boot/loading screen. The real client's very first paint after tapping
// their emailed link is the seed fetch, which can run ~30s on a bad network
// (15s timeout + one retry) — a bare unbranded grey "Loading…" for that long
// reads as broken. English is acceptable here: the session language isn't known
// until the seed arrives. Carries its own spin keyframes because it renders
// before OnboardingApp's <style> tag exists.
function BootScreen({ label = "Setting up your session…" }) {
  return <div style={{height:VH_FULL,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:16,fontFamily:"'Inter', Arial, sans-serif",background:"#fff"}}>
    <style>{"@keyframes spin{to{transform:rotate(360deg)}}"}</style>
    <LumenMark size={56}/>
    <div style={{display:"flex",alignItems:"center",gap:9,color:"#64748b",fontSize:13}}><Spinner dark/> {label}</div>
  </div>;
}
function Ic({ d, size=15 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;
}
const IC = {
  panel:  "M4 5h16M4 12h16M4 19h10",
  sound:  "M11 5 6 9H3v6h3l5 4V5Z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13",
  mute:   "M11 5 6 9H3v6h3l5 4V5Z M22 9l-6 6 M16 9l6 6",
  moon:   "M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z",
  sun:    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4",
  clock:  "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z M12 8v4l3 2",
  chat:   "M21 11.5a8.5 8.5 0 0 1-12.4 7.5L3 21l2-5.6A8.5 8.5 0 1 1 21 11.5Z",
  send:   "M22 2 11 13 M22 2l-7 20-4-9-9-4z",
  pencil: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  globe:  "M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z M3.5 9h17 M3.5 15h17 M12 3c2.6 2.6 2.6 15.4 0 18 M12 3c-2.6 2.6-2.6 15.4 0 18",
  clip:   "M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49",
};
function TypingIndicator({ lang, doc=false }) {
  const [v,setV] = useState(false);
  // The thinking state is the most-watched moment in the app. After a short beat
  // rotate through contextual status lines (C1) so a multi-second wait doesn't sit
  // on one static string; the dots stay and each new line crossfades in.
  const [step,setStep] = useState(0);
  useEffect(() => { const t = setTimeout(() => setV(true), 300); return () => clearTimeout(t); }, []);
  useEffect(() => {
    if (REDUCE_MOTION) return undefined;
    // Generation is a black box (non-streaming): we can't know how long is left, so
    // we PACE the status to an ASSUMED duration and ADVANCE ONCE, holding the final
    // line until the reply lands. Looping back to an earlier line reads as
    // "stuck/restarted" (an old version did this at ~10s, right as most replies
    // finished), so this only ever moves forward.
    // Two very different populations to pace for: a normal typed turn now runs
    // 3-4s on the sync-first path (see chat.js/lumen.jsx sync-first change), so the
    // default schedule advances fast and holds early rather than sitting on
    // "thinking…" for a reply that's already arriving. A document attach forces
    // the slower background path (heavy-turn routing) and legitimately takes
    // 15-40s+ depending on file size — an unpredictable wait the client can't
    // shrink, so the copy says so explicitly instead of implying a fixed budget.
    const marks = doc ? [1500, 6000, 14000] : [1200, 2600, 3800];
    const timers = marks.map((ms, i) => setTimeout(() => setStep(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [doc]);
  const keys = doc ? ["thinking","docThink1","docThink2","docThink3"] : ["thinking","think1","think2","think3"];
  const label = L(keys[step] || "thinking", lang);
  return <div style={{display:"flex",alignItems:"center",gap:12,minHeight:28}}>{v && <>
    <div style={{display:"flex",gap:4}}>{[0,1,2].map(d => <div key={d} style={{width:6,height:6,borderRadius:"50%",background:P,animation:"bounce 1.4s infinite ease-in-out both",animationDelay:`${d*0.16}s`}}/>)}</div>
    <span key={step} style={{fontSize:13,color:"#64748b",animation:REDUCE_MOTION?"none":"slideUpFade .3s ease-out"}}>{label}</span>
  </>}</div>;
}
export function Stepper({ progress, dark, compact, lang }) {
  const inactive = dark?"#2d4a6a":"#E7E7EF", muted = dark?"#8aa4c1":"#64748b", F = A, circleBg = dark?"#111f30":"#ffffff";
  // Onboarding is linear, but the model's `collected` map can arrive
  // non-monotonic (e.g. "channels" marked done before "topics"), which drew
  // checkmarks with gaps — a step 4 tick with step 3 still open. Derive a single
  // "frontier": the furthest section reached (current section or the last one
  // collected). Everything up to it reads done, the frontier is current, the rest
  // pending — so the row can never have a hole regardless of what the model sends.
  const curIdx = SECTION_KEYS.indexOf(progress.section);
  const collectedMax = SECTION_KEYS.reduce((m,k,i)=> progress.collected?.[k] ? i : m, -1);
  const frontier = Math.max(curIdx, collectedMax, 0);
  const isDone = i => i < frontier || (i === frontier && !!progress.collected?.[SECTION_KEYS[i]]);
  const isCur  = i => i === frontier && !isDone(i);
  // Mobile (C7): a six-dot row is cramped on a phone. Collapse to one clear
  // "Step N of 6 · Label" line plus a thin fill bar.
  if (compact) {
    const total = SECTION_KEYS.length;
    const doneCount = SECTION_KEYS.reduce((n,_,i)=> isDone(i)?n+1:n, 0);
    // Sections completed, which can only ever read 0/17/33/50/67/83/100.
    const sectionPct = Math.round((doneCount/total)*100);
    // The MODEL reports a finer percent every turn (measured live: 0, 5, 8, 12,
    // 15, 18, 22...). Using sectionPct alone discarded it, and since section 1
    // covers company, email, industry, goal AND the experience question, a client
    // could exchange six messages on a phone and watch the number sit on 17% the
    // whole time — which reads as "this thing is stuck". Desktop never showed a
    // percentage at all, so this only ever affected mobile, where most clients are.
    // sectionPct stays as a FLOOR so the number can never contradict the "Step N
    // of 6" label right beside it; the clamp keeps a malformed marker in range.
    const modelPct = Math.min(100, Math.max(0, Math.round(Number(progress.percent) || 0)));
    const pct = Math.max(sectionPct, modelPct);
    const label = L(SECTION_LABEL_KEYS[SECTION_KEYS[frontier]], lang) || "";
    return <div style={{width:"100%"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
        <span style={{fontSize:12,fontWeight:700,color:dark?"#c8d8e8":P}}>{L("stepN",lang,{n:frontier+1,total})}{label?" · ":""}<span style={{color:muted,fontWeight:600}}>{label}</span></span>
        <span style={{fontSize:11,color:muted}}>{pct}%</span>
      </div>
      <div style={{height:4,background:inactive,borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:F,borderRadius:2,transition:"width 0.4s"}}/></div>
    </div>;
  }
  return <div style={{display:"flex",alignItems:"flex-start",width:"100%"}}>{SECTION_KEYS.map((key,i) => {
    const done = isDone(i), cur = isCur(i);
    return <div key={key} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",position:"relative"}}>
      {i < SECTION_KEYS.length-1 && <div style={{position:"absolute",top:11,insetInlineStart:"50%",width:"100%",height:2,background:done?F:inactive,zIndex:0,transition:"background 0.4s"}}/>}
      <div style={{width:22,height:22,borderRadius:"50%",border:`2px solid ${done||cur?F:inactive}`,background:done?F:circleBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:done?"white":cur?F:muted,zIndex:1,transition:"all 0.3s",boxShadow:cur&&!done?`0 0 0 4px ${A}22`:"none"}}>{done?<span style={{display:"inline-flex",animation:REDUCE_MOTION?"none":"popIn .3s ease-out"}}>✓</span>:i+1}</div>
      {(!compact || cur) && <div style={{fontSize:10,marginTop:4,color:done||cur?P:muted,fontWeight:done||cur?600:400,whiteSpace:"nowrap"}}>{L(SECTION_LABEL_KEYS[key],lang)}</div>}
    </div>;
  })}</div>;
}

// The skip sentinel is a MARKER, not data. onWSkip records data:"__skip__" so the
// collapsed row can render "Skipped". If that string is ever handed back to a widget
// as initialData the render throws — UserForm does users.map(), ChipSelector does
// sel.filter(), and a string has neither — and because the throw happens during
// render, the error boundary in chat-main.jsx replaces the WHOLE app with the failure
// screen. Normalising it to undefined makes every widget fall through to its own
// fresh-state default, which is the correct meaning of "they skipped this".
export const SKIP = "__skip__";
export function widgetInitialData(ws) {
  const d = ws && typeof ws === "object" ? ws.data : undefined;
  return d === SKIP ? undefined : d;
}

// An @-prefixed single word in a quick-reply chip is an ACTION token (open the file
// picker), not an answer to send. The prompt tells the model to emit the literal
// @ATTACH and never translate it, but that is model obedience, not a guarantee — and
// it can only fail in a NON-ENGLISH session, which is exactly where nobody is looking.
// A French turn emitting @JOINDRE would otherwise render a nonsense text chip while
// the prose tells the client to use an attach button that never appeared, at STEP 2 of
// every guided flow. Quick replies are natural-language answers, so a lone @-word is
// never a legitimate option. \p{L} so non-Latin scripts match too.
// The chips that become a file-picker button: the documented @ATTACH plus the
// word for "attach" in each supported language.
//
// This is an ALLOWLIST rather than the old /^@[\p{L}_]+$/u for a reason on each
// side. Matching any @-word hijacked legitimate answers: the model offers social
// handles as chips at the channels step ("[SUGGESTIONS: @maisonverlaine | …]"),
// and every one of those turned into an "Attach a document" button, so the client
// could not pick their own handle at all. Matching ONLY @ATTACH would drop the
// safety net the loose form was really there for — the prompt says never to
// translate the token, but that is model obedience, not a guarantee, and it can
// only go wrong in a language nobody tests in. The allowlist keeps the net and
// stops the hijacking, because a brand handle colliding with the word "attach"
// in one of six languages is not a realistic case.
//
// Live French and Arabic sessions both emitted @ATTACH intact, so the
// translations below are insurance, not the common path.
const ATTACH_TOKENS = new Set([
  "@attach",
  "@joindre", "@attacher",                 // French
  "@anhängen", "@anhangen", "@anhang",     // German (with and without the umlaut)
  "@adjuntar", "@adjunta",                 // Spanish
  "@allegare", "@allega",                  // Italian
  "@إرفاق", "@أرفق",                        // Arabic
]);
export function isAttachToken(qr) {
  return ATTACH_TOKENS.has(String(qr == null ? "" : qr).trim().toLowerCase());
}

// Document language + text direction for a conversation language. Pure so it can be
// tested without a DOM; the effect in OnboardingApp applies it to documentElement.
export function docLangDir(uiLang) {
  return { lang: LOCALE_OF[uiLang] || "en", dir: RTL_LANGS.has(uiLang) ? "rtl" : "ltr" };
}

export function ChipSelector({ options, max=99, onSubmit, onSkip, placeholder, hint, initialData=[], lang }) {
  // Defence in depth for the above: never seed state with a non-array, whatever the
  // caller passes. sel.filter/sel.includes are load-bearing in this render.
  const [sel,setSel] = useState(Array.isArray(initialData) ? initialData : []);
  const [custom,setCustom] = useState("");
  const atLim = sel.length >= max;
  const toggle = o => { if (sel.includes(o)) setSel(s=>s.filter(x=>x!==o)); else if (!atLim) setSel(s=>[...s,o]); };
  const addC = () => { const v=custom.trim(); if (v&&!sel.includes(v)&&!atLim) { setSel(s=>[...s,v]); setCustom(""); } };
  return <div style={{marginTop:8}}>
    {hint && <div style={{fontSize:12,color:"#64748b",marginBottom:10}}>{hint}{max<99&&<span style={{marginLeft:6,background:"#ede9fe",color:P,borderRadius:6,padding:"1px 7px",fontSize:11,fontWeight:600}}>{WL("max",lang)} {max}</span>}</div>}
    <div role="group" style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>{options.map(o => <button key={o} onClick={()=>toggle(o)} disabled={atLim&&!sel.includes(o)} aria-pressed={sel.includes(o)} style={{padding:"9px 14px",minHeight:38,borderRadius:20,fontSize:12,cursor:atLim&&!sel.includes(o)?"default":"pointer",border:"1px solid",background:sel.includes(o)?P:"transparent",borderColor:sel.includes(o)?P:"#e2e8f0",color:sel.includes(o)?"white":atLim&&!sel.includes(o)?"#cbd5e1":"#64748b",transition:"all 0.15s"}}>{optLabel(o,lang)}</button>)}
    {/* Custom values (typed via Add) must be VISIBLE like any preset chip — before
        this, they went straight into `sel` but rendered nowhere: the input just
        cleared, with no way to spot a typo or remove the entry. Shown selected,
        with an explicit ✕ affordance (tapping removes, same as toggling off). */}
    {sel.filter(v=>!options.includes(v)).map(v => <button key={"custom-"+v} onClick={()=>toggle(v)} aria-pressed={true} aria-label={`${WL("removeItem",lang)}: ${v}`} style={{padding:"9px 14px",minHeight:38,borderRadius:20,fontSize:12,cursor:"pointer",border:`1px solid ${P}`,background:P,color:"white",transition:"all 0.15s",display:"inline-flex",alignItems:"center",gap:6}}>{v}<span aria-hidden="true" style={{opacity:0.75,fontSize:11}}>✕</span></button>)}</div>
    <div style={{display:"flex",gap:6,marginBottom:10}}>
      <input value={custom} onChange={e=>setCustom(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addC()} placeholder={placeholder||WL("customValue",lang)} style={{flex:1,background:"white",border:"1px solid #c4b5fd",borderRadius:8,padding:"7px 11px",fontSize:12,color:"#1e293b",outline:"none"}}/>
      <button onClick={addC} disabled={!custom.trim()||atLim} style={{background:custom.trim()&&!atLim?P:"#e2e8f0",color:"white",border:"none",borderRadius:8,padding:"7px 14px",cursor:custom.trim()&&!atLim?"pointer":"default",fontSize:12,fontWeight:600}}>{WL("add",lang)}</button>
    </div>
    {max<99 && <div style={{fontSize:11,color:atLim?"#dc2626":"#64748b",marginBottom:10}}>{sel.length}/{max} {WL("selected",lang)}{atLim?" — "+WL("limitReached",lang):""}</div>}
    <div style={{display:"flex",gap:8}}>
      <button onClick={()=>sel.length>0&&onSubmit(sel)} disabled={sel.length===0} style={{background:sel.length>0?P:"#e2e8f0",color:"white",border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,cursor:sel.length>0?"pointer":"default"}}>{WL("confirm",lang)}</button>
      {onSkip && <button onClick={onSkip} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 16px",fontSize:13,color:"#64748b",cursor:"pointer"}}>{WL("skip",lang)}</button>}
    </div>
  </div>;
}

export function RankedSelector({ options, max=3, onSubmit, onSkip, hint, initialData, lang }) {
  const init = normObjectives(initialData);
  const [sel,setSel]       = useState(init.ranked);
  const [details,setDetails]= useState(init.details);
  const [custom,setCustom] = useState("");
  const atLim = sel.length >= max;
  const toggle = o => { if (sel.includes(o)) setSel(s=>s.filter(x=>x!==o)); else if (!atLim) setSel(s=>[...s,o]); };
  const move   = (i,dir) => setSel(s => { const n=[...s], j=i+dir; if (j<0||j>=n.length) return s; [n[i],n[j]]=[n[j],n[i]]; return n; });
  const addC   = () => { const v=custom.trim(); if (v&&!sel.includes(v)&&!atLim) { setSel(s=>[...s,v]); setCustom(""); } };
  return <div style={{marginTop:8}}>
    {hint && <div style={{fontSize:12,color:"#64748b",marginBottom:10}}>{hint}<span style={{marginLeft:6,background:"#ede9fe",color:P,borderRadius:6,padding:"1px 7px",fontSize:11,fontWeight:600}}>{WL("max",lang)} {max}</span></div>}
    <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>{options.map(o => <button key={o} onClick={()=>toggle(o)} disabled={atLim&&!sel.includes(o)} aria-pressed={sel.includes(o)} style={{padding:"9px 14px",minHeight:38,borderRadius:20,fontSize:12,cursor:atLim&&!sel.includes(o)?"default":"pointer",border:"1px solid",background:sel.includes(o)?P:"transparent",borderColor:sel.includes(o)?P:"#e2e8f0",color:sel.includes(o)?"white":atLim&&!sel.includes(o)?"#cbd5e1":"#64748b",transition:"all 0.15s"}}>{optLabel(o,lang)}</button>)}</div>
    <div style={{display:"flex",gap:6,marginBottom:10}}>
      <input value={custom} onChange={e=>setCustom(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addC()} placeholder={WL("somethingElse",lang)} style={{flex:1,background:"white",border:"1px solid #c4b5fd",borderRadius:8,padding:"7px 11px",fontSize:12,color:"#1e293b",outline:"none"}}/>
      <button onClick={addC} disabled={!custom.trim()||atLim} style={{background:custom.trim()&&!atLim?P:"#e2e8f0",color:"white",border:"none",borderRadius:8,padding:"7px 14px",cursor:custom.trim()&&!atLim?"pointer":"default",fontSize:12,fontWeight:600}}>{WL("add",lang)}</button>
    </div>
    {sel.length>0 && <div style={{background:"#f8f9fa",border:"1px solid #e2e8f0",borderRadius:10,padding:"10px 12px",marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:700,color:"#64748b",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.04em"}}>{WL("prioritiesHdr",lang)}</div>
      {sel.map((o,i) => <div key={o} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",margin:"0 -4px",borderRadius:8,borderTop:i>0?"1px solid #eef1f5":"none",background:i===0?`${A}12`:"transparent"}}>
        <span style={{width:22,height:22,borderRadius:"50%",background:i===0?A:P,color:"white",fontSize:11,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</span>
        <span style={{flex:1,fontSize:13,color:"#1e293b",fontWeight:i===0?700:400}}>{optLabel(o,lang)}</span>
        <button onClick={()=>move(i,-1)} disabled={i===0} aria-label={`${WL("moveUp",lang)}: ${optLabel(o,lang)}`} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,width:38,height:38,cursor:i===0?"default":"pointer",color:i===0?"#cbd5e1":"#64748b",fontSize:13,lineHeight:1,flexShrink:0}}>▲</button>
        <button onClick={()=>move(i,1)} disabled={i===sel.length-1} aria-label={`${WL("moveDown",lang)}: ${optLabel(o,lang)}`} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,width:38,height:38,cursor:i===sel.length-1?"default":"pointer",color:i===sel.length-1?"#cbd5e1":"#64748b",fontSize:13,lineHeight:1,flexShrink:0}}>▼</button>
        <button onClick={()=>toggle(o)} aria-label={`${WL("removeItem",lang)}: ${optLabel(o,lang)}`} style={{background:"transparent",border:"1px solid transparent",borderRadius:8,width:38,height:38,color:"#ef4444",cursor:"pointer",fontSize:14,flexShrink:0}}>✕</button>
      </div>)}
    </div>}
    <textarea value={details} onChange={e=>setDetails(e.target.value)} rows={2} placeholder={WL("objDetailsPh",lang)} style={{width:"100%",background:"white",border:"1px solid #e2e8f0",borderRadius:8,padding:"7px 11px",fontSize:12,color:"#1e293b",outline:"none",resize:"vertical",boxSizing:"border-box",marginBottom:10}}/>
    <div style={{fontSize:11,color:atLim?"#dc2626":"#64748b",marginBottom:10}}>{sel.length}/{max} {WL("selected",lang)}{atLim?" — "+WL("limitReached",lang):""}</div>
    <div style={{display:"flex",gap:8}}>
      <button onClick={()=>sel.length>0&&onSubmit({ranked:sel,details:details.trim()})} disabled={sel.length===0} style={{background:sel.length>0?P:"#e2e8f0",color:"white",border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,cursor:sel.length>0?"pointer":"default"}}>{WL("confirmPriorities",lang)}</button>
      {onSkip && <button onClick={onSkip} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 16px",fontSize:13,color:"#64748b",cursor:"pointer"}}>{WL("skip",lang)}</button>}
    </div>
  </div>;
}

function UserForm({ onSubmit, onSkip, initialData=[], lang }) {
  const empty = () => ({ firstName:"", lastName:"", email:"", role:"", access:"Full Tool" });
  // Array guard, not just a length check: a non-array with a truthy .length (a
  // string) would seed state and then throw on users.map() below. See widgetInitialData.
  const seedRows = Array.isArray(initialData) ? initialData : [];
  const [users,setUsers] = useState(seedRows.length>0?seedRows:[empty()]);
  const [errors,setErrors] = useState({});
  const upd = (i,k,v) => setUsers(u=>u.map((x,j)=>j===i?{...x,[k]:v}:x));
  const vEmail = (i,v) => setErrors(e=>({...e,[`${i}-email`]:v&&!EMAIL_RE.test(v)?WL("invalidEmail",lang):""}));
  // Ignore fully-empty rows so a trailing blank "+ Add user" row can't permanently
  // disable Confirm with no way to clear it; require >=1 filled row and that every
  // filled row is valid. Submit only the filled rows.
  const filled = users.filter(u=>u.firstName||u.lastName||u.email||u.role);
  const valid = filled.length>0 && filled.every(u=>u.firstName&&u.email&&EMAIL_RE.test(u.email));
  // Flag a missing first name only once the row is otherwise in use — an untouched
  // empty row shouldn't glow red, but a filled-in row missing its one required
  // name field should say so instead of just greying out Confirm.
  const nameMissing = (u) => !u.firstName && !!(u.lastName||u.email||u.role);
  return <div style={{marginTop:8}}>
    {users.map((u,i) => <div key={i} style={{background:"#f8f9fa",border:"1px solid #e2e8f0",borderRadius:10,padding:"12px 14px",marginBottom:8}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8,marginBottom:8}}>
        {[["firstName",WL("firstName",lang)],["lastName",WL("lastName",lang)],["role",WL("roleDept",lang)]].map(([k,ph]) => <input key={k} value={u[k]} onChange={e=>upd(i,k,e.target.value)} placeholder={ph} aria-label={ph} style={{background:"white",border:`1px solid ${k==="firstName"&&nameMissing(u)?"#ef4444":"#e2e8f0"}`,borderRadius:7,padding:"7px 10px",fontSize:12,color:"#1e293b",outline:"none"}}/>)}
        <div>
          {/* Re-validate on change too (not only blur): a client who types an email
              and reaches straight for Confirm never blurs, so the old blur-only
              check left the button dead with zero visible explanation. */}
          <input value={u.email} onChange={e=>{upd(i,"email",e.target.value);if(errors[`${i}-email`])vEmail(i,e.target.value);}} onBlur={e=>vEmail(i,e.target.value)} placeholder={WL("email",lang)} aria-label={WL("email",lang)} style={{background:"white",border:`1px solid ${errors[`${i}-email`]?"#ef4444":"#e2e8f0"}`,borderRadius:7,padding:"7px 10px",fontSize:12,color:"#1e293b",outline:"none",width:"100%"}}/>
          {errors[`${i}-email`] && <div style={{fontSize:10,color:"#ef4444",marginTop:3}}>{errors[`${i}-email`]}</div>}
        </div>
      </div>
      <div style={{display:"flex",gap:6,alignItems:"center"}}>{["Admin","Full Tool","Read-Only"].map(a => <button key={a} onClick={()=>upd(i,"access",a)} aria-pressed={u.access===a} style={{flex:1,padding:"6px 8px",borderRadius:7,fontSize:11,cursor:"pointer",border:"1px solid",background:u.access===a?P:"transparent",borderColor:u.access===a?P:"#e2e8f0",color:u.access===a?"white":"#64748b"}}>{a}</button>)}
        {/* Remove a row. The fully-empty guard above already stops an untouched extra row
            from blocking Confirm, but a row the client STARTED and thought better of does
            count as filled: it then failed validation with no way to get rid of it, so
            Confirm sat dead until they hunted down and blanked each field by hand. The
            review modal has always had this control on its user rows; the widget did not.
            Hidden at one row, since there must always be someone to add details to. */}
        {users.length>1 && <button onClick={()=>{setUsers(us=>us.filter((_,j)=>j!==i)); setErrors({});}}
          aria-label={L("expRemoveUser",lang,{name:u.firstName||u.email||i+1})}
          title={L("expRemoveUser",lang,{name:u.firstName||u.email||i+1})}
          style={{flexShrink:0,background:"transparent",border:"none",color:"#ef4444",cursor:"pointer",fontSize:13,padding:"6px 8px",lineHeight:1}}>✕</button>}
      </div>
    </div>)}
    {/* The reason Confirm is disabled, stated next to it — a grey button with a
        silent why strands non-technical clients (tooltips don't exist on touch). */}
    {!valid && <div style={{fontSize:11,color:"#92400e",marginTop:6}}>{WL("confirmUsersHint",lang)}</div>}
    <div style={{display:"flex",gap:8,marginTop:4}}>
      <button onClick={()=>setUsers(u=>[...u,empty()])} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,padding:"7px 14px",color:"#64748b",cursor:"pointer",fontSize:12}}>{WL("addUser",lang)}</button>
      <button onClick={()=>valid&&onSubmit(filled)} disabled={!valid} style={{background:valid?P:"#e2e8f0",color:"white",border:"none",borderRadius:8,padding:"7px 20px",fontSize:13,fontWeight:600,cursor:valid?"pointer":"default"}}>{WL("confirmUsers",lang)}</button>
      {onSkip && <button onClick={onSkip} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,padding:"7px 16px",fontSize:13,color:"#64748b",cursor:"pointer"}}>{WL("skip",lang)}</button>}
    </div>
  </div>;
}

function TopicCards({ suggestions, initialData, onConfirm, onSkip, lang }) {
  // Suggested topics default to KEPT (they were proposed for this client for a
  // reason): the client reviews and discards, rather than opting in to each card.
  // The old default ("pending") made Confirm start disabled at "(0)" and silently
  // dropped every card the client agreed with but never explicitly ticked.
  //
  // A previous confirmation WINS over the model's suggestions. Re-seeding from
  // `suggestions` on every mount threw away the client's own edits the moment they
  // reopened the widget via Edit. Only the kept cards are stored on confirm, so
  // anything the client discarded correctly stays discarded on reopen too.
  const seed = Array.isArray(initialData) && initialData.length ? initialData : suggestions;
  const [cards,setCards] = useState(seed.map(s=>({...s,status:s.status||"kept",id:Math.random().toString(36).substr(2,9)})));
  const [dragIdx,setDragIdx] = useState(null);
  const upd  = (i,f,v) => setCards(c=>c.map((x,j)=>j===i?{...x,[f]:v}:x));
  const setSt = (i,s) => setCards(c=>c.map((x,j)=>j===i?{...x,status:s}:x));
  // Native HTML5 drag does not fire on touch, so give a tap-friendly reorder too.
  const move = (i,dir) => setCards(c=>{ const n=[...c], j=i+dir; if (j<0||j>=n.length) return c; [n[i],n[j]]=[n[j],n[i]]; return n; });
  const isTouch = typeof window !== "undefined" && ("ontouchstart" in window || (navigator.maxTouchPoints||0) > 0);
  const kept = cards.filter(c=>c.status==="kept");
  return <div style={{marginTop:8}}>
    <div style={{fontSize:12,color:"#64748b",marginBottom:6}}>{WL("topicHint",lang)}</div>
    <div style={{fontSize:11,color:"#64748b",marginBottom:10,display:"flex",justifyContent:"space-between"}}>
      <span>{kept.length} {WL("kept",lang)} · {cards.filter(c=>c.status==="discarded").length} {WL("discarded",lang)}</span>
      {!isTouch && <span>☰ {WL("dragPrioritize",lang)}</span>}
    </div>
    {cards.map((c,i) => <div key={c.id} draggable
      onDragStart={e=>{setDragIdx(i);e.dataTransfer.effectAllowed="move";}}
      onDragOver={e=>e.preventDefault()}
      onDrop={e=>{e.preventDefault();if(dragIdx===null||dragIdx===i)return;const nc=[...cards];const[dc]=nc.splice(dragIdx,1);nc.splice(i,0,dc);setCards(nc);setDragIdx(null);}}
      style={{background:c.status==="kept"?"#f0fdf4":c.status==="discarded"?"#fef2f2":"#f8f9fa",border:`1px solid ${c.status==="kept"?"#bbf7d0":c.status==="discarded"?"#fecaca":"#e2e8f0"}`,borderRadius:10,padding:"12px 14px",marginBottom:8,opacity:c.status==="discarded"?0.5:1,display:"flex",alignItems:"center",gap:8}}>
      <div style={{cursor:"grab",padding:"0 8px",color:"#64748b",userSelect:"none"}}>☰</div>
      <div style={{flex:1}}>
        <input value={c.name} onChange={e=>upd(i,"name",e.target.value)} disabled={c.status==="discarded"} placeholder={WL("topicName",lang)} style={{background:"transparent",border:"none",borderBottom:"1px solid #e2e8f0",color:"#1e293b",fontSize:13,fontWeight:600,width:"100%",outline:"none",padding:"2px 0",marginBottom:6}}/>
        <input value={c.keywords} onChange={e=>upd(i,"keywords",e.target.value)} placeholder={WL("keywordsPh",lang)} disabled={c.status==="discarded"} style={{background:"transparent",border:"none",borderBottom:"1px solid #e2e8f0",color:"#1e293b",fontSize:12,width:"100%",outline:"none",padding:"2px 0",marginBottom:6}}/>
        <div style={{fontSize:11,color:"#64748b",fontStyle:"italic"}}>{c.rationale}</div>
      </div>
      <div style={{display:"flex",gap:6,flexShrink:0}}>
        <button onClick={()=>move(i,-1)} disabled={i===0} aria-label="Move topic up" style={{width:32,height:32,borderRadius:8,border:"1px solid #e2e8f0",background:"transparent",color:i===0?"#cbd5e1":"#64748b",cursor:i===0?"default":"pointer",fontSize:12}}>▲</button>
        <button onClick={()=>move(i,1)} disabled={i===cards.length-1} aria-label="Move topic down" style={{width:32,height:32,borderRadius:8,border:"1px solid #e2e8f0",background:"transparent",color:i===cards.length-1?"#cbd5e1":"#64748b",cursor:i===cards.length-1?"default":"pointer",fontSize:12}}>▼</button>
        {/* ✓/✕ SET a state rather than toggling through a third "pending" limbo:
            with default-kept there are only two outcomes (kept / discarded), which
            is also exactly what Confirm submits — no card can silently vanish. */}
        <button onClick={()=>setSt(i,"kept")} aria-pressed={c.status==="kept"} aria-label={`Keep topic ${c.name||i+1}`} style={{width:32,height:32,borderRadius:8,border:`1px solid ${c.status==="kept"?"#bbf7d0":"#e2e8f0"}`,background:c.status==="kept"?"#dcfce7":"transparent",color:c.status==="kept"?"#166534":"#64748b",cursor:"pointer",fontSize:16}}>✓</button>
        <button onClick={()=>setSt(i,c.status==="discarded"?"kept":"discarded")} aria-pressed={c.status==="discarded"} aria-label={`Discard topic ${c.name||i+1}`} style={{width:32,height:32,borderRadius:8,border:`1px solid ${c.status==="discarded"?"#fecaca":"#e2e8f0"}`,background:c.status==="discarded"?"#fee2e2":"transparent",color:c.status==="discarded"?"#991b1b":"#64748b",cursor:"pointer",fontSize:16}}>✕</button>
      </div>
    </div>)}
    <div style={{display:"flex",gap:8,marginTop:4}}>
      <button onClick={()=>kept.length>0&&onConfirm(kept)} disabled={kept.length===0} style={{background:kept.length>0?P:"#e2e8f0",color:"white",border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,cursor:kept.length>0?"pointer":"default"}}>{WL("confirm",lang)} ({kept.length})</button>
      <button onClick={onSkip} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 16px",fontSize:13,color:"#64748b",cursor:"pointer"}}>{WL("skip",lang)}</button>
    </div>
  </div>;
}

// Query import limits: extracted file text lands in the API context on submit,
// so cap it before one big agency export blows up the conversation. Sized to the
// server's 80k-char queries cap (session.js): a full old-tool export of hundreds
// of Boolean queries now imports whole instead of being clipped to ~200 lines
// (which is what truncated a real migration to a couple of queries). Migrated
// queries are the client's verbatim reference for the consultant, so keep them
// generously; the 80k server cap is the real backstop.
const Q_MAX_LINES = 1000, Q_MAX_CHARS = 60000, Q_MAX_FILE_BYTES = 2 * 1024 * 1024;
// Spreadsheet read bounds. See the clamp in extractFileText: these cap the range
// sheet_to_json is allowed to walk, so a workbook whose declared used range has been
// stretched past its real data cannot materialise millions of cells on the main
// thread (XLSX.read is synchronous — an unbounded walk hard-freezes the tab).
//
// Sized from measurement, not taste. sheet_to_json fills every cell in range because
// of defval:"", so cost is rows x cols: 20000x200 (4M cells) still cost ~1.5s, while
// 5000x100 (500k cells) is ~0.2s. Both are far above what survives downstream —
// capQueryText keeps 1000 lines and the attach path 48k chars — so the smaller bound
// costs no real content and keeps the worst case imperceptible.
const XLSX_MAX_ROWS = 5000, XLSX_MAX_COLS = 100;
function capQueryText(t) {
  let lines = t.split("\n").map(l=>l.trim()).filter(Boolean);
  let truncated = false;
  if (lines.length > Q_MAX_LINES) { lines = lines.slice(0, Q_MAX_LINES); truncated = true; }
  let out = lines.join("\n");
  if (out.length > Q_MAX_CHARS) { out = out.slice(0, Q_MAX_CHARS); out = out.slice(0, out.lastIndexOf("\n") > 0 ? out.lastIndexOf("\n") : out.length); truncated = true; }
  return { text: out, truncated };
}
// DOCX text extraction, zero-dependency. A .docx is a ZIP; the body text lives in
// word/document.xml. We read that one entry via the ZIP central directory (which
// carries the authoritative compressed size, so a data-descriptor docx still
// works), inflate it with the browser-native DecompressionStream, and strip the
// XML to plain text. Only .docx (the modern zip format), never legacy .doc.
// Cap the decompressed XML we keep. This bounds BOTH a zip bomb (tiny file
// inflating huge) AND main-thread work. Downstream we keep up to Q_MAX_CHARS
// (~60k) of text for the queries widget, or ATTACH_MAX_CHARS (~48k) for an
// attached requirements doc; a .docx carries roughly 4-8x that in XML tags, so
// 4MB is enough to yield a full multi-page doc's text without clipping it before
// the char caps do. On exceeding it we take a bounded PREFIX (stop inflating,
// cancel the stream) rather than throw — a very large doc still imports its first
// chunk. Runs once per import, off the hot path, so 4MB through the regex is fine.
const DOCX_MAX_XML = 4 * 1024 * 1024;
async function inflateRawBounded(bytes, maxBytes) {
  const reader = new Response(bytes).body.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.length >= room) { chunks.push(value.subarray(0, room)); total = maxBytes; reader.cancel(); break; }
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total); let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
function docxXmlToText(xml) {
  return xml
    .replace(/<w:tab[^>]*\/?>/g, "\t")
    .replace(/<w:br[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")   // paragraph end -> line break
    .replace(/<[^>]+>/g, "")     // drop every remaining tag; <w:t> contents are the text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ""; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; } })
    .replace(/&amp;/g, "&");      // decode ampersand LAST so &amp;lt; -> &lt; not <
}
async function docxToText(buf) {
  const bytes = new Uint8Array(buf), dv = new DataView(buf);
  // Locate the End Of Central Directory record (scan the tail for its signature).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("docx: not a valid zip");
  const cdCount = dv.getUint16(eocd + 10, true), cdOffset = dv.getUint32(eocd + 16, true);
  let p = cdOffset, target = null;
  for (let n = 0; n < cdCount && p + 46 <= bytes.length; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), compSize = dv.getUint32(p + 20, true),
          uncompSize = dv.getUint32(p + 24, true), fnLen = dv.getUint16(p + 28, true),
          extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true),
          localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + fnLen));
    if (name === "word/document.xml") { target = { method, compSize, uncompSize, localOff }; break; }
    p += 46 + fnLen + extraLen + commentLen;
  }
  if (!target) throw new Error("docx: no word/document.xml");
  if (dv.getUint32(target.localOff, true) !== 0x04034b50) throw new Error("docx: bad local header");
  const dataStart = target.localOff + 30 + dv.getUint16(target.localOff + 26, true) + dv.getUint16(target.localOff + 28, true);
  const comp = bytes.subarray(dataStart, dataStart + target.compSize);
  let xmlBytes;
  if (target.method === 0) xmlBytes = comp.subarray(0, DOCX_MAX_XML);         // stored — take a bounded prefix
  else if (target.method === 8) xmlBytes = await inflateRawBounded(comp, DOCX_MAX_XML); // deflate — stops at the cap
  else throw new Error("docx: unsupported compression");
  return docxXmlToText(new TextDecoder("utf-8").decode(xmlBytes));
}

// Shared file -> text extraction (xlsx/xls, docx, txt/csv). Returns { text } on
// success or { error, mb? } with a QN message key. The caller applies its own
// size cap. Used by BOTH the QUERIES widget and the composer attach affordance,
// so the two can't drift.
export async function extractFileText(file) {
  // Guard before reading: XLSX.read / file.text() load the whole file into
  // memory, so a huge file freezes the tab before any downstream cap applies.
  if (file.size > Q_MAX_FILE_BYTES) return { error: "tooLarge", mb: (file.size / 1048576).toFixed(1) };
  try {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (ext === "xlsx" || ext === "xls") {
      const buf = await file.arrayBuffer();
      // Every real .xlsx is a ZIP, so it starts with the local-file-header magic
      // "PK\x03\x04". Check it before handing the bytes to XLSX.read, which does
      // NOT throw on junk — it sniffs unknown input as text and returns the raw
      // characters as a one-cell sheet. Without this a truncated download or a
      // file renamed from .pdf reported a successful import, the client was told
      // "Imported <file>", and control characters were sent to the model as their
      // requirements document. Legacy .xls is exempt: it is OLE2, not a ZIP.
      if (ext === "xlsx") {
        const sig = new Uint8Array(buf.slice(0, 4));
        if (!(sig[0] === 0x50 && sig[1] === 0x4b && sig[2] === 0x03 && sig[3] === 0x04)) {
          return { error: "readError" };
        }
      }
      let XLSX;
      try { XLSX = await loadXLSX(); }
      catch (e) {
        // The xlsx parser is a lazily-imported, content-hashed chunk. A client whose
        // tab predates a redeploy requests a filename that no longer exists, so this
        // rejects for a reason that has nothing to do with their file. Report it as
        // its own case ("reload the page") instead of the generic read error, which
        // would send them off retrying different documents and never refreshing.
        console.error("xlsx chunk failed to load (stale deploy?):", e);
        return { error: "staleVersion" };
      }
      const wb = XLSX.read(buf, { type: "array" });
      const rows = [];
      wb.SheetNames.forEach(sn => {
        const ws = wb.Sheets[sn];
        if (!ws || !ws["!ref"]) return;
        // Clamp the DECLARED used range before materialising it. sheet_to_json walks
        // whatever !ref claims, and !ref is routinely stretched far past the real data
        // (applying formatting to a whole column is enough to push it to row 1048576).
        // Unclamped, that builds millions of rows — and XLSX.read is synchronous, so
        // the tab hard-freezes with the spinner stuck and no way to cancel.
        // The ceilings sit an order of magnitude above what survives downstream anyway
        // (capQueryText keeps 1000 lines, the attach path 48k chars), so no real
        // content is lost. Mirrors the bound the .docx path already applies.
        let range;
        try {
          const r = XLSX.utils.decode_range(ws["!ref"]);
          range = { s: { r: r.s.r, c: r.s.c }, e: {
            r: Math.min(r.e.r, r.s.r + XLSX_MAX_ROWS - 1),
            c: Math.min(r.e.c, r.s.c + XLSX_MAX_COLS - 1) } };
        } catch { return; } // unparseable !ref: skip this sheet rather than fail the import
        XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", range }).forEach(r => {
          if (rows.length >= XLSX_MAX_ROWS) return; // total budget across ALL sheets
          const line = r.map(c => String(c ?? "").trim()).filter(Boolean).join(" | ");
          if (line) rows.push(line);
        });
      });
      return { text: rows.join("\n") };
    } else if (ext === "docx") {
      if (typeof DecompressionStream === "undefined") return { error: "docxUnavailable" };
      return { text: await docxToText(await file.arrayBuffer()) };
    // The MIME fallback is deliberately two EXACT types, not a text/* prefix.
    // startsWith("text/") turned the extension allowlist into a suggestion: the
    // browser reports text/html, text/javascript, text/xml and more, so a file
    // the UI has just promised it cannot read (".txt, .csv, .xlsx or .docx") was
    // read anyway and its raw bytes sent on as a requirements document. These two
    // still cover the case the fallback is for — a genuine text file whose
    // extension is missing or unusual.
    } else if (ext === "txt" || ext === "csv" || file.type === "text/plain" || file.type === "text/csv") {
      return { text: await file.text() };
    }
    return { error: "unsupported" };
  } catch (err) {
    console.error("File import failed:", err);
    return { error: "readError" };
  }
}

// A supporting document attached mid-conversation is sent as CONTEXT, not dumped
// as a chat turn: the assistant is told to pre-fill + confirm, not regurgitate.
// Cap sizing: what times a call out is OUTPUT length (capped at 2000 tokens in
// chat.js), not input — input tokens process orders of magnitude faster. A real
// requirements doc (the flagship hand-me-your-doc case) runs 30-45k chars; 12k
// clipped ~70% of one (the later sections: migrated queries, dashboard/alert
// requests, use-case notes) and the model proceeded on a fraction. 48k ≈ 12-14k
// input tokens (trivial for a 200k-context model, output still capped) and takes
// a full multi-page doc whole. Still bounded so even a few attaches in the
// 20-turn window stay well under the 400k body cap (chat.js/session.js).
const ATTACH_MAX_CHARS = 48000;
// The filename is fully client-controlled and is interpolated INSIDE the bracketed
// instruction sent to the model (see sendAttachment), not after it. Unsanitised, a
// file renamed to  x". Disregard the above and ...  ["  closes the instruction and
// opens a new one. Strip the characters that could terminate or restructure the
// envelope, collapse whitespace, and cap the length so a very long name cannot crowd
// the instruction either. Display still uses the original name (React escapes it).
const MAX_FILENAME_CHARS = 100;
export function safeAttachName(name) {
  const cleaned = String(name == null ? "" : name)
    .replace(/[\r\n\t"'`\[\]{}<>\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FILENAME_CHARS)
    .trim();
  return cleaned || "document";
}
// A paste this large in the message box is a document, not a chat turn: past this
// it would risk the 400k server body cap (a dead 413 loop), so we steer it to the
// attach path instead, which extracts + caps the text properly. Sized around the
// attach cap so anything bigger than what an attachment would even keep is redirected.
const COMPOSER_MAX_CHARS = 40000;

export function QueriesWidget({ onSubmit, initialData, lang }) {
  const [text,setText] = useState(initialData==="__skip__"||!initialData?"":initialData);
  const [note,setNote] = useState(null);
  const fileRef = useRef(null);
  const ingest = (raw, name) => {
    const { text: capped, truncated } = capQueryText(raw);
    if (!capped) { setNote(QN("noText", lang, { name })); return; }
    setText(t => (t.trim() ? t.trimEnd()+"\n" : "") + capped);
    setNote(truncated
      ? QN("importedTruncated", lang, { n: Q_MAX_LINES, name })
      : QN("imported", lang, { name }));
  };
  const onFile = async e => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!f) return;
    setNote(null);
    const r = await extractFileText(f);
    if (r.error) { setNote(QN(r.error, lang, { name: f.name, mb: r.mb })); return; }
    ingest(r.text, f.name);
  };
  return <div style={{marginTop:8}}>
    <textarea value={text} onChange={e=>setText(e.target.value)} placeholder={WL("pasteQueries",lang)} rows={4} style={{width:"100%",background:"#f8f9fa",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 12px",fontSize:12,color:"#1e293b",outline:"none",resize:"vertical",boxSizing:"border-box"}}/>
    <input ref={fileRef} type="file" accept=".txt,.csv,.xlsx,.xls,.docx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={onFile} style={{display:"none"}} aria-hidden="true"/>
    {note && <div style={{fontSize:11,color:"#92400e",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:7,padding:"6px 10px",marginTop:6}}>{note}</div>}
    <div style={{display:"flex",gap:8,marginTop:8,alignItems:"center",flexWrap:"wrap"}}>
      <button onClick={()=>text.trim()&&onSubmit(text.trim())} disabled={!text.trim()} style={{background:text.trim()?P:"#e2e8f0",color:"white",border:"none",borderRadius:8,padding:"8px 20px",fontSize:13,fontWeight:600,cursor:text.trim()?"pointer":"default"}}>{WL("submitQueries",lang)}</button>
      {/* "No queries" is disabled once the box has content, mirroring Submit being
          disabled while it is empty: exactly one of the two applies at any moment.
          It used to discard whatever was pasted, with no confirmation and no undo —
          and this widget is the ONLY path that preserves a client's original query
          syntax verbatim, so that text is the one thing here that cannot be
          reconstructed later. Clearing the box re-enables it. */}
      <button onClick={()=>!text.trim()&&onSubmit("__skip__")} disabled={!!text.trim()} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 16px",fontSize:13,color:text.trim()?"#cbd5e1":"#64748b",cursor:text.trim()?"default":"pointer"}}>{WL("noQueries",lang)}</button>
      <button onClick={()=>fileRef.current?.click()} style={{display:"inline-flex",alignItems:"center",gap:6,background:"transparent",border:"none",color:LINK,fontSize:12,cursor:"pointer",padding:"8px 4px"}}><Ic d={IC.clip} size={12}/><span style={{textDecoration:"underline"}}>{WL("importFile",lang)}</span></button>
    </div>
  </div>;
}

function Section({ title, badge, defaultOpen=true, children }) {
  const [open,setOpen] = useState(defaultOpen);
  // h3-wrapped toggle: the review modal is a long five-section form, and headings
  // are how screen-reader users jump between sections (rotor navigation). A button
  // inside a heading is valid HTML and keeps the exact same visuals.
  return <div style={{marginBottom:18}}>
    <h3 style={{margin:0}}>
      <button onClick={()=>setOpen(o=>!o)} aria-expanded={open} style={{display:"flex",alignItems:"center",justifyContent:"space-between",width:"100%",background:"transparent",border:"none",cursor:"pointer",padding:"0 0 6px",borderBottom:`2px solid ${P}20`,marginBottom:open?12:0,font:"inherit"}}>
        <span style={{fontSize:12,fontWeight:700,color:P,textTransform:"uppercase",letterSpacing:"0.06em"}}>{title}{badge!=null && <span style={{marginLeft:8,fontSize:10,fontWeight:600,color:"#64748b",background:"#f1f5f9",borderRadius:8,padding:"1px 7px",textTransform:"none",letterSpacing:0}}>{badge}</span>}</span>
        <span aria-hidden="true" style={{fontSize:11,color:"#64748b",transform:open?"rotate(90deg)":"none",transition:"transform 0.15s",display:"inline-block"}}>▶</span>
      </button>
    </h3>
    {open && children}
  </div>;
}

// Bulk import for clients who arrive with a prepared list (e.g. an offline
// template). One item per line; topics support "name | keywords | rationale".
function PasteImport({ label, placeholder, onImport, lang }) {
  const [open,setOpen] = useState(false);
  const [text,setText] = useState("");
  const run = () => {
    const lines = text.split("\n").map(l=>l.trim()).filter(Boolean);
    if (lines.length) onImport(lines);
    setText(""); setOpen(false);
  };
  if (!open) return <button onClick={()=>setOpen(true)} style={{background:"transparent",border:"none",color:LINK,fontSize:12,cursor:"pointer",padding:"6px 0",textDecoration:"underline",marginLeft:10}}>{label}</button>;
  return <div style={{border:`1px solid ${LINK}`,borderRadius:8,padding:"10px 12px",margin:"8px 0",background:"#faf8ff"}}>
    <div style={{fontSize:11,color:"#64748b",marginBottom:6}}>{placeholder}</div>
    <textarea value={text} onChange={e=>setText(e.target.value)} rows={5} style={{width:"100%",border:"1px solid #e2e8f0",borderRadius:7,padding:"7px 10px",fontSize:12,color:"#1e293b",outline:"none",resize:"vertical",boxSizing:"border-box",marginBottom:8}}/>
    <div style={{display:"flex",gap:8}}>
      <button onClick={run} disabled={!text.trim()} style={{background:text.trim()?P:"#e2e8f0",color:"white",border:"none",borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:text.trim()?"pointer":"default"}}>{L("expImport",lang)}</button>
      <button onClick={()=>{setText("");setOpen(false);}} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:7,padding:"6px 12px",fontSize:12,color:"#64748b",cursor:"pointer"}}>{L("expCancel",lang)}</button>
    </div>
  </div>;
}
const URL_RE = /https?:\/\/[^\s|,]+/;
function guessChanType(url) {
  const u = (url||"").toLowerCase();
  if (u.includes("twitter.")||u.includes("x.com")) return "Twitter/X";
  if (u.includes("linkedin.")) return "LinkedIn";
  if (u.includes("instagram.")) return "Instagram";
  if (u.includes("facebook.")) return "Facebook";
  if (u.includes("youtube.")) return "YouTube";
  if (u.includes("tiktok.")) return "TikTok";
  return "";
}
const GUESS_RE = /suggested by assistant|please verify/i;
const isGuess = tp => GUESS_RE.test(tp?.comments||"") || GUESS_RE.test(tp?.rationale||"");

// Error boundary around the review modal: if anything inside throws, show a
// recoverable message instead of React silently unmounting to a blank screen.
class ModalBoundary extends Component {
  constructor(props){ super(props); this.state={err:null}; }
  static getDerivedStateFromError(err){ return {err}; }
  componentDidCatch(err,info){ console.error("Review modal crashed:",err,info); }
  render(){
    if (!this.state.err) return this.props.children;
    return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16}}>
      <div style={{background:"white",borderRadius:16,maxWidth:440,padding:"28px 28px 22px",boxShadow:"0 16px 48px rgba(0,0,0,0.2)",textAlign:"center"}}>
        <div style={{fontSize:28,marginBottom:10}}>⚠️</div>
        <div style={{fontWeight:700,fontSize:15,color:"#1e293b",marginBottom:8}}>Something went wrong opening your brief</div>
        <div style={{fontSize:12,color:"#64748b",marginBottom:16}}>Your answers are safe. Close this and try again — if it happens twice, let your Lumen contact know.</div>
        {/* J7: the raw technical error is for developers, not the client — a
            "TypeError: ..." string in front of an enterprise buyer erodes trust.
            Show it only in DEV; clients see just the reassuring line above. */}
        {DEV && <div style={{fontSize:10,color:"#64748b",marginBottom:16,fontFamily:"monospace"}}>{String(this.state.err?.message||this.state.err)}</div>}
        <button onClick={()=>{this.setState({err:null});this.props.onClose?.();}} style={{background:P,color:"white",border:"none",borderRadius:8,padding:"9px 24px",fontSize:13,fontWeight:600,cursor:"pointer"}}>Close</button>
      </div>
    </div>;
  }
}

function ExportModal({ cdata, wState, messages, onClose, onExport, onSend, sending, sendErr, sent, sheetLink, uiLang }) {
  // Skipped widgets store the string "__skip__" — returning it caused .join/.map
  // crashes downstream (the "blank screen on Review & send" bug). Treat as null.
  const gw = type => { const es=Object.entries(wState||{}).filter(([k,v])=>k.endsWith(`-${type}`)&&v?.submitted).sort((a,b)=>(parseInt(a[0])||0)-(parseInt(b[0])||0)); const d=es.length?es[es.length-1][1].data:null; return d==="__skip__"?null:d; };
  const historyName = useMemo(() => {
    const m = messages.filter(m=>m.role==="user").map(m=>String(m.content||"")).join(" ")
      .match(/(?:company|we are|we're|I'm from|I work at)[^\w]*([A-Z][A-Za-z0-9& ]{1,40})/);
    return m?.[1]?.trim()||"";
  }, [messages]);
  const objW = normObjectives(gw("OBJECTIVES"));
  const [co,setCo]     = useState({email:"",industry:"",useCase:"",contact:"",...cdata.company,name:cdata.company?.name||historyName});
  const [mkts,setMkts] = useState((gw("MARKETS")||[]).join(", ")||cdata.company?.markets||"");
  const [langs,setLangs]= useState((gw("LANGUAGES")||[]).join(", ")||cdata.company?.languages||"");
  const [objs,setObjs] = useState(fmtRanked(objW)||cdata.company?.objectives||"");
  const [objDetails,setObjDetails] = useState(objW.details||"");
  const [teams,setTeams]= useState((gw("TEAMS")||[]).join(", ")||cdata.company?.teams||"");
  const [tz,setTz]     = useState(Array.isArray(gw("TIMEZONE"))?gw("TIMEZONE")[0]:(gw("TIMEZONE")||cdata.company?.timezone||""));
  const [users,setUsers]= useState(unionUsers(gw("USERS"), cdata.users));
  // Topics can arrive two ways: the confirmed topic cards (name/keywords/rationale
  // only) and the %%TOPICS%% marker (also urls/hashtags/comments). Merge by name so
  // the marker's urls/hashtags survive into the brief instead of being dropped when
  // the card widget was used.
  // Union ALL confirmed TOPIC_SUGGESTION batches, not just the last one gw() returns:
  // the flow can present several batches across turns, and taking only the last
  // dropped earlier confirmed topics from the card set (they survived only if the
  // model happened to re-emit the full marker). Later batch wins on a same-name edit.
  const allTopicCards = () => {
    const es = Object.entries(wState||{}).filter(([k,v])=>k.endsWith("-TOPICS")&&(v===true||v?.submitted)).sort((a,b)=>(parseInt(a[0])||0)-(parseInt(b[0])||0));
    const byName = {}, order = [];
    es.forEach(([,v]) => { const d = v && v.data; if (Array.isArray(d)) d.forEach(t => { const k = String((t&&t.name)||"").trim().toLowerCase(); if (!k) return; if (!(k in byName)) order.push(k); byName[k] = t; }); });
    return order.map(k => byName[k]);
  };
  const [topics,setTopics]= useState(() => mergeTopics(allTopicCards(), cdata.topics || []));
  const [chans,setChans]= useState((cdata.channels||[]).map((c,i)=>({...c,id:i})));
  const [reports,setReports]= useState((cdata.reports||[]).map((r,i)=>({...r,id:i})));
  const [alerts,setAlerts]= useState((cdata.alerts||[]).map((a,i)=>({...a,id:i})));
  // When the brief is short of the minimum, Send does not dead-end: it asks for a
  // one-tap confirmation, then submits anyway (flagged incomplete) so a genuinely
  // stuck client is never trapped. This holds that confirm step.
  const [confirmSend,setConfirmSend] = useState(false);
  const emptyUser  = () => ({ firstName:"",lastName:"",email:"",role:"",access:"Full Tool" });
  const emptyChan  = () => ({ author:"",type:"",url:"",owned:"" });
  const emptyReport = () => ({ name:"",objective:"",details:"",comments:"" });
  const emptyAlert  = () => ({ name:"",type:"",details:"",comments:"" });
  const emptyTopic = () => ({ name:"",keywords:"",rationale:"",comments:"",id:Date.now(),confirmed:true });
  const confirmTopic = (i,v) => setTopics(ts=>ts.map((x,j)=>j===i?{...x,confirmed:v,comments:v?(x.comments||"").replace(GUESS_RE,"").replace(/^[\s,-]+|[\s,-]+$/g,"")||"Confirmed by client":x.comments}:x));
  // Every "+ Add …" button appends a fully blank row. Those rows must not count as
  // content: clicking "+ Add topic" and typing nothing used to satisfy BOTH "At least
  // one topic" and "All topics confirmed" (emptyTopic is created confirmed:true), moving
  // readiness 38% -> 63% for zero information. Worse, `merged` passed the rows straight
  // through, so the blank landed in the brief, the Sheet and the dashboard's topic count.
  // Judge and send on rows that actually carry something.
  const hasContent = (o, keys) => keys.some(k => String((o && o[k]) ?? "").trim());
  const realTopics  = topics.filter(t => hasContent(t, ["name","keywords"]));
  const realUsers   = users.filter(u => hasContent(u, ["firstName","lastName","email","role"]));
  const realChans   = chans.filter(c => hasContent(c, ["author","url","type"]));
  const realReports = reports.filter(r => hasContent(r, ["name","objective","details","comments"]));
  const realAlerts  = alerts.filter(a => hasContent(a, ["name","type","details","comments"]));
  const unconfirmed = realTopics.filter(t=>!t.confirmed).length;
  // readiness scoring
  const reqChecks = [
    ["expReqCompany", !!String(co.name||"").trim()],
    ["expReqEmail", !!co.email && EMAIL_RE.test(co.email)],
    ["expReqMarkets", !!mkts.trim()],
    ["expReqLanguages", !!langs.trim()],
    ["expReqObjectives", !!objs.trim()],
    ["expReqTopic", realTopics.length>0],
    ["expReqTopicsConfirmed", realTopics.length>0 && unconfirmed===0],
    ["expReqUser", realUsers.length>0],
  ];
  const passed = reqChecks.filter(c=>c[1]).length;
  const pct = Math.round(passed/reqChecks.length*100);
  const gaps = reqChecks.filter(c=>!c[1]).map(c=>L(c[0],uiLang));
  const ready = gaps.length===0;
  const fld = (label,val,set,multi,req) => <div style={{marginBottom:12}}>
    <div style={{fontSize:11,fontWeight:600,color:"#64748b",marginBottom:4,display:"flex",alignItems:"center",gap:6}}>
      {label}<span style={{fontSize:10,padding:"1px 6px",borderRadius:4,fontWeight:600,background:req?"#fef2f2":"#f1f5f9",color:req?"#dc2626":"#64748b"}}>{req?L("expRequired",uiLang):L("expOptional",uiLang)}</span>
    </div>
    {multi
      ? <textarea value={val} onChange={e=>set(e.target.value)} rows={2} aria-label={label} style={{width:"100%",border:`1px solid ${req&&!val?"#fca5a5":"#e2e8f0"}`,borderRadius:7,padding:"7px 10px",fontSize:12,color:"#1e293b",outline:"none",resize:"vertical",boxSizing:"border-box"}}/>
      : <input value={val} onChange={e=>set(e.target.value)} aria-label={label} style={{width:"100%",border:`1px solid ${req&&!val?"#fca5a5":"#e2e8f0"}`,borderRadius:7,padding:"7px 10px",fontSize:12,color:"#1e293b",outline:"none"}}/>}
  </div>;
  const addBtn = (label,onClick) => <button onClick={onClick} style={{background:"transparent",border:`1px dashed ${LINK}`,color:LINK,borderRadius:8,padding:"6px 14px",fontSize:12,cursor:"pointer",marginTop:6}}>{label}</button>;
  // Blank rows are dropped here, not just hidden from the readiness score: they used to
  // travel all the way into the brief, the generated Sheet and the dashboard's counts,
  // so a consultant opened a setup form padded with empty topic/user/channel rows.
  const merged = { company:{...co,markets:mkts,languages:langs,objectives:objs,objectiveDetails:objDetails,teams,timezone:tz}, topics:realTopics.map(({confirmed,id,...t})=>t), channels:realChans.map(({id,...c})=>c), reports:realReports.map(({id,...r})=>r), alerts:realAlerts.map(({id,...a})=>a), queries:gw("QUERIES")||"" };
  // Unmet-requirement labels in English (the UI stays in the client's language), so
  // the consultant reading the handoff sees exactly what to finish at the review call.
  const openGaps = reqChecks.filter(c => !c[1]).map(c => L(c[0], "English"));
  // realUsers, not users: the user list travels as its own argument, so filtering it in
  // `merged` alone would still have sent blank people to the brief and the Sheet.
  const doSend = () => { if (sending) return; onSend(merged, realUsers, ready ? undefined : { incomplete: true, gaps: openGaps }); };
  const dialogRef = useRef(null);
  useEffect(() => {
    // Dialog a11y: Escape closes; focus moves in on open, is TRAPPED while open
    // (Tab/Shift+Tab cycle inside — without this, tabbing walked straight out
    // into the chat composer still sitting behind the overlay), and is RESTORED
    // to the opener on close so keyboard users don't land back at the top.
    const prevFocus = document.activeElement;
    const onKey = e => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusables = dialogRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    dialogRef.current && dialogRef.current.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      if (prevFocus && typeof prevFocus.focus === "function") prevFocus.focus();
    };
  }, [onClose]);
  return <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:16,animation:REDUCE_MOTION?"none":"fadeIn .18s ease-out"}}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={L("expTitle",uiLang)} tabIndex={-1} style={{background:"white",borderRadius:T.radius.lg,width:"100%",maxWidth:680,maxHeight:"90vh",display:"flex",flexDirection:"column",boxShadow:T.shadow.modal,outline:"none",animation:REDUCE_MOTION?"none":"modalPop .2s ease-out"}}>
      <div style={{padding:"20px 24px 16px",borderBottom:"1px solid #e2e8f0",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
        <div><h2 style={{fontWeight:700,fontSize:16,color:"#1e293b",margin:0}}>{L("expTitle",uiLang)}</h2><div style={{fontSize:12,color:"#64748b",marginTop:2}}>{L("expSubtitle",uiLang)}</div></div>
        {/* Not closeable mid-send. sendErr renders ONLY inside this modal, so closing
            it while the send is in flight threw away the one surface the failure had:
            the client saw the dialog vanish, no error anywhere, and reasonably assumed
            the brief had gone. It had not. Verified in a browser with every write
            failing — the page carried no trace of the failure at all. */}
        <button onClick={onClose} disabled={sending} aria-label={L("expClose",uiLang)} style={{background:"transparent",border:"none",fontSize:20,cursor:sending?"default":"pointer",color:sending?"#cbd5e1":"#64748b"}}>✕</button>
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"20px 24px"}}>
        <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:20,padding:"12px 14px",borderRadius:10,background:ready?"#f0fdf4":"#fffbeb",border:`1px solid ${ready?"#bbf7d0":"#fde68a"}`}}>
          <div style={{position:"relative",width:52,height:52,flexShrink:0}}>
            <svg width="52" height="52" viewBox="0 0 52 52">
              <circle cx="26" cy="26" r="22" fill="none" stroke="#e2e8f0" strokeWidth="6"/>
              <circle cx="26" cy="26" r="22" fill="none" stroke={ready?"#16a34a":A} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${2*Math.PI*22*pct/100} ${2*Math.PI*22}`} transform="rotate(-90 26 26)"/>
            </svg>
            <div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:"#1e293b"}}>{pct}%</div>
          </div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:13,color:"#1e293b"}}>{ready?L("expReady",uiLang):L("expAlmost",uiLang)}</div>
            <div style={{fontSize:11,color:"#64748b",margin:"1px 0 2px"}}>{topics.length} {L(topics.length!==1?"expTopics":"expTopic",uiLang)} · {chans.length} {L(chans.length!==1?"expChannels":"expChannel",uiLang)} · {reports.length+alerts.length} {L((reports.length+alerts.length)!==1?"expReports":"expReport",uiLang)} · {users.length} {L(users.length!==1?"expUsers":"expUser",uiLang)}</div>
            {ready
              ? <div style={{fontSize:12,color:"#166534"}}>{L("expReadyDesc",uiLang)}</div>
              : <div style={{fontSize:12,color:"#92400e"}}>{L("expStillNeeded",uiLang,{gaps:gaps.join(", ")})}</div>}
          </div>
        </div>
        <Section title={L("expSecBusiness",uiLang)} defaultOpen={!co.name||!co.email||!mkts.trim()||!langs.trim()||!objs.trim()}>
          {fld(L("expFldName",uiLang),co.name,v=>setCo(c=>({...c,name:v})),false,true)}
          {fld(L("expFldEmail",uiLang),co.email,v=>setCo(c=>({...c,email:v})),false,true)}
          {fld(L("expFldIndustry",uiLang),co.industry,v=>setCo(c=>({...c,industry:v})),false,false)}
          {fld(L("expFldMarkets",uiLang),mkts,setMkts,false,true)}
          {fld(L("expFldLanguages",uiLang),langs,setLangs,false,true)}
          {fld(L("expFldObjectives",uiLang),objs,setObjs,false,true)}
          {fld(L("expFldObjDetails",uiLang),objDetails,setObjDetails,true,false)}
          {fld(L("expFldUseCases",uiLang),co.useCase,v=>setCo(c=>({...c,useCase:v})),true,false)}
          {fld(L("expFldTimezone",uiLang),tz,setTz,false,false)}
          {fld(L("expFldTeams",uiLang),teams,setTeams,false,false)}
          {fld(L("expFldContact",uiLang),co.contact,v=>setCo(c=>({...c,contact:v})),false,false)}
        </Section>
        <Section title={L("expSecTeam",uiLang)} badge={users.length} defaultOpen={users.length===0}>
          {users.length===0 && <div style={{fontSize:12,color:"#64748b",fontStyle:"italic",marginBottom:8}}>{L("expNoUsers",uiLang)}</div>}
          {users.map((u,i) => <div key={i} style={{background:"#f8f9fa",borderRadius:8,padding:"10px 12px",marginBottom:8}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:6,marginBottom:6}}>
              {/* Human names, not raw keys: "firstName" as a placeholder is unreadable
                  for everyone and vanishes once filled, leaving the field nameless. */}
              {[["firstName",L("expUFirst",uiLang)],["lastName",L("expULast",uiLang)],["email",L("expUEmail",uiLang)],["role",L("expURole",uiLang)]].map(([k,lb]) => <input key={k} value={u[k]||""} placeholder={lb} aria-label={lb} onChange={e=>setUsers(us=>us.map((x,j)=>j===i?{...x,[k]:e.target.value}:x))} style={{border:"1px solid #e2e8f0",borderRadius:6,padding:"6px 8px",fontSize:11,outline:"none"}}/>)}
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <div style={{display:"flex",gap:4}}>{["Admin","Full Tool","Read-Only"].map(a => <button key={a} onClick={()=>setUsers(us=>us.map((x,j)=>j===i?{...x,access:a}:x))} aria-pressed={u.access===a} style={{padding:"3px 8px",borderRadius:5,fontSize:10,cursor:"pointer",border:"1px solid",background:u.access===a?P:"transparent",borderColor:u.access===a?P:"#e2e8f0",color:u.access===a?"white":"#64748b"}}>{a}</button>)}</div>
              <button onClick={()=>setUsers(us=>us.filter((_,j)=>j!==i))} aria-label={L("expRemoveUser",uiLang,{name:u.firstName||u.email||i+1})} style={{background:"transparent",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12}}>✕</button>
            </div>
          </div>)}
          {addBtn(L("expAddUser",uiLang), ()=>setUsers(u=>[...u,emptyUser()]))}
        </Section>
        <Section title={L("expSecTrack",uiLang)} badge={topics.length} defaultOpen={topics.length===0||unconfirmed>0}>
          {topics.length===0 && <div style={{fontSize:12,color:"#64748b",fontStyle:"italic",marginBottom:8}}>{L("expNoTopics",uiLang)}</div>}
          {unconfirmed>0 && <div style={{fontSize:11,color:"#92400e",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:7,padding:"7px 10px",marginBottom:10,display:"flex",gap:6}}><span>⚠</span><span>{L(unconfirmed!==1?"expUnconfirmedMany":"expUnconfirmedOne",uiLang,{n:unconfirmed})}</span></div>}
          {topics.map((tp,i) => { const guess = !tp.confirmed; return <div key={tp.id} style={{background:guess?"#fffbeb":"#f0fdf4",border:`1px solid ${guess?"#fde68a":"#bbf7d0"}`,borderRadius:8,padding:"10px 12px",marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:6}}>
              <div style={{fontSize:10,fontWeight:700,display:"flex",alignItems:"center",gap:5,color:guess?"#d97706":"#16a34a",textTransform:"uppercase",letterSpacing:"0.04em"}}><span>{guess?"⚠":"✓"}</span>{guess?L("expGuess",uiLang):L("expConfirmed",uiLang)}</div>
              {guess
                ? <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>confirmTopic(i,true)} style={{background:P,color:"#fff",border:"none",borderRadius:6,padding:"4px 10px",fontSize:11,fontWeight:600,cursor:"pointer"}}>{L("expConfirm",uiLang)}</button>
                    <button onClick={()=>setTopics(ts=>ts.filter((_,j)=>j!==i))} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:6,padding:"4px 9px",fontSize:11,color:"#64748b",cursor:"pointer"}}>{L("expDrop",uiLang)}</button>
                  </div>
                : <button onClick={()=>setTopics(ts=>ts.filter((_,j)=>j!==i))} aria-label={L("expRemoveTopic",uiLang,{name:tp.name||i+1})} style={{background:"transparent",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,flexShrink:0}}>✕</button>}
            </div>
            <div>
              <input value={tp.name||""} placeholder={L("expTopicName",uiLang)} onChange={e=>setTopics(ts=>ts.map((x,j)=>j===i?{...x,name:e.target.value}:x))} style={{width:"100%",border:"none",borderBottom:"1px solid #e2e8f0",fontSize:13,fontWeight:600,outline:"none",background:"transparent",marginBottom:6,padding:"2px 0"}}/>
              <input value={tp.keywords||""} placeholder={L("expKeywords",uiLang)} onChange={e=>setTopics(ts=>ts.map((x,j)=>j===i?{...x,keywords:e.target.value}:x))} style={{width:"100%",border:"none",borderBottom:"1px solid #e2e8f0",fontSize:12,outline:"none",background:"transparent",padding:"2px 0",marginBottom:6}}/>
              <input value={tp.rationale||tp.comments||""} placeholder={L("expRationale",uiLang)} onChange={e=>setTopics(ts=>ts.map((x,j)=>j===i?{...x,rationale:e.target.value,comments:e.target.value}:x))} style={{width:"100%",border:"none",fontSize:11,outline:"none",background:"transparent",padding:"2px 0",color:"#64748b",fontStyle:"italic"}}/>
            </div>
          </div>; })}
          {addBtn(L("expAddTopic",uiLang), ()=>setTopics(ts=>[...ts,emptyTopic()]))}
          <PasteImport label={L("expPasteLabel",uiLang)} placeholder={L("expPasteTopicPh",uiLang)} lang={uiLang} onImport={lines=>setTopics(ts=>[...ts,...lines.map((l,i)=>{ const p=l.split("|").map(s=>s.trim()); return {name:p[0]||"",keywords:p[1]||"",rationale:p[2]||"",comments:p[2]||"Imported from client list",id:Date.now()+i,confirmed:true}; })])}/>
        </Section>
        <Section title={L("expSecLook",uiLang)} badge={chans.length} defaultOpen={false}>
          {chans.length===0 && <div style={{fontSize:12,color:"#64748b",fontStyle:"italic",marginBottom:8}}>{L("expNoChannels",uiLang)}</div>}
          {/* flexWrap + a minimum basis: four fields forced into one row collapse to
              ~55px each inside the modal on a phone — unreadable and uneditable. */}
          {chans.map((ch,i) => <div key={ch.id} style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8,alignItems:"center"}}>
            {[["author",L("expChName",uiLang)],["type",L("expChPlatform",uiLang)],["url",L("expChUrl",uiLang)],["owned",L("expChOwned",uiLang)]].map(([k,lb]) => <input key={k} value={ch[k]||""} placeholder={lb} aria-label={lb} onChange={e=>setChans(cs=>cs.map((x,j)=>j===i?{...x,[k]:e.target.value}:x))} style={{flex:"1 1 140px",minWidth:0,border:"1px solid #e2e8f0",borderRadius:6,padding:"6px 8px",fontSize:11,outline:"none"}}/>)}
            <button onClick={()=>setChans(cs=>cs.filter((_,j)=>j!==i))} aria-label={L("expRemoveChannel",uiLang,{name:ch.author||ch.url||i+1})} style={{background:"transparent",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,flexShrink:0}}>✕</button>
          </div>)}
          {addBtn(L("expAddChannel",uiLang), ()=>setChans(cs=>[...cs,{...emptyChan(),id:Date.now()}]))}
          <PasteImport label={L("expPasteLabel",uiLang)} placeholder={L("expPasteChannelPh",uiLang)} lang={uiLang} onImport={lines=>setChans(cs=>[...cs,...lines.map((l,i)=>{ const u=l.match(URL_RE)?.[0]||""; const author=l.replace(u,"").replace(/[|,]/g," ").trim(); return {author:author||"",type:guessChanType(u),url:u,owned:"",id:Date.now()+i}; })])}/>
        </Section>
        <Section title={L("expSecReports",uiLang)} badge={reports.length+alerts.length} defaultOpen={false}>
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:6}}>{L("expReportsHdr",uiLang)}</div>
          {reports.length===0 && <div style={{fontSize:12,color:"#64748b",fontStyle:"italic",marginBottom:8}}>{L("expNoReports",uiLang)}</div>}
          {reports.map((r,i) => <div key={r.id} style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8,alignItems:"center"}}>
            {/* Dashboard vs Report: the assistant pre-classifies each item (kind); this
                lets the client see and correct it before it writes to the sheet's
                "Dashboard / Report" column. Values are literal so they match the sheet. */}
            <select value={r.kind||""} aria-label={L("expRepKind",uiLang)} onChange={e=>setReports(rs=>rs.map((x,j)=>j===i?{...x,kind:e.target.value}:x))} style={{flex:"0 0 auto",border:"1px solid #e2e8f0",borderRadius:6,padding:"6px 8px",fontSize:11,outline:"none",background:"#fff",color:r.kind?"#1e293b":"#94a3b8"}}>
              <option value="">{L("expRepKind",uiLang)}</option>
              <option value="Dashboard">{L("expRepKindDashboard",uiLang)}</option>
              <option value="Report">{L("expRepKindReport",uiLang)}</option>
            </select>
            {[["name",L("expRepName",uiLang)],["objective",L("expObjective",uiLang)],["details",L("expDetails",uiLang)],["comments",L("expComments",uiLang)]].map(([k,lb]) => <input key={k} value={r[k]||""} placeholder={lb} aria-label={lb} onChange={e=>setReports(rs=>rs.map((x,j)=>j===i?{...x,[k]:e.target.value}:x))} style={{flex:"1 1 140px",minWidth:0,border:"1px solid #e2e8f0",borderRadius:6,padding:"6px 8px",fontSize:11,outline:"none"}}/>)}
            <button onClick={()=>setReports(rs=>rs.filter((_,j)=>j!==i))} aria-label={L("expRemoveReport",uiLang,{name:r.name||i+1})} style={{background:"transparent",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,flexShrink:0}}>✕</button>
          </div>)}
          {addBtn(L("expAddReport",uiLang), ()=>setReports(rs=>[...rs,{...emptyReport(),id:Date.now()}]))}
          <div style={{fontSize:11,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.04em",margin:"14px 0 6px"}}>{L("expAlertsHdr",uiLang)}</div>
          {alerts.length===0 && <div style={{fontSize:12,color:"#64748b",fontStyle:"italic",marginBottom:8}}>{L("expNoAlerts",uiLang)}</div>}
          {alerts.map((a,i) => <div key={a.id} style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8,alignItems:"center"}}>
            {[["name",L("expAlName",uiLang)],["type",L("expType",uiLang)],["details",L("expDetails",uiLang)],["comments",L("expComments",uiLang)]].map(([k,lb]) => <input key={k} value={a[k]||""} placeholder={lb} aria-label={lb} onChange={e=>setAlerts(as=>as.map((x,j)=>j===i?{...x,[k]:e.target.value}:x))} style={{flex:"1 1 140px",minWidth:0,border:"1px solid #e2e8f0",borderRadius:6,padding:"6px 8px",fontSize:11,outline:"none"}}/>)}
            <button onClick={()=>setAlerts(as=>as.filter((_,j)=>j!==i))} aria-label={L("expRemoveAlert",uiLang,{name:a.name||i+1})} style={{background:"transparent",border:"none",color:"#ef4444",cursor:"pointer",fontSize:12,flexShrink:0}}>✕</button>
          </div>)}
          {addBtn(L("expAddAlert",uiLang), ()=>setAlerts(as=>[...as,{...emptyAlert(),id:Date.now()}]))}
        </Section>
      </div>
      {/* flexWrap: on a narrow phone the readiness line + actions cannot fit one row;
          without wrapping the Send button gets crushed at the conversion moment. When
          the brief is short of the bar, Send does not dead-end — it opens a one-tap
          "send anyway" confirmation (with review-session reassurance) so a genuinely
          stuck client can still submit. Download is available either way. */}
      <div style={{padding:"16px 24px",borderTop:"1px solid #e2e8f0",flexShrink:0}}>
        {(!ready && confirmSend) ? (
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"10px 12px"}}>
              <div style={{fontWeight:700,fontSize:13,color:"#92400e",marginBottom:2}}>{L("expIncompleteTitle",uiLang)}</div>
              <div style={{fontSize:12,color:"#92400e",lineHeight:1.5}}>{L("expIncompleteBody",uiLang)}</div>
            </div>
            <div style={{display:"flex",gap:10,alignItems:"center",justifyContent:"flex-end",flexWrap:"wrap"}}>
              {sendErr && <div style={{fontSize:11,color:"#dc2626",maxWidth:240,lineHeight:1.4}}>{sendErr==="send-failed"?L("expSendFailed",uiLang):sendErr}</div>}
              <button onClick={()=>setConfirmSend(false)} disabled={sending} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,padding:"9px 20px",fontSize:13,color:"#64748b",cursor:sending?"default":"pointer"}}>{L("expKeepGoing",uiLang)}</button>
              <button onClick={()=>doSend()} disabled={sending} style={{display:"inline-flex",alignItems:"center",gap:7,background:A,color:"white",border:"none",borderRadius:8,padding:"9px 24px",fontSize:13,fontWeight:600,cursor:sending?"default":"pointer",opacity:sending?0.7:1}}>{sending?L("expSending",uiLang):<><Ic d={IC.send} size={13}/>{L("expSendAnyway",uiLang)}</>}</button>
            </div>
          </div>
        ) : (
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <div style={{fontSize:11,color:ready?"#16a34a":"#92400e",flex:"1 1 180px",minWidth:0}}>{ready?L("expFooterReady",uiLang):`${L("expStillNeeded",uiLang,{gaps:gaps.slice(0,3).join(", ")})}${gaps.length>3?` ${L("expMore",uiLang,{n:gaps.length-3})}`:""}`}</div>
            <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
              {sendErr && <div style={{fontSize:11,color:"#dc2626",maxWidth:240,lineHeight:1.4}}>{sendErr==="send-failed"?L("expSendFailed",uiLang):sendErr}</div>}
              <button onClick={onClose} style={{background:"transparent",border:"1px solid #e2e8f0",borderRadius:8,padding:"9px 20px",fontSize:13,color:"#64748b",cursor:"pointer"}}>{L("expCancel",uiLang)}</button>
              {/* Download stays a quiet text link so it never reads as "download = done"
                  beside Send, but it is available whether or not the brief is complete —
                  a stuck client can always keep a copy of their own answers. */}
              {!(sent && sheetLink) && <button onClick={()=>onExport(merged,realUsers)} style={{background:"transparent",border:"none",color:"#64748b",padding:"9px 6px",fontSize:12,textDecoration:"underline",cursor:"pointer"}}>{L("expDownload",uiLang)}</button>}
              {/* Ready: submit directly. Not ready: enabled but amber, opening the confirm
                  step rather than dead-ending, so a stuck client is never trapped. */}
              <button onClick={()=>{ if (sending) return; if (ready) doSend(); else setConfirmSend(true); }} disabled={sending} style={ready
                ? {display:"inline-flex",alignItems:"center",gap:7,background:A,color:"white",border:"none",borderRadius:8,padding:"9px 24px",fontSize:13,fontWeight:600,cursor:sending?"default":"pointer",opacity:sending?0.7:1}
                : {display:"inline-flex",alignItems:"center",gap:7,background:"#fffbeb",color:"#92400e",border:"1px solid #f59e0b",borderRadius:8,padding:"9px 24px",fontSize:13,fontWeight:600,cursor:"pointer"}}>{sending?L("expSending",uiLang):<><Ic d={IC.send} size={13}/>{L("expSend",uiLang)}</>}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  </div>;
}

// lang is the session's UI language, threaded in from the component: this runs at
// module scope so it cannot read uiLang itself, and without it the downloaded copy
// reported "English" for every client (see the note in handleSend).
async function doExport(merged, users, rawMessages, lang) {
  let companyName = merged.company?.name;
  if (!companyName) {
    const m = (rawMessages||[]).filter(m=>m.role==="user").map(m=>m.content||"").join(" ")
      .match(/(?:company|we are|we're|I'm from|I work at)[^\w]*([A-Z][A-Za-z0-9& ]{1,40})/);
    companyName = m?.[1]?.trim()||"Draft";
  }
  const XLSX = await loadXLSX();
  const { wb, filename } = buildWorkbook(XLSX, {...merged, company:{...merged.company, name:companyName, onboardingLanguage: merged.company?.onboardingLanguage || lang}}, users);
  XLSX.writeFile(wb, filename);
}

function FinishCard({ C, cdata, setShowExport, linkCopied, setLinkCopied, sent, sheetLink, onSeeProserv, lang }) {
  return (
    <div style={{display:"flex",justifyContent:"center",marginBottom:24,animation:"slideUpFade 0.5s ease-out forwards"}}>
      <div style={{background:`linear-gradient(135deg,${P}15,${P}08)`,border:`1.5px solid ${sent?A:P}`,borderRadius:T.radius.lg,padding:"20px 28px",textAlign:"center",maxWidth:460,boxShadow:sent?T.shadow.glow:"none"}}>
        {/* Pre-send this card is a CALL TO ACTION, not a finish line: no celebration
            until the brief has actually reached the Lumen team, so a skimming client
            can't read "100% + party" as done and close the tab. Once sent, a drawn
            check + glow + a "what happens next" timeline pay the moment off (C14/L3). */}
        {sent
          ? <svg width="46" height="46" viewBox="0 0 52 52" aria-hidden="true" style={{marginBottom:6}}><circle cx="26" cy="26" r="24" fill="none" stroke={A} strokeWidth="2" strokeOpacity="0.25"/><path d="M15 27l7 7 15-17" fill="none" stroke={A} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" style={{strokeDasharray:44,strokeDashoffset:REDUCE_MOTION?0:44,animation:REDUCE_MOTION?"none":"drawCheck .55s .15s ease-out forwards"}}/></svg>
          : <div style={{color:A,marginBottom:8,display:"flex",justifyContent:"center"}}><Ic d={IC.send} size={26}/></div>}
        <div style={{fontWeight:700,fontSize:15,color:C.text,marginBottom:6}}>{sent?FN("titleSent",lang):FN("titlePre",lang)}</div>
        <div style={{fontSize:13,color:C.muted,marginBottom:16,lineHeight:1.5}}>
          {sent ? (sheetLink ? FN("descSheet",lang) : FN("descPlain",lang)) : FN("descPre",lang)}
        </div>
        {sent && <div style={{display:"flex",flexDirection:"column",textAlign:"left",margin:"0 auto 18px",maxWidth:300}}>
          {[[FN("s1a",lang),FN("s1b",lang)],[FN("s2a",lang),FN("s2b",lang)],[FN("s3a",lang),FN("s3b",lang)],[FN("s4a",lang),FN("s4b",lang)]].map(([t,d],i,arr) => <div key={t} style={{display:"flex",gap:10,alignItems:"stretch"}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
              <div style={{width:18,height:18,borderRadius:"50%",background:`${A}1f`,color:LINK,fontSize:10,fontWeight:700,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{i+1}</div>
              {i<arr.length-1 && <div style={{width:2,flex:1,minHeight:12,background:C.border}}/>}
            </div>
            <div style={{paddingBottom:i<arr.length-1?10:0}}><div style={{fontSize:13,fontWeight:600,color:C.text}}>{t}</div><div style={{fontSize:12,color:C.muted,lineHeight:1.4}}>{d}</div></div>
          </div>)}
        </div>}
        <div style={{display:"flex",gap:8,justifyContent:"center",flexWrap:"wrap"}}>
          {sent && sheetLink && <a href={sheetLink} target="_blank" rel="noopener noreferrer" style={{background:P,color:"white",borderRadius:10,padding:"10px 20px",fontSize:13,fontWeight:600,cursor:"pointer",textDecoration:"none",display:"inline-block"}}>{FN("openSheet",lang)}</a>}
          <button onClick={()=>setShowExport(true)} style={{display:"inline-flex",alignItems:"center",gap:7,background:sent&&sheetLink?C.card:A,color:sent&&sheetLink?C.muted:"white",border:sent&&sheetLink?`1px solid ${C.border}`:"none",borderRadius:10,padding:"10px 20px",fontSize:13,fontWeight:600,cursor:"pointer"}}>{sent?(sheetLink?FN("review",lang):FN("reviewDl",lang)):<><Ic d={IC.send} size={13}/>{FN("reviewSend", lang)}</>}</button>
          {sent && onSeeProserv && <button onClick={onSeeProserv} style={{background:"#012B3A",color:"white",border:"none",borderRadius:10,padding:"10px 16px",fontSize:13,fontWeight:600,cursor:"pointer"}}>See what Proserv receives →</button>}
        </div>
      </div>
    </div>
  );
}

function OnboardingApp({ seed, seedId, seedError, seedExpired, onBriefSent, onSeeProserv }) {
  const [theme,setTheme]       = useState("light");
  const [sound,setSound]       = useState(false);
  // Clamp the seed's language to a SUPPORTED UI language. seed.language can carry a
  // monitoring-only language (LANG_OPT has 12; the UI shell only localizes the 6 in
  // UI_LANGS) or, via a tampered/stale seed, junk. An unsupported value left as-is
  // desyncs everything: the UI silently falls back to English strings while
  // seededOpener still directs the model to converse in the unsupported language,
  // and no language pill matches. Falling back to English keeps the whole experience
  // consistent. The Sales page only offers supported languages, so no legitimate
  // seed is affected.
  const [uiLang,setUiLang]     = useState(() => (seed?.language && UI_LANGS.some(l => l.code === seed.language)) ? seed.language : "English");
  // Set when the CLIENT picks a language themselves (as opposed to it being restored
  // from a seed or a draft). resumeConvo restores the saved language, which would
  // otherwise instantly undo a correction made on the Welcome-back screen.
  const langOverrideRef = useRef(false);
  const [messages,setMessages] = useState([]);
  const [input,setInput]       = useState("");
  const [loading,setLoading]   = useState(false);
  const [progress,setProgress] = useState({percent:0,collected:{}});
  const [started,setStarted]   = useState(false);
  const [wState,setWState]     = useState({});
  const [saved,setSaved]       = useState(null);
  const [checked,setChecked]   = useState(false);
  const [confirmFresh,setConfirmFresh] = useState(false); // two-step guard: "Start fresh" wipes the saved draft
  const [collapsed,setCollapsed]= useState(true);
  const [showExport,setShowExport]= useState(false);
  const [cdata,setCdata]       = useState(emptyCdata());
  const [retryMsg,setRetryMsg] = useState(null);
  const [attaching,setAttaching] = useState(false); // a composer-attached document is being read/sent
  const [attachNote,setAttachNote] = useState(null); // inline note when an attached file can't be read (too large / unsupported)
  const [initErr,setInitErr]   = useState(null); // "start" | "resume" | null — first-turn/resume API failure, offers retry
  const [draftOk,setDraftOk]   = useState(lsProbe); // is on-device draft saving actually working?
  // Is the SERVER draft actually working? null = not attempted yet (stay optimistic,
  // a seeded link normally resumes anywhere), false = a write was tried and failed,
  // so the cross-device promise must be withdrawn. Distinct from draftOk: that one
  // only ever backed "saved on this device".
  const [srvOk,setSrvOk]       = useState(null);
  // The single source of truth for every "reopen on any device" promise in the UI.
  const crossDevice = !!seedId && srvOk !== false;
  // Open by default only where there is room to sit beside the chat. Below this the
  // panel still works, it just stays closed until asked for and then floats over the
  // conversation as an overlay (which is what the shadow below SIDE_COL_MIN is for).
  const [showPanel,setShowPanel] = useState(() => typeof window !== "undefined" && window.innerWidth >= SIDE_COL_MIN);
  const [linkCopied,setLinkCopied] = useState(false);
  const [sent,setSent]         = useState(false);
  const [sending,setSending]   = useState(false);
  const [sendErr,setSendErr]   = useState(null);
  const [sheetLink,setSheetLink] = useState(null);
  const [ww,setWw] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => { const f = () => setWw(window.innerWidth); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  // The captured-answers panel is position:fixed and has to start BELOW the header. Its
  // top used to be the literal 56, which is only the header's minHeight: on mobile the
  // header is height:auto with flexWrap, so a longer wordmark/tagline (any non-English
  // language will do it) pushes it taller and the panel then sat ON TOP of the header's
  // own controls. Measured on a 375px phone: header 94px, all three controls 91%
  // covered, and a hit-test at each button's centre returned the panel, so the sound,
  // dark-mode and panel toggles were simply dead. Measured, not assumed, so it also
  // survives rotation and language changes.
  const headerRef = useRef(null);
  const [headerH,setHeaderH] = useState(56);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const measure = () => setHeaderH(Math.round(el.getBoundingClientRect().height) || 56);
    measure();
    if (typeof ResizeObserver === "undefined") return; // older browsers keep the 56 default
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // Depends on `checked` because the component returns <BootScreen/> until it is true,
    // so on the very first run the header does not exist yet and the ref is null. With
    // empty deps the effect never re-ran once the real tree mounted, the observer was
    // never attached, and the panel silently kept the 56 default — which is exactly the
    // bug this is meant to fix. `checked` is declared above; `mob`/`uiLang` are declared
    // below and would be in the temporal dead zone here, but the observer covers those
    // reflows anyway.
  }, [checked]);
  const mob = ww < 640;

  const botRef  = useRef(null);
  const histRef = useRef([]);
  const taRef   = useRef(null);
  // Focus management for newly rendered interactive content (widget / quick replies):
  // refs to the latest assistant turn's interactive region, plus a signature of the
  // last content we moved focus to, so we only steal focus on genuinely NEW content.
  const lastWidgetRef = useRef(null);
  const qrRef = useRef(null);
  const focusedInteractiveKey = useRef(null);
  const attachRef = useRef(null); // hidden file input for the composer attach affordance
  const busyRef = useRef(false);  // synchronous in-flight guard: blocks a second send (widget double-tap, type-during-wait) that would queue two consecutive user turns and 400 the API
  // Synchronous mirror of the `attaching` state. File extraction runs BEFORE the
  // send claims busyRef, so during that window a widget Confirm/Skip tap would slip
  // past a busyRef-only guard, claim busyRef itself, and make the pending
  // sendAttachment bail — silently dropping the attached document (flagship path).
  // `attaching` is React state and lags a fast tap; this ref does not.
  const attachingRef = useRef(false);
  const msgRef  = useRef(null);
  const prevPct = useRef(0);
  const sndRef  = useRef(sound);
  const prevSecRef = useRef(null);
  const sidRef  = useRef(null);
  // seedId is stable for this component's life (LiveChat mounts OnboardingApp only
  // after the seed resolves). Held in a ref so callAPI can pass it to the chat
  // proxy without re-creating the callback graph. The id is already in the URL
  // (?s=), so sending it is not a secret leak — it lets the SERVER look up the
  // confidential consultant notes and inject them into the system prompt without
  // the notes ever reaching this browser.
  const seedIdRef = useRef(seedId);
  const apiCountRef = useRef(0);
  const usageRef = useRef({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const sendingRef = useRef(false); // synchronous double-send guard (state lags a fast double-click)
  const startedAtRef = useRef(null);
  const saveT   = useRef(null);
  // Latest draft snapshot, kept current so the flush-on-hide handler below can save
  // without re-binding a listener on every render.
  const snapRef = useRef(null);
  const wRef    = useRef(wState);
  useEffect(() => { sndRef.current = sound; }, [sound]);
  useEffect(() => { wRef.current = wState; }, [wState]);
  // Keep the seedId ref synced to the prop like the refs above. seedId is stable
  // in the live app (LiveChat mounts this only after the seed resolves), but
  // syncing here matches the idiom and stays correct if a future caller ever
  // re-renders with a different seedId instead of remounting.
  useEffect(() => { seedIdRef.current = seedId; }, [seedId]);

  // Keep the document's language and text direction in step with the conversation.
  // chat.html ships lang="en" because that is the honest default before a language is
  // known, but the assistant mirrors the client into six languages, so leaving it at
  // "en" tells a screen reader to pronounce French with an English voice (WCAG 2.2
  // SC 3.1.1) and prompts a browser to offer to translate a page already in the
  // reader's language.
  //
  // Setting `dir` also switches on two things that were already written but could
  // never fire: the [dir="rtl"] Arabic font stack further down, and every
  // marginInline*/paddingInline* logical property the layout already uses. Until now
  // an Arabic session rendered left-to-right in a Latin font stack.
  //
  // Client chat only. sales.html and dashboard.html are internal, English-only tools
  // and correctly stay lang="en".
  useEffect(() => {
    const { lang, dir } = docLangDir(uiLang);
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [uiLang]);

  const { init, pop, chime } = useAudio();
  const dark = theme === "dark";
  const C = useMemo(() => dark
    ? {bg:"#0d1b2a",card:"#111f30",border:"#1e3048",muted:"#8aa4c1",text:"#c8d8e8",hi:"#1a2f4a",uBg:"#1e3a5f",uTx:"#d0e8ff",wTx:"#a89af0"}
    : {bg:"#F7F7FA",card:"#ffffff",border:"#E7E7EF",muted:"#64748b",text:"#1e293b",hi:"#F1F0F7",uBg:P,uTx:"#F2F7F8",wTx:LINK}
  , [dark]);

  // Follow new content, but don't yank a client who scrolled up to re-read: only
  // auto-scroll when they're already near the bottom, or when a send just kicked
  // off the spinner (they expect to follow their own message). (F3)
  useEffect(() => {
    const el = msgRef.current;
    const nearBottom = !el || (el.scrollHeight - el.scrollTop - el.clientHeight < 200);
    if (nearBottom || loading) botRef.current?.scrollIntoView({behavior:REDUCE_MOTION?"auto":"smooth"});
  }, [messages, loading]);
  // A11y: when a new assistant turn introduces interactive content (a widget or a
  // quick-reply set), move keyboard/SR focus to its first control so it isn't
  // stranded in the composer. Fires only when the interactive content is genuinely
  // NEW (keyed on the latest message index + its widget/quick-reply identity), never
  // on ordinary re-renders, and uses preventScroll so it doesn't fight the
  // near-bottom auto-scroll above (which already honours REDUCE_MOTION).
  useEffect(() => {
    if (loading) return;
    const lastMsg = messages[messages.length-1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    const widgets = lastMsg.widgets || [];
    const qrs = lastMsg.quickReplies || [];
    if (widgets.length === 0 && qrs.length === 0) return;
    const key = `${messages.length-1}|w:${widgets.join(",")}|q:${qrs.length}`;
    if (focusedInteractiveKey.current === key) return;
    const container = widgets.length > 0 ? lastWidgetRef.current : qrRef.current;
    if (!container) return; // guard: region not mounted yet (e.g. QR hidden while loading)
    focusedInteractiveKey.current = key;
    const focusable = container.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const target = focusable || container;
    if (target && typeof target.focus === "function") {
      try { target.focus({ preventScroll: true }); } catch { target.focus(); }
    }
  }, [messages, loading]);
  useEffect(() => { if (progress.percent===100&&prevPct.current<100&&sndRef.current) chime(); prevPct.current=progress.percent; }, [progress.percent, chime]);
  // Seeded sessions get a bespoke tab title so screenshots and tab-switching feel
  // prepared-for-you rather than generic (B6).
  useEffect(() => { if (seed && seed.company && typeof document !== "undefined") document.title = `Lumen Onboarding — ${seed.company}`; }, [seed]);

  // On mount, offer to resume an in-progress draft. Two sources: the local copy
  // (instant, same browser only) and the server copy keyed by the link's seed id
  // (works on ANY device the link is opened on). Take whichever is NEWER, so
  // continuing on a second device picks up the latest state, while a same-device
  // return still wins if it got further while the network was down.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A delivered brief wins over any draft: show the client what actually happened
      // (sent, plus their Sheet link) instead of a blank Start screen. Checked first and
      // returns early, so a stale draft can never resurrect a conversation that has
      // already been submitted.
      const receipt = lsLoadReceipt(seedId);
      if (receipt) {
        if (receipt.uiLang && UI_LANGS.some(l => l.code === receipt.uiLang)) setUiLang(receipt.uiLang);
        setSheetLink(receipt.sheetLink || null);
        setSent(true);
        setStarted(true);
        setChecked(true);
        return;
      }
      const local = lsLoadDraft(seedId);
      let remote = null;
      // Only seeded links have a stable server key. Skip the fetch otherwise so a
      // non-seeded session behaves exactly as before (local-only, no extra request).
      if (seedId) { try { remote = await srvLoadDraft(seedId); } catch { remote = null; } }
      if (cancelled) return;
      const draft = pickDraft(local, remote);
      if (draft) {
        setSaved(draft);
        // Render the "Welcome back" screen in the language the draft was saved in.
        // For a non-seeded return uiLang defaults to English until resume restores
        // it, so without this the resume screen would greet a French/Arabic/... client
        // in English. Clamp to a supported UI language (L() also falls back safely).
        if (draft.uiLang && UI_LANGS.some(l => l.code === draft.uiLang)) setUiLang(draft.uiLang);
      }
      setChecked(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Autosave the in-progress draft after each turn, until sent. Three sinks:
  //  - localStorage: the full draft (messages/history) for instant same-device resume.
  //  - draft store (seeded links): the SAME full snapshot, keyed by the link's seed
  //    id, so reopening the link on another device resumes exactly where it stopped.
  //  - server session record (from the first real answer on): a TRIMMED snapshot —
  //    structured progress only, no messages/history — so Proserv sees live and
  //    stalled sessions, not just completed ones. Keyed by session id, marked
  //    in_progress; the completed record overwrites it on send (same id).
  useEffect(() => {
    if (!started || sent || messages.length === 0) return;
    // Keep the live snapshot available to the flush-on-hide handler below. Set
    // OUTSIDE the debounce timer, so a client who closes the tab within the debounce
    // window still has their latest turn saved rather than losing it.
    // retryMsg is part of the draft, not incidental UI state. When a turn fails to
    // send, the user turn is POPPED off histRef (so a dead turn never reaches the
    // model) and its text survives only here. Leaving it out meant a client who
    // refreshed at the retry card came back to their own message still in the
    // transcript, absent from history, with no Try again anywhere: the answer was
    // silently lost and the assistant carried on as if it had never been given.
    snapRef.current = { messages, progress, wState, cdata, history: histRef.current, uiLang, sid: sidRef.current, startedAt: startedAtRef.current, apiCalls: apiCountRef.current, tokens: { ...usageRef.current }, retryMsg };
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => {
      const snap = { messages, progress, wState, cdata, history: histRef.current, uiLang, sid: sidRef.current, startedAt: startedAtRef.current, apiCalls: apiCountRef.current, tokens: { ...usageRef.current }, retryMsg, savedAt: Date.now() };
      setDraftOk(lsSaveDraft(seedId, snap));
      // Cross-device copy. Best-effort and never blocks the chat; the local copy
      // already covers this device if it fails. Skipped while a send is in flight so
      // a late autosave can't resurrect a draft for an already-sent session.
      // srvSaveDraft already returns res.ok — RECORD it. Discarding it meant the
      // header promised "Progress saved / reopen on any device" on every seeded
      // session whether or not a single write had ever landed, so a client whose
      // server draft was failing was told their work was safe anywhere, closed the
      // tab, and lost it. Only ever downgrades the claim; it never blocks the chat.
      if (seedId && !sendingRef.current) srvSaveDraft(seedId, snap).then(setSrvOk);
      // Server upsert. Best-effort, never blocks the chat. Skipped while a send is
      // in flight so a late autosave can't overwrite the completed record.
      const pct = (progress && progress.percent) || 0;
      const hasRealAnswer = !!(cdata.company && cdata.company.name) || pct > 0;
      if (hasRealAnswer && !sendingRef.current) {
        const usersW = unionUsers(gwp("USERS"), cdata.users);
        // The %%COMPANY%% marker carries only name/email/industry/useCase/contact;
        // markets/languages/objectives/teams/timezone are captured via widgets and
        // live in wState. Merge them into the in-progress record's company (the
        // completed record already does) so the dashboard's stalled/in-progress view
        // and the stalled Slack alert don't show them blank when the client answered.
        const _mk = gwp("MARKETS"), _lg = gwp("LANGUAGES"), _tm = gwp("TEAMS"), _tz = gwp("TIMEZONE"), _ob = gwp("OBJECTIVES");
        const _obN = normObjectives(_ob === "__skip__" ? null : _ob);
        const _co = { ...(cdata.company || {}),
          markets:   Array.isArray(_mk) ? _mk.join(", ") : (cdata.company?.markets || ""),
          languages: Array.isArray(_lg) ? _lg.join(", ") : (cdata.company?.languages || ""),
          teams:     Array.isArray(_tm) ? _tm.join(", ") : (cdata.company?.teams || ""),
          timezone:  Array.isArray(_tz) ? _tz.join(", ") : (cdata.company?.timezone || ""),
          objectives: _obN.ranked.length ? fmtRanked(_ob) : (cdata.company?.objectives || ""),
          objectiveDetails: _obN.details || cdata.company?.objectiveDetails || "",
        };
        const inProgress = {
          id: sidRef.current,
          status: "in_progress",
          percent: pct,
          merged: { company: _co, topics: cdata.topics || [], channels: cdata.channels || [], reports: cdata.reports || [], alerts: cdata.alerts || [], queries: gwp("QUERIES") || "" },
          users: Array.isArray(usersW) ? usersW : [],
          handoff: cdata.handoff || null,
          seedId: seedId || null,
          seed: seed || null,
          durationMs: startedAtRef.current ? (Date.now() - startedAtRef.current) : null,
          apiCalls: apiCountRef.current,
          tokens: { ...usageRef.current },
          lastActiveAt: new Date().toISOString(),
        };
        fetchWithTimeout(SESSION_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: inProgress }) }, 15000).catch(() => {});
      }
    }, 600);
    return () => { if (saveT.current) clearTimeout(saveT.current); };
    // retryMsg is in the deps deliberately: a send failure changes nothing else the
    // effect watches (messages already holds the bubble), so without it the draft would
    // never learn there is a pending unsent turn.
  }, [messages, progress, wState, cdata, started, sent, uiLang, seedId, seed, retryMsg]);

  // Flush the draft the moment the page is backgrounded or closed. The autosave above
  // is debounced by 600ms, so without this a client who answers and immediately closes
  // the tab (or switches apps on a phone, where the tab can be discarded outright)
  // loses that last turn. visibilitychange is the reliable signal on mobile; pagehide
  // covers the desktop close/navigate case. keepalive lets the request outlive the page.
  // Re-fit the composer when the viewport changes. Its inline height is computed
  // from scrollHeight on CHANGE only, so it was frozen at whatever the wrap width
  // was when the client last typed. Rotate a phone landscape -> portrait and the
  // text needs more lines while the box stays the old height: measured at 390x844,
  // a 170-character draft rendered 54px tall against 130px of content — 78px, about
  // three lines, invisible with no scrollbar affordance on touch. The other
  // direction only leaves the box slightly oversized, which is harmless.
  // Also fires when the mobile keyboard opens/closes, where recomputing is correct.
  useEffect(() => {
    const fit = () => {
      const el = taRef.current;
      if (!el) return;
      // Mirror the post-send reset: an empty composer goes back to "auto" rather
      // than being pinned to a measured pixel height.
      el.style.height = "auto";
      if (el.value) el.style.height = el.scrollHeight + "px";
    };
    window.addEventListener("resize", fit);
    window.addEventListener("orientationchange", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("orientationchange", fit);
    };
  }, []);

  useEffect(() => {
    const flush = () => {
      if (!started || sent || sendingRef.current) return;
      const snap = snapRef.current;
      if (!snap || !Array.isArray(snap.messages) || snap.messages.length === 0) return;
      const stamped = { ...snap, savedAt: Date.now() };
      lsSaveDraft(seedId, stamped);
      if (seedId) srvSaveDraft(seedId, stamped, { keepalive: true }).then(setSrvOk);
    };
    const onVis = () => { if (typeof document !== "undefined" && document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
    };
  }, [started, sent, seedId]);

  const resetSession = useCallback(() => {
    sidRef.current = crypto.randomUUID();
    setSent(false); setSendErr(null);
    setStarted(false); setMessages([]); setProgress({percent:0,collected:{}});
    setWState({}); setCdata(emptyCdata());
    setSaved(null); setRetryMsg(null); histRef.current = [];
    prevSecRef.current = null; prevPct.current = 0;
    apiCountRef.current = 0; usageRef.current = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }, []);


  const MAX_HIST_TURNS = 20;
  // Keep the serialized request under the server's 400k body cap (chat.js), with
  // headroom. Turn-count trimming alone isn't enough: a few large imported docs in
  // the recent window can still blow the cap, which 413s every send and wedges the
  // session. So after the turn window we also drop oldest messages until it fits.
  const MAX_REQ_BODY = 350_000;
  // Background-job polling. Generation runs on a background function (no 26s wall),
  // so we poll for the result. POLL_MAX_MS is a generous client-side ceiling — far
  // above the 20-30s the slowest replies take, so it only ever fires on a genuinely
  // stuck job, at which point we re-roll a fresh one.
  // POLL_MAX_MS MUST STAY ABOVE BG_ABORT_MS in netlify/functions/chat-background.js
  // (150s). The server has to give up first, so a slow turn ends with a reported 504
  // the client can act on, rather than the client abandoning a job that then keeps
  // generating and billing in the background. See the note there; a cross-file test
  // (tests/timeouts.test.js) fails the build if the two ever drift back.
  const POLL_MS = 500, POLL_MAX_MS = 180_000;

  const callAPI = useCallback(async (hist, sysExtra="") => {
    // seedId lets the server inject confidential consultant notes; maxTokens matches
    // the server ceiling (server clamps anyway); see chat.js for the timeout math.
    const mkBody = msgs => ({ messages: msgs, maxTokens: 2000, overstateFix: !!sysExtra, seedId: seedIdRef.current || undefined });
    let trimmed = hist.slice(-MAX_HIST_TURNS);
    // Size-trim: drop oldest turns until the body fits. The captured brief lives in
    // cdata/wState (persisted separately), so this sheds only old conversational
    // context, never captured data. Always keep at least the current (last) turn.
    while (trimmed.length > 1 && JSON.stringify(mkBody(trimmed)).length > MAX_REQ_BODY) trimmed = trimmed.slice(1);
    // The Messages API requires the first message to be a user turn; a suffix slice
    // of an alternating history can begin on an assistant turn, so drop it if so.
    if (trimmed.length > 1 && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
    apiCountRef.current += 1;
    // The system prompt lives server-side in the chat function; the client only
    // flags whether the OVERSTATE correction pass is needed.
    const bodyStr = JSON.stringify(mkBody(trimmed));

    // The reply is generated by a BACKGROUND function (chat-background.js), not a
    // synchronous request. The synchronous path is capped at ~26s, but real replies
    // were measured at 20-30s (document attaches, topic-heavy turns) and were being
    // KILLED mid-generation — the timeouts clients reported. A background function
    // runs up to 15 min, so the same call just finishes. Contract: the POST kicks
    // off the job (opaque rid in the query, so the server never double-reads the
    // body) and returns 202; we then poll chat-status until the result is persisted.
    // The retry loop wraps the WHOLE kickoff+poll, so a transient failure re-rolls a
    // fresh job with a new rid. Return value + usage accounting are unchanged from
    // the old synchronous version, so callAPILive / sendToAPI and their malformed /
    // overstate retries all keep working exactly as before.
    // Retry budget for a TRANSIENT upstream failure (429, or Anthropic's 529
    // "Overloaded"). This used to be capped at 3 fast attempts because the old
    // synchronous path had to finish inside a 26s wall — that ceiling is gone now
    // (the background function has 15 min), and Anthropic's own guidance for 529
    // is to back off and retry rather than give up in a few seconds. 6 attempts
    // with exponential backoff (capped at 15s) gives ~45s of absorbed retrying
    // before surfacing anything to the client, which should ride out a normal
    // capacity blip invisibly instead of showing "we couldn't reach the assistant"
    // for something that would have succeeded 10 seconds later.
    const MAX_ATTEMPTS = 6;
    const backoffMs = attempt => Math.min(1000 * 2 ** (attempt - 1), 15000);
    let result = null;

    // HEAVY-TURN ROUTING: a document attach (up to ATTACH_MAX_CHARS ≈ 48k chars)
    // or a huge paste triggers the longest replies in the app — the harvest turn
    // emits confirmation prose plus several %% markers at once and can exceed the
    // sync path's 24s server-side abort. Attempting sync first on such a turn
    // would burn the full 24s on a doomed request and THEN run the background
    // path from scratch (~50s total — worse than background-only). The client
    // knows the size before sending, so big turns skip sync and go straight to
    // the background path (9-min budget). Typed messages are a few hundred chars;
    // 8k cleanly separates the two populations.
    const lastMsgLen = (trimmed[trimmed.length - 1]?.content || "").length;
    const heavyTurn = lastMsgLen > 8000;

    // SYNC-FIRST: try the plain synchronous proxy before the background flow.
    // Since the <thought> compression, typical generation is 4-8s — comfortably
    // inside the sync window — and the background path was measured adding a
    // consistent ~4-6s of structural overhead per turn (job dispatch + the 500ms
    // polling cadence) even on warm containers. One request/response removes all
    // of it. The server self-aborts at 24s; 26s here covers that plus transport.
    // ANY failure (504 on a rare heavy turn, network error, non-JSON) falls
    // through silently to the background+poll path below, which remains the
    // reliability backstop — so the worst case is the old behaviour, not an error.
    if (!heavyTurn) try {
      const r = await fetchWithTimeout(CHAT_ENDPOINT,
        { method:"POST", headers:{"Content-Type":"application/json"}, body: bodyStr }, 26000);
      if (r && r.ok) {
        const d = await r.json().catch(() => null);
        if (d && !d.error && Array.isArray(d.content)) { result = d; console.log("chat turn: sync path"); }
      }
      if (!result) console.warn("sync chat path unavailable — falling back to background flow");
    } catch { console.warn("sync chat path failed/timed out — falling back to background flow"); }

    if (!result) for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Fresh id per attempt so a retry can never pick up a stale/partial result.
      const rid = "r_" + ((typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36));

      // 1) Kick off the background job. A background function returns 202 (accepted);
      //    anything else means the kickoff itself failed (not the model) — retry.
      let kicked = null;
      try {
        kicked = await fetchWithTimeout(`${CHAT_BG_ENDPOINT}?rid=${encodeURIComponent(rid)}`,
          { method:"POST", headers:{"Content-Type":"application/json"}, body: bodyStr }, 15000);
      } catch (e) { if (attempt === MAX_ATTEMPTS) throw e; await sleep(backoffMs(attempt)); continue; }
      if (!kicked || (kicked.status !== 202 && kicked.status !== 200)) {
        if (attempt === MAX_ATTEMPTS) throw new Error(`kickoff_${kicked ? kicked.status : "net"}`);
        await sleep(backoffMs(attempt)); continue;
      }

      // 2) Poll for the persisted result until it lands or we pass the deadline.
      //    Transient poll errors are swallowed — keep polling; only a blank deadline
      //    (or a terminal error status) ends the wait.
      const deadline = Date.now() + POLL_MAX_MS;
      let polled = null;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        let pr = null;
        try { pr = await fetchWithTimeout(`${CHAT_STATUS_ENDPOINT}?id=${encodeURIComponent(rid)}`, {}, 12000); }
        catch { continue; }
        if (!pr || !pr.ok) continue;
        const pd = await pr.json().catch(() => null);
        // Surfaced in the browser console (not just the Netlify request log, which
        // only shows the kickoff duration, not the actual background generation
        // time) so a slow-turn diagnosis doesn't require digging through Netlify's
        // function-log UI.
        if (pd && pd.state === "done") { console.log(`chat turn: server genMs=${pd.genMs}`); polled = pd; break; }
        // pd.state === "pending" -> keep waiting
      }
      if (!polled) { if (attempt === MAX_ATTEMPTS) throw new Error("api_timeout"); continue; } // stuck job: re-roll

      // 3) Terminal result. 200 -> use it. 429/5xx (incl. Anthropic's 529
      //    "Overloaded") -> transient, retry with backoff. Other 4xx -> a retry
      //    can't fix it, so surface immediately.
      if (polled.status === 200) { result = polled.body; break; }
      const transient = polled.status === 429 || polled.status >= 500;
      if (!transient || attempt === MAX_ATTEMPTS) throw new Error(`api_${polled.status}`);
      await sleep(backoffMs(attempt));
    }
    if (!result) throw new Error("api_unreachable");
    if (result.error) throw new Error("api_error");
    if (result.usage) {
      const u = usageRef.current;
      u.input     += result.usage.input_tokens || 0;
      u.output    += result.usage.output_tokens || 0;
      u.cacheRead += result.usage.cache_read_input_tokens || 0;
      u.cacheWrite+= result.usage.cache_creation_input_tokens || 0;
    }
    return (result.content||[]).map(b=>b.text||"").join("");
  }, []);

  const OVERSTATE_FIX = "\n\nCORRECTION — REWRITE REQUIRED: Your previous reply implied the setup is already live, running, or delivering results. It is NOT — nothing is active until the consultant activates it at the review call. Rewrite your reply keeping all %% markers identical, but change the visible prose to use only future or conditional framing (\"once your consultant activates this, you'll…\", \"this will be set up to…\"). Do not use \"is now set up\", \"you're now getting\", \"will now get\", \"delivered on a schedule\", \"up and running\", or \"you're all set\".";

  const callAPILive = useCallback(async hist => {
    let raw = await callAPI(hist);
    // Fail-safe: every assistant turn must carry a PROGRESS marker, and no marker
    // should be left unterminated. A missing PROGRESS marker or a truncated
    // (dangling) marker is the strongest signal of a malformed or cut-off
    // generation — retry once silently rather than showing the client a derailed
    // reply or dropping the data that was mid-emit when it truncated.
    if (!raw.includes("%%PROGRESS%%") || hasDanglingMarker(raw) || hasUnparseableMarker(raw)) {
      console.warn("malformed reply (missing PROGRESS, truncated, or unparseable marker) — retrying once");
      raw = await callAPI(hist);
    }
    // Expectation guard: never show the client language implying the setup is
    // already live. Unlike a blind retry, this re-runs WITH an explicit corrective
    // so the rewrite actually differs, then accepts the result.
    if (overstatesCompletion(stripAll(raw))) {
      console.warn("overstated completion detected — retrying with corrective");
      raw = await callAPI(hist, OVERSTATE_FIX);
    }
    return raw;
  }, [callAPI]);


  const inferPct = useCallback(() => {
    const sub = t => Object.entries(wRef.current).some(([k,v])=>k.endsWith(`-${t}`)&&(v===true||v?.submitted));
    if (sub("USERS")) return 80;
    if (["MARKETS","OBJECTIVES","TEAMS"].every(sub)) return 60;
    if (sub("TOPICS")) return 40;
    if (sub("PATH")) return 15;
    return 0;
  }, []);

  const applyCdata = useCallback(pr => {
    setCdata(p => mergeCdata(p, pr));
  }, []);

  const sendToAPI = useCallback(async (rawTxt, isRetry=false, opts={}) => {
    // Reject a concurrent send outright: two user turns queued back-to-back make the
    // Messages API 400 and can wedge the session. `loading` is state and lags a fast
    // double-tap; busyRef is synchronous. Every send funnels through here (typed,
    // widget Confirm/Skip, attach), so this one guard covers them all.
    if (busyRef.current) return false;
    busyRef.current = true;
    try {
    // Strip any injected marker delimiters from client input before it reaches
    // the model (see sanitizeIn). Covers typed messages and widget payloads.
    const txt = sanitizeIn(rawTxt);
    // Ensure exactly one trailing user turn for this call. On a fresh send we
    // push it; on retry it's still there from the prior attempt. Either way, if
    // the call fails we pop it back off so a subsequent message can't leave two
    // user turns in a row (which the API rejects, bricking the session).
    const last = histRef.current[histRef.current.length-1];
    const alreadyQueued = isRetry && last?.role==="user" && last?.content===txt;
    if (!alreadyQueued) histRef.current.push({role:"user",content:txt});
    setRetryMsg(null);
    setLoading(true);
    // One SILENT auto-retry before surfacing the retry card: clients forgive a
    // hiccup they never see. The queued user turn stays across both attempts;
    // only after the second failure do we pop it and show the banner.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const t0 = Date.now(), raw = await callAPILive(histRef.current), el = Date.now()-t0;
        if (el < MIN_MS) await sleep(MIN_MS-el);
        const pr = parseReply(raw);
        const { clean,widgets,topicSuggestions,quickReplies,progress:prog,offerSend } = pr;
        // Dead-reply guard: after callAPILive's retries a reply can still come back
        // malformed (e.g. truncated on a large import), which strips to nothing and
        // carries no widget/chips — an empty bubble that leaves the flow with nothing
        // to click. Treat that as a failure and retry / offer-retry rather than hang.
        const actionable = clean.trim() || widgets.length || topicSuggestions.length || quickReplies.length;
        if (!actionable) throw new Error("empty_reply");
        if (prog) setProgress(prog);
        else setProgress(p=>({...p,percent:Math.max(p.percent,inferPct())}));
        // A turn just succeeded, so any first-turn/resume failure card is stale. Clearing
        // it here is not cosmetic: that card's Try again calls startConvo(), which
        // resetSession()s. Left on screen above a conversation that had since recovered,
        // it read as "there is still a problem" and one reasonable tap on it wiped the
        // whole conversation. Verified: the client's answers went from present to gone.
        setInitErr(null);
        applyCdata(pr);
        histRef.current.push({role:"assistant",content:stripThoughtForHistory(raw)});
        if (sndRef.current) pop();
        const dv = maybeDivider(prog, uiLang);
        setMessages(p=>[...p,...(dv?[dv]:[]),{role:"assistant",content:clean,widgets,topicSuggestions,quickReplies,offerSend,timestamp:gts(),at:gat()}]);
        setLoading(false);
        return true;
      } catch(e) {
        if (attempt === 0) { await sleep(600); continue; } // silent retry once, spinner stays up
        if (histRef.current[histRef.current.length-1]?.role==="user") histRef.current.pop();
        // A caller that supplies a failMessage (e.g. an attached document) shows its
        // own clear one-off message instead of the generic resend banner — re-sending
        // the same large doc would just fail again.
        if (opts.failMessage) setMessages(p=>[...p,{role:"assistant",content:opts.failMessage,timestamp:gts(),at:gat()}]);
        else setRetryMsg(txt);
        setLoading(false);
        return false;
      }
    }
    } finally { busyRef.current = false; }
  }, [callAPI, pop, inferPct, applyCdata]);

  const handleSend = useCallback(async (merged, users, meta) => {
    // Double-send guard: `sending` is React state and lags a fast double-click,
    // so a ref (updates synchronously) is what actually prevents two records,
    // two Sheets, or two Slack alerts from one impatient double-tap.
    if (sendingRef.current) return;
    sendingRef.current = true;
    if (saveT.current) clearTimeout(saveT.current); // cancel any pending in-progress autosave so it can't land after the completed record
    setSending(true); setSendErr(null);
    try {
      // Belt-and-suspenders: guarantee the client contact name + email reach the
      // brief by falling back to the sales-page seed when the review fields are
      // blank. Seeded links always carry these, so a blanked field can never lose
      // the Main Point of Contact / Requirements Completed By values downstream.
      if (seed) {
        const _co = merged.company || {};
        merged = { ...merged, company: { ..._co, contact: _co.contact || seed.contactName || "", email: _co.email || seed.email || "" } };
      }
      // Stamp the session's language onto the brief HERE, before anything consumes it.
      // It used to be spliced in further down, inline in the Sheets request body only,
      // so the workbook never carried it: buildWorkbook read company.onboardingLanguage,
      // found it undefined, and fell back to "English". The Apps-Script Sheet looked
      // right (it is built from that JSON payload) while the client's "Download a copy"
      // and the Drive-conversion fallback both told the consultant English, whatever
      // language the client actually used. One assignment, one source of truth.
      merged = { ...merged, company: { ...(merged.company || {}), onboardingLanguage: uiLang } };
      const XLSX = await loadXLSX();
      const { wb, filename } = buildWorkbook(XLSX, merged, users || []);
      const sentAt = new Date();

      // A client can deliberately send before the brief meets the bar (the review
      // modal's "send anyway"). Flag it and, so the consultant is never surprised,
      // fold the outstanding sections into the handoff's follow-ups for the review call.
      const incomplete = !!(meta && meta.incomplete);
      const openGaps = (meta && meta.gaps) || [];
      const baseHandoff = cdata.handoff || {
        maturity: "",
        goalInOwnWords: merged.company?.useCase || "",
        hesitations: "",
        aiSuggestedUnconfirmed: "",
        followUps: "Session sent before the assistant produced a full handoff — review the brief directly and confirm the gaps at the call.",
        consultantTips: "",
      };
      const handoff = incomplete
        ? { ...baseHandoff, followUps: [baseHandoff.followUps, "Client sent an incomplete brief on purpose. Complete these together at the review session: " + (openGaps.join(", ") || "the missing sections") + "."].filter(Boolean).join(" ") }
        : baseHandoff;

      const record = {
        id: sidRef.current,
        merged, users: users || [],
        handoff,
        incomplete,
        incompleteGaps: openGaps,
        queries: merged.queries || "",
        seed: seed || null,
        seedId: seedId || null,
        sheetUrl: null, // attached by a second write once the Sheet exists (below)
        durationMs: startedAtRef.current ? (Date.now() - startedAtRef.current) : null,
        apiCalls: apiCountRef.current,
        tokens: { ...usageRef.current },
        status: "completed",
        sentAt: sentAt.toISOString(),
      };

      // Save the session FIRST, before the Sheet step fires the Slack alert. The
      // alert carries a "View full session" deep-link (dashboard?id=<sessionId>);
      // if the Sheet ran first and this save then failed, that link would 404. By
      // saving first — and passing the sessionId to the Sheet call only when the
      // record is actually stored — a dead deep-link is never advertised.
      let saveOk = false;
      try {
        const res = await fetchWithTimeout(SESSION_ENDPOINT, {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ session: record })
        }, 15000);
        if (!res.ok) throw new Error(`save_${res.status}`);
        saveOk = true;
      } catch (e) { console.error("Session save failed", e); }

      // Generate the editable Google Sheet from the brief's workbook. Best-effort:
      // if Sheets isn't configured (501) or the call fails, the brief still sends;
      // the client just doesn't get a Sheet link. Never blocks the confirmation.
      // The Apps Script is idempotent on sessionId, so a retry returns the same
      // Sheet instead of creating a duplicate / re-firing Slack.
      let sheetUrl = null, sheetPending = false;
      try {
        const xlsxBase64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
        const sres = await fetchWithTimeout(SHEET_ENDPOINT, {
          method: "POST", headers: { "Content-Type": "application/json" },
          // Always send sessionId (not only when the first save succeeded): it is the
          // Apps Script's idempotency key AND the writeback target. Withholding it on a
          // failed/slow save let a resend copy a SECOND Sheet + re-send the branded
          // email + re-fire Slack, and killed the link writeback. The completed record
          // is persisted below on every success-ish path, so the Slack deep link resolves.
          body: JSON.stringify({ sessionId: sidRef.current, xlsxBase64, brief: { ...merged, users: users || [] }, filename, clientEmail: merged.company?.email || "", company: merged.company?.name || "", contactName: merged.company?.contact || "", topicsCount: (merged.topics || []).length, usersCount: (users || []).length }),
        }, 30000); // aligned to the sheet function's own 24s upstream abort + the 26s function ceiling; was 45s, which left the client waiting ~19s after the platform would already have killed the function
        if (sres.ok) { const sd = await sres.json().catch(() => ({})); sheetUrl = sd.url || null; }
        else {
          // Distinguish a GENUINE failure (the Apps Script ran and errored, or Sheets
          // isn't configured — no Sheet will ever arrive, so the fallback alert should
          // fire) from a TIMEOUT or a PLATFORM KILL (the Apps Script is likely still
          // running and will write the link back and fire its own alert — defer, so we
          // don't double- or false-alert). sheet.js signals a real failure with a JSON
          // {error:"sheet_failed"|"sheets_not_configured"|...}; its own 24s abort returns
          // {error:"sheet_timeout"}; a platform-level 502/504 gateway kill has no such body.
          const sd = await sres.json().catch(() => null);
          const err = sd && sd.error;
          // sheet_unreachable = sheet.js's own network throw to the Apps Script: the
          // request may well have landed and be running, so defer like a timeout rather
          // than firing a false/duplicate failure alert.
          if (err === "sheet_timeout" || err === "sheet_unreachable" || !err) sheetPending = true;
        }
      } catch (e) {
        if (e && e.name === "AbortError") sheetPending = true; // client's own wait elapsed — same reasoning: the Sheet is likely still being built server-side
        console.error("Sheet generation failed (non-fatal)", e);
      }
      // Never null out a link we already have. The Send button stays live after a
      // successful send (re-sending is a deliberate recovery path), and `sheetUrl` is a
      // fresh local that stays null whenever the Sheet step fails. Assigning it
      // unconditionally meant one failed re-send removed "Open your brief" from the
      // finish card even though the Sheet existed and was untouched — the client lost
      // their only in-app route to it. Same rule session.js already applies server-side
      // when reconciling a completed record.
      if (sheetUrl) setSheetLink(sheetUrl);
      record.sheetUrl = sheetUrl;

      // Second write: attach the Sheet link so the dashboard can open it, or — when
      // the Sheet step failed — flag the record so the SERVER fires a fallback
      // completion alert. Runs when the first save succeeded OR when the Sheet
      // delivered despite a failed first save: in that recovery case this write
      // CREATES the completed record (session.js upserts by id), so the dashboard
      // shows it completed instead of leaving the client stuck "in progress" and
      // tripping a false stalled alert 24h later.
      if (saveOk || sheetUrl || sheetPending) {
        // Persist on the pending path too (not just saveOk/sheetUrl): when the first
        // save failed AND the Sheet call timed out, this write CREATES the completed
        // record so the Apps Script writeback has a target and the dashboard shows it.
        // Only ask the server to fire the fallback "completed but no Sheet" alert when
        // the Sheet genuinely won't arrive; on a timeout the Apps Script is still
        // running and will write the link back and fire its own alert.
        if (!sheetUrl && !sheetPending) record.notifyFallback = true;
        try {
          await fetchWithTimeout(SESSION_ENDPOINT, {
            method:"POST", headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ session: record })
          }, 15000);
        } catch (e) { console.error("Session second-write failed (non-fatal)", e); }
      }

      // "Delivered" = it reached Proserv by at least one durable channel: the
      // session store (dashboard) OR the Sheet (which also fires the Slack alert
      // and drops the file in the Proserv folder). If BOTH failed, don't show a
      // false "sent" — keep the draft and the modal open so the client can retry
      // instead of walking away thinking it went through. A pending Sheet counts as
      // delivered: the record was just persisted and the Apps Script is finishing it
      // (a retry is idempotent now that sessionId is always sent).
      if (!saveOk && !sheetUrl && !sheetPending) {
        setSendErr("send-failed");
        // Belt to the close-button brace: sendErr has no surface outside the modal,
        // so if it is not on screen the failure is invisible and the client walks
        // away believing the brief was sent. Re-open it rather than add a second
        // error surface to keep in sync. No-op when it is already open.
        setShowExport(true);
        return; // the `finally` below still re-enables the Send button
      }

      onBriefSent?.({ ...record, filename, sentAt });
      setSent(true); setShowExport(false);
      // Clear the resume draft only once the record is safely stored; if the save
      // failed but the Sheet carried it through, keep the draft so the session can
      // still be re-sent later to populate the dashboard.
      if (saveOk) { lsClearDraft(seedId); srvClearDraft(seedId); }
      // Written on every delivered send, including the save-failed-but-Sheet-delivered
      // path above, so a return visit always reflects that the brief is gone rather than
      // inviting the client to start again from scratch.
      lsSaveReceipt(seedId, { sentAt: sentAt.toISOString(), sheetLink: sheetUrl || null, uiLang });
      // Bring the "Brief sent" confirmation into view — without this the modal just
      // closes and the client is left looking at empty scroll space (reads as a blank
      // screen / no confirmation).
      requestAnimationFrame(() => { if (msgRef.current) msgRef.current.scrollTop = msgRef.current.scrollHeight; });
      if (sndRef.current) chime();
    } catch (e) {
      // Catastrophic (e.g. buildWorkbook / XLSX threw before anything was sent).
      // Never leave the client on a stuck spinner or a false success.
      console.error("Send failed", e);
      setSendErr("send-failed");
      setShowExport(true); // same reason as above: the modal is the only error surface
    } finally {
      setSending(false);
      sendingRef.current = false;
    }
  }, [chime, cdata, onBriefSent, seed, seedId, uiLang]);

  const maybeDivider = useCallback((prog, lang) => {
    const sec = prog?.section;
    if (!sec) return null;
    const prev = prevSecRef.current;
    prevSecRef.current = sec;
    if (!prev || prev === sec) return null;
    const pi = SECTION_KEYS.indexOf(prev), ni = SECTION_KEYS.indexOf(sec);
    if (pi === -1 || ni === -1 || ni <= pi) return null;
    const remaining = SECTION_KEYS.length - ni;
    return { role:"divider", label:L("divDone",lang,{label:L(SECTION_LABEL_KEYS[prev],lang)}), sub: remaining>0?L("divToGo",lang,{n:remaining}):"", timestamp:gts(),at:gat() };
  }, []);

  const widgetSum = (type, data) =>
    type==="OBJECTIVES" ? (()=>{ const n=normObjectives(data); return fmtRanked(n)+(n.details?` — ${n.details}`:""); })()
    : ["MARKETS","LANGUAGES","TEAMS","TIMEZONE"].includes(type) ? (Array.isArray(data)?data.join(", "):data)
    : type==="USERS"   ? `${data.length} user(s)`
    : type==="QUERIES" ? (data==="__skip__"?"Skipped":"Submitted")
    : type==="TOPICS"  ? `${data.length} topics confirmed`
    : data==="recommendations" ? "Recommendations path" : "Guided path";

  // What the MODEL receives. The visible chip stays short ("Submitted"), but the
  // model needs the actual content — for QUERIES the pasted/imported text itself,
  // for USERS the real names/roles. Sending only the summary meant the model
  // never saw the queries at all.
  const widgetApiPayload = (type, data) =>
    type==="QUERIES" && data!=="__skip__" ? `Full pasted/imported content below — extract what's relevant per your IMPORTED CONTENT instructions:\n${data}`
    : type==="USERS" && Array.isArray(data) ? data.map(u=>`${u.firstName} ${u.lastName} <${u.email}> — ${u.role||"no role"} — ${u.access}`).join("; ")
    // Send the CONFIRMED topic names + keywords (not just "N topics confirmed"), so
    // when the model re-emits the %%TOPICS%% marker (e.g. folding in noise-check
    // exclusions) it uses the client's renamed/edited values. Without this the marker
    // keeps the model's original name/keywords, which then diverges from the card —
    // duplicating a renamed topic or overwriting the client's keyword edits on merge.
    : type==="TOPICS" && Array.isArray(data) ? "Confirmed topics (use these exact names/keywords when you emit or update the TOPICS marker): " + data.map(t=>`${t.name||"(unnamed)"}${t.keywords?` [keywords: ${t.keywords}]`:""}`).join("; ")
    : widgetSum(type, data);



  const startConvo = useCallback(async () => {
    init();
    const sd = seed, keepSid = sidRef.current;
    resetSession(); setStarted(true); setLoading(true);
    startedAtRef.current = Date.now(); apiCountRef.current = 0;
    if (sd) {
      // Preserve the session id only when one already exists, but prefill the company
      // on EVERY seeded start — gating the prefill on keepSid left the panel/company
      // blank on the first Start until the model's first %%COMPANY%% marker returned.
      if (keepSid) sidRef.current = keepSid;
      setCdata(p=>({...p, company:{name:sd.company||"", email:sd.email||"", industry:sd.industry||"", useCase:"", contact:sd.contactName||""}}));
    }
    if (msgRef.current) msgRef.current.scrollTop = 0;
    const ini = { role:"user", content: sanitizeIn(seededOpener(sd, uiLang)) };
    histRef.current = [ini];
    setInitErr(null);
    try {
      const raw = await callAPILive([ini]);
      const pr = parseReply(raw);
      const { clean,widgets,topicSuggestions,quickReplies,progress:prog,offerSend } = pr;
      if (prog) setProgress(prog);
      // applyCdata used to run ONLY in sendToAPI, so any data marker in the very
      // first reply was parsed and then thrown away. On a seeded session the model
      // is handed the company, contact and industry up front and told to weave them
      // in, so a %%COMPANY%% on turn 1 is a reasonable thing for it to emit — and it
      // vanished. Harmless to run here: the seed prefill above already populated
      // company, and mergeObj drops blank fields, so a partial marker cannot wipe it.
      applyCdata(pr);
      histRef.current.push({role:"assistant",content:stripThoughtForHistory(raw)});
      prevSecRef.current = prog?.section || "company";
      setMessages([{role:"assistant",content:clean,widgets,topicSuggestions,quickReplies,offerSend,timestamp:gts(),at:gat()}]);
    } catch (e) {
      // Without this, a failed first turn left a permanent "Assistant is thinking…"
      // spinner with no way out. Clear it and offer a retry instead.
      console.error("startConvo failed", e);
      // Drop the seeded opener. It is a USER turn, and the composer is already live at
      // this point (started is true), so a client who types instead of tapping Try again
      // would otherwise send [seeded-opener, their-answer] — two consecutive user turns
      // with no assistant between, the malformed shape the pop in sendToAPI and busyRef
      // both exist to prevent. The seeded facts are not lost: chat.js injects the client
      // profile server-side, and Try again rebuilds this opener from scratch anyway.
      histRef.current = [];
      setInitErr("start");
    } finally {
      setLoading(false);
    }
  }, [callAPI, init, resetSession, seed, uiLang, applyCdata]);

  const resumeConvo = useCallback(async () => {
    init(); if (!saved) return;
    // Re-read the on-device draft AT RESUME TIME rather than trusting the snapshot
    // captured when this tab mounted. A second tab opened on the same link holds the
    // draft as it looked when IT loaded; resuming there restored that stale copy and
    // the next autosave overwrote everything the first tab had done since. Verified by
    // driving two tabs: a client answer went from present to permanently gone.
    // pickDraft only ever moves forward (newer savedAt wins), so this can never select
    // older state than we already had.
    const s = pickDraft(lsLoadDraft(seedId), saved) || saved;
    setStarted(true); setLoading(true); setInitErr(null);
    // Do not restore the saved language over a correction the client just made on the
    // Welcome-back screen — that was the whole point of offering the picker there.
    if (s.uiLang && !langOverrideRef.current) setUiLang(s.uiLang);
    if (s.sid) sidRef.current = s.sid;
    startedAtRef.current = s.startedAt || Date.now();
    // Rehydrate usage so the dashboard's api-calls/tokens/cost aren't undercounted
    // after a resume (they were reset to 0 on resume, dropping all pre-pause usage).
    apiCountRef.current = s.apiCalls || 0;
    usageRef.current = s.tokens ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...s.tokens } : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    setMessages(s.messages); setProgress(s.progress); setWState(s.wState||{});
    prevSecRef.current = s.progress?.section || null;
    if (s.cdata) setCdata(s.cdata);
    // A turn that failed to send lives ONLY in retryMsg by this point: sendToAPI popped
    // it back off histRef so a dead turn could never reach the model. Restore that
    // pending state and stop here, WITHOUT asking the model for a welcome-back message.
    // The client lands on their own message plus a working "Try again", which is the
    // one action that recovers it. Resuming normally instead would deliver a fresh
    // assistant reply that silently talks past the answer they can still see on screen.
    if (s.retryMsg) {
      histRef.current = [...(s.history || [])];
      setRetryMsg(s.retryMsg);
      setSaved(null);
      setLoading(false);
      return;
    }
    // Clone the saved history so a failed attempt + retry can't stack two
    // "[RESUMING SESSION]" markers onto the same array reference.
    histRef.current = [...(s.history||[]), {role:"user",content:"[RESUMING SESSION] The client is returning to continue their onboarding."}];
    try {
      const raw = await callAPILive(histRef.current);
      const { clean,widgets,topicSuggestions,quickReplies,progress:prog,offerSend } = parseReply(raw);
      if (prog) setProgress(prog);
      histRef.current.push({role:"assistant",content:stripThoughtForHistory(raw)});
      if (sndRef.current) pop();
      const dv = maybeDivider(prog, uiLang);
      setMessages(p=>[...p,...(dv?[dv]:[]),{role:"assistant",content:clean,widgets,topicSuggestions,quickReplies,offerSend,timestamp:gts(),at:gat()}]);
      setSaved(null); // only clear the resume draft once we've actually continued
    } catch (e) {
      // Keep `saved` so the retry can re-resume; clear the spinner and surface a retry.
      console.error("resumeConvo failed", e);
      setInitErr("resume");
    } finally {
      setLoading(false);
    }
  }, [saved, seedId, callAPI, init, pop]);

  const sendMsg = useCallback(async (ov, chip) => {
    init();
    const txt = ov!==undefined ? ov.trim() : input.trim();
    if (!txt||loading||attaching||attachingRef.current||busyRef.current) return; // don't start a send while one is in flight or a file is being read (attachingRef is the synchronous check; `attaching` state lags)
    // Oversize-paste guard: a huge paste would blow the server body cap and just
    // 413 (a dead "resend" loop). Steer it to the attach path, which extracts and
    // caps the text properly. Keep the text in the box so nothing is lost.
    if (txt.length > COMPOSER_MAX_CHARS) { setAttachNote(AT("pasteTooBig", uiLang)); return; }
    setAttachNote(null);
    setInput(""); if (taRef.current) taRef.current.style.height = "auto";
    setMessages(p=>[...p,{role:"user",content:txt,timestamp:gts(),at:gat(),isChip:!!chip,chipLabel:chip}]);
    await sendToAPI(txt);
  }, [input, loading, attaching, sendToAPI, init, uiLang]);

  // A client can attach a supporting document at ANY point (Mckensey's ask), not
  // just at the QUERIES step. The document is treated as CONTEXT, never dumped
  // into the chat: the visible bubble is a clean chip, while a BOUNDED excerpt goes
  // to the model with an instruction to pre-fill + confirm (not regurgitate). The
  // small cap keeps the round-trip fast — a raw multi-thousand-line dump was what
  // timed the serverless call out on the live build.
  const sendAttachment = useCallback(async (file) => {
    if (!file || loading || attaching || attachingRef.current || busyRef.current) return;
    // Claim the synchronous lock BEFORE the first await (file extraction), so a
    // widget Confirm/Skip or a typed send during extraction can't slip through and
    // steal busyRef, which would make the sendToAPI below bail and drop the file.
    attachingRef.current = true;
    setAttachNote(null);
    setAttaching(true);
    try {
      const r = await extractFileText(file);
      if (r.error) { setAttachNote(ATERR(r.error, uiLang, { name: file.name, mb: r.mb })); return; }
      const raw = (r.text || "").trim();
      if (!raw) { setAttachNote(ATERR("noText", uiLang, { name: file.name })); return; }
      const truncated = raw.length > ATTACH_MAX_CHARS;
      const excerpt = truncated ? raw.slice(0, ATTACH_MAX_CHARS) : raw;
      init();
      // Visible: a clean attachment chip (NOT the raw text).
      setMessages(p=>[...p,{role:"user",content:file.name,isAttachment:true,attachTrunc:truncated,timestamp:gts(),at:gat()}]);
      // Model-facing: framed context (English instruction is fine — the model still
      // replies in the client's language). Bounded so it can't derail or time out.
      const framed = `[The client attached a supporting document named "${safeAttachName(file.name)}". Use the content below to PRE-FILL anything relevant to the CURRENT step of onboarding and CONFIRM those details with the client in your reply. Do NOT read the document back verbatim and do NOT paste a long summary — weave what's useful into the guided flow, then continue.${truncated ? " NOTE: only the first part of the document is included." : ""}]\n\n${excerpt}`;
      await sendToAPI(framed, false, { failMessage: AT("failed", uiLang) });
    } finally {
      attachingRef.current = false;
      setAttaching(false);
    }
  }, [loading, attaching, uiLang, init, sendToAPI]);

  const onAttachFile = useCallback((e) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (f) sendAttachment(f);
  }, [sendAttachment]);

  const onWSubmit = useCallback((mi, type, data) => {
    if (busyRef.current || attachingRef.current) return; // a turn is in flight OR a file is being read — ignore the tap rather than queue a second user turn (would 400) or drop the attachment
    const key = `${mi}-${type}`;
    const isUp = !!wRef.current[key];
    const sum = widgetSum(type, data);
    // State updater stays pure; the message + API call happen here, once.
    setWState(prev => ({...prev,[key]:{submitted:true,data}}));
    setMessages(m=>[...m,{role:"user",content:`${isUp?"✎ Updated":"✓"} ${type}: ${sum}`,isWidget:true,timestamp:gts(),at:gat()}]);
    // A large QUERIES import is the one widget submit big enough to time out the
    // round-trip (what Mckensey hit). Give it the same honest failure message as the
    // composer attach instead of the dead "didn't go through" banner, so the client
    // knows to submit fewer at a time or hand over a whole doc via the paperclip.
    const opts = type==="QUERIES" && data!=="__skip__" ? { failMessage: AT("failed", uiLang) } : {};
    sendToAPI(`[Widget ${isUp?"updated":"submitted"} — ${type}]: ${widgetApiPayload(type, data)}`, false, opts);
  }, [sendToAPI, uiLang]);

  const onWSkip = useCallback((mi, type) => {
    if (busyRef.current || attachingRef.current) return; // in-flight / extracting guard, same as onWSubmit
    const key = `${mi}-${type}`;
    setWState(p=>({...p,[key]:{submitted:true,data:"__skip__"}}));
    setMessages(m=>[...m,{role:"user",content:`Skipped ${type}`,isWidget:true,timestamp:gts(),at:gat()}]);
    sendToAPI(`[Widget skipped — ${type}]`);
  }, [sendToAPI]);

  const renderWidget = useCallback((type, mi, topicSuggestions) => {
    const key = `${mi}-${type}`;
    // Suppress a duplicate single-shot widget already submitted on another turn — but
    // NOT TOPICS: the flow legitimately shows multiple TOPIC_SUGGESTION batches across
    // turns ("anything missing?" -> a new batch), and each batch must stay reviewable.
    if (type !== "TOPICS" && Object.entries(wState).some(([k,v])=>k!==key&&k.endsWith(`-${type}`)&&(v===true||v?.submitted))) return null;
    const ws = wState[key], sub = ws===true||ws?.submitted===true;
    if (sub) return <div style={{padding:"12px 16px",background:C.hi,borderRadius:10,border:`1px solid ${C.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div style={{fontSize:13,color:C.text,fontWeight:600}}>{WL(ws?.data==="__skip__"?"skippedLbl":"submittedLbl",uiLang)}</div>
      {/* Reopening a SKIPPED widget must also drop the skip sentinel. Leaving it in
          place would hand "__skip__" back to the widget as initialData on the next
          render (crash), and — because wState is autosaved into the draft — would
          persist that state so a reload reproduced it. Clear it here as well as in
          widgetInitialData, so neither the caller nor the widget is a single point
          of failure. */}
      <button onClick={()=>setWState(p=>({...p,[key]:{...p[key],submitted:false,data:p[key]?.data===SKIP?undefined:p[key]?.data}}))} style={{background:"transparent",border:`1px solid ${LINK}`,color:LINK,borderRadius:6,padding:"6px 14px",fontSize:12,cursor:"pointer"}}>{WL("editBtn",uiLang)}</button>
    </div>;
    const pd = widgetInitialData(ws), os = d=>onWSubmit(mi,type,d), sk = ()=>onWSkip(mi,type);
    const userPrefill = pd || (cdata.company?.email ? [{
      firstName:(cdata.company.contact||"").split(" ")[0]||"",
      lastName:(cdata.company.contact||"").split(" ").slice(1).join(" "),
      email:cdata.company.email, role:"", access:"Admin"
    }] : []);
    const WHY = { MARKETS:WL("whyMarkets",uiLang), TEAMS:WL("whyTeams",uiLang), USERS:WL("whyUsers",uiLang), QUERIES:WL("whyQueries",uiLang), TOPICS:WL("whyTopics",uiLang) };
    // While a turn is in flight, onWSubmit/onWSkip already bail on busyRef — but
    // they bailed SILENTLY, and every widget went on rendering its Confirm button
    // at full opacity with a pointer cursor. Measured in a real browser: styling
    // byte-identical to the idle state, the click swallowed, no message, no error.
    // A client who taps Confirm and sees nothing happen taps again, or assumes the
    // app is broken. Dimming the whole widget makes the existing guard visible,
    // in one place, for all five widget types. It also freezes chip selection for
    // the few seconds a turn takes, which is a fair price for never showing a
    // control that looks live and is not.
    return <div aria-busy={loading ? "true" : undefined}
      style={loading ? { opacity: 0.55, pointerEvents: "none", transition: "opacity .15s" } : { transition: "opacity .15s" }}>
      {WHY[type] && <div style={{fontSize:11,color:C.muted,margin:"0 0 6px",fontStyle:"italic"}}>{WHY[type]}</div>}
      {type==="QUERIES"   && <QueriesWidget onSubmit={os} initialData={pd} lang={uiLang}/>}
      {/* initialData, like every other widget here. Without it TopicCards re-seeded from
          `suggestions` — the model's ORIGINAL batch stored on the message — every time it
          mounted, so a client who renamed their topics, confirmed, then hit Edit to tweak
          one thing found all of their edits silently replaced by the AI's first guesses.
          Confirming again would then overwrite their own good data. Topics are what Lumen
          actually gets configured with, so this was the worst field to lose. */}
      {type==="TOPICS"    && (pd?.length>0 || topicSuggestions?.length>0) && <TopicCards suggestions={topicSuggestions} initialData={pd} onConfirm={os} onSkip={sk} lang={uiLang}/>}
      {type==="MARKETS"   && <ChipSelector options={MARKETS_OPT}  onSubmit={os} onSkip={sk} placeholder={WL("phMarket",uiLang)}   hint={WL("hintSelectAll",uiLang)}    initialData={pd||[]} lang={uiLang}/>}
      {type==="LANGUAGES" && <ChipSelector options={LANG_OPT}     onSubmit={os} onSkip={sk} placeholder={WL("phLanguage",uiLang)} hint={WL("hintSelectAll",uiLang)}  initialData={pd||[]} lang={uiLang}/>}
      {type==="OBJECTIVES"&& <RankedSelector options={OBJ_OPT}   onSubmit={os} onSkip={sk} max={WIDGET_MAX.OBJECTIVES}    hint={WL("hintObjectives",uiLang)} initialData={pd} lang={uiLang}/>}
      {type==="TEAMS"     && <ChipSelector options={TEAM_OPT}     onSubmit={os} onSkip={sk} placeholder={WL("phTeam",uiLang)}     hint={WL("hintTeams",uiLang)}      initialData={pd||[]} lang={uiLang}/>}
      {type==="TIMEZONE"  && <ChipSelector options={TZ_OPT}       onSubmit={os} onSkip={sk} max={WIDGET_MAX.TIMEZONE}      hint={WL("hintTimezone",uiLang)}   initialData={pd||[]} lang={uiLang}/>}
      {type==="USERS"     && <UserForm onSubmit={os} onSkip={sk} initialData={userPrefill} lang={uiLang}/>}
    </div>;
  }, [wState, onWSubmit, onWSkip, C, cdata, uiLang, loading]);

  if (!checked) return <BootScreen label="Loading…"/>;

  const SHOW = 6, canCollapse = messages.length>SHOW, vStart = canCollapse&&collapsed ? messages.length-SHOW : 0;
  const last = messages[messages.length-1], showQR = last?.role==="assistant"&&last?.quickReplies?.length>0&&!loading;
  const done = progress.percent === 100;

  const gwp = type => { const es=Object.entries(wState).filter(([k,v])=>k.endsWith(`-${type}`)&&(v===true||v?.submitted)).sort((a,b)=>(parseInt(a[0])||0)-(parseInt(b[0])||0)); return es.length?es[es.length-1][1].data:null; };
  const fmtV = v => { if (v==null||v===""||(Array.isArray(v)&&!v.length)) return null; if (v==="__skip__") return "Skipped"; return Array.isArray(v)?v.join(", "):String(v); };
  const topicsList = (cdata.topics?.length?cdata.topics:Array.isArray(gwp("TOPICS"))?gwp("TOPICS"):[]);
  const usersList  = unionUsers(gwp("USERS"), cdata.users);
  const sideCol = ww >= SIDE_COL_MIN;
  const panelRows = [
    [L("pnlCompany",uiLang), fmtV(cdata.company?.name)],
    [L("pnlEmail",uiLang), fmtV(cdata.company?.email)],
    [L("pnlIndustry",uiLang), fmtV(cdata.company?.industry)],
    [L("pnlGoal",uiLang), fmtV(cdata.company?.useCase)],
    [L("pnlMarkets",uiLang), fmtV(gwp("MARKETS"))],
    [L("pnlLanguages",uiLang), fmtV(gwp("LANGUAGES"))],
    [L("pnlObjectives",uiLang), gwp("OBJECTIVES")==="__skip__" ? L("pnlSkipped",uiLang) : (fmtRanked(gwp("OBJECTIVES")) || fmtV(cdata.company?.objectives))],
    [L("pnlTeams",uiLang), fmtV(gwp("TEAMS"))],
    [L("pnlTimezone",uiLang), fmtV(gwp("TIMEZONE"))],
    [L("pnlTopics",uiLang), topicsList.length?`${topicsList.length}: `+topicsList.map(t=>t.name).filter(Boolean).join(", "):null],
    [L("pnlChannels",uiLang), cdata.channels?.length?`${cdata.channels.length}: `+cdata.channels.map(c=>c.author).filter(Boolean).join(", "):null],
    [L("pnlReports",uiLang), cdata.reports?.length?cdata.reports.map(r=>r.name).filter(Boolean).join(", "):null],
    [L("pnlAlerts",uiLang), cdata.alerts?.length?cdata.alerts.map(a=>a.name).filter(Boolean).join(", "):null],
    [L("pnlUsers",uiLang), usersList.length?usersList.map(u=>`${u.firstName} (${u.access})`).join(", "):null],
  ];

  return (
    <div className="lm-theme" dir={uiLang==="Arabic"?"rtl":"ltr"} style={{fontFamily:"'Inter', Arial, sans-serif",height:"100%",background:C.bg,display:"flex",flexDirection:"column",color:C.text,overflow:"hidden"}}>
      <style>{`
@keyframes slideUpFade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes bounce{0%,80%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-4px);opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes orbBreathe{0%,100%{transform:scale(1)}50%{transform:scale(1.04)}}
@keyframes haloPulse{0%,100%{opacity:.45;transform:scale(1)}50%{opacity:.8;transform:scale(1.08)}}
@keyframes popIn{0%{transform:scale(.3);opacity:0}70%{transform:scale(1.18)}100%{transform:scale(1);opacity:1}}
@keyframes drawCheck{to{stroke-dashoffset:0}}
@keyframes captureFlash{from{background:rgba(126,72,236,.16)}to{background:transparent}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes modalPop{from{opacity:0;transform:scale(.96)}to{opacity:1;transform:scale(1)}}
:root{--dur-fast:120ms;--dur-base:200ms;--dur-slow:320ms;--ease-out:cubic-bezier(.2,0,0,1)}
*{box-sizing:border-box}
button{transition:transform var(--dur-fast) var(--ease-out),box-shadow var(--dur-base) var(--ease-out),background-color var(--dur-base) var(--ease-out),border-color var(--dur-base) var(--ease-out),filter var(--dur-base) var(--ease-out)}
button:not([disabled]):hover{transform:translateY(-1px);filter:brightness(1.04)}
button:not([disabled]):active{transform:translateY(0) scale(.985);filter:brightness(.97)}
a{transition:color var(--dur-base) var(--ease-out),opacity var(--dur-base) var(--ease-out)}
::selection{background:rgba(126,72,236,.20)}
::-moz-selection{background:rgba(126,72,236,.20)}
.lm-theme{transition:background-color var(--dur-base) var(--ease-out),color var(--dur-base) var(--ease-out)}
/* Arabic face. !important because the element that carries dir="rtl" also carries an
   inline font-family, and a normal stylesheet rule loses to an inline style — which is
   why this rule silently never applied and Arabic fell back to Arial. An author
   !important DOES win over a normal inline declaration, so this is the one place it
   is load-bearing rather than lazy. Inter has no Arabic glyphs; Geeza Pro (macOS) and
   Noto Sans Arabic (Android/Linux, and Windows via Noto) do. */
[dir="rtl"]{font-family:'Inter','Geeza Pro','Noto Sans Arabic',Tahoma,Arial,sans-serif !important}
button:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible,[tabindex]:focus-visible{outline:2px solid #6D28D9 !important;outline-offset:2px !important}
@media (prefers-reduced-motion: reduce){*{animation:none !important;transition:none !important}}
/* Form controls don't inherit font-family by default — textareas fall back to the
   UA monospace, so the composer/paste boxes rendered in a typewriter font instead
   of Inter. Inherit it so every field matches the app. Inline fontFamily overrides
   (e.g. the DEV panels' Arial) still win, as they should. */
input,textarea,select,button{font-family:inherit}
@media (max-width:640px){input,textarea,select{font-size:16px !important}}`}</style>

      {showExport && <ModalBoundary onClose={()=>setShowExport(false)}><ExportModal cdata={cdata} wState={wState||{}} messages={messages} onClose={()=>setShowExport(false)} onExport={(merged,users)=>{doExport(merged,users,messages,uiLang);}} onSend={handleSend} sending={sending} sendErr={sendErr} sent={sent} sheetLink={sheetLink} uiLang={uiLang}/></ModalBoundary>}

      {showPanel && started && <div style={{position:"fixed",top:headerH,...(uiLang==="Arabic"?{left:0,borderRight:`1px solid ${C.border}`}:{right:0,borderLeft:`1px solid ${C.border}`}),bottom:0,width:mob?"100%":320,background:C.card,zIndex:500,overflowY:"auto",padding:"16px 18px",boxShadow:sideCol?"none":`${uiLang==="Arabic"?"4px":"-4px"} 0 16px rgba(0,0,0,0.08)`}}>
        {/* Header: a LABELLED "Hide" control, not a lone ✕. The faint ✕ read as
            decoration and clients did not realise the panel could be closed. */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:14,color:C.text,display:"flex",alignItems:"center",gap:7}}><span style={{color:LINK,display:"inline-flex"}}><Ic d={IC.panel} size={14}/></span>{L("panelTitle",uiLang)}</div>
          <button onClick={()=>setShowPanel(false)} aria-label={L("panelHide",uiLang)} style={{display:"inline-flex",alignItems:"center",gap:5,background:C.hi,border:`1px solid ${C.border}`,borderRadius:999,color:C.muted,fontSize:11,fontWeight:600,cursor:"pointer",padding:"4px 11px"}}>
            {L("panelHide",uiLang)}<span aria-hidden="true" style={{fontSize:13,lineHeight:1}}>{uiLang==="Arabic"?"‹":"›"}</span>
          </button>
        </div>
        {/* Captured rows carry a check and a per-field Fix button; everything still to
            come is listed by name rather than collapsed into a count, so the client can
            see what's ahead instead of facing dead space. No progress bar here: the
            stepper above the chat already owns overall progress. */}
        {(() => {
          const captured = panelRows.filter(([,v]) => v);
          const pending  = panelRows.filter(([,v]) => !v);
          const tick = <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{flexShrink:0}}><circle cx="8" cy="8" r="8" fill="#16a34a"/><path d="M4.5 8.2l2.2 2.2 4.8-4.8" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
          return <>
            {captured.map(([label,val]) => <div key={label} style={{display:"flex",alignItems:"flex-start",gap:8,margin:"0 -6px 10px",padding:"3px 6px",borderRadius:6,animation:REDUCE_MOTION?"none":"captureFlash 1.2s ease-out"}}>
              <div style={{minWidth:0,flex:1}}>
                <div style={{fontSize:10,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:3,display:"flex",alignItems:"center",gap:5}}>{tick}{label}</div>
                <div style={{fontSize:12,color:C.text,lineHeight:1.5,fontWeight:600}}>{val}</div>
              </div>
              {/* Values stay READ-ONLY. Editing them here would desync the assistant
                  (it re-emits its own understanding and would silently overwrite a
                  manual edit), so Fix seeds a correction into the composer and lets the
                  correction flow through the conversation instead. Full hands-on editing
                  lives in the review modal at send, where there's no model left to desync. */}
              <button onClick={()=>{setInput(L("panelFixStarter",uiLang,{label}));if(mob)setShowPanel(false);setTimeout(()=>taRef.current?.focus(),50);}}
                aria-label={L("panelFixAria",uiLang,{label})} title={L("panelFixAria",uiLang,{label})}
                style={{flexShrink:0,display:"inline-flex",alignItems:"center",justifyContent:"center",width:24,height:24,marginTop:1,borderRadius:6,background:"transparent",border:`1px solid ${C.border}`,color:C.muted,cursor:"pointer",padding:0}}>
                <Ic d={IC.pencil} size={11}/>
              </button>
            </div>)}
            {captured.length===0 && <div style={{fontSize:12,color:C.muted,lineHeight:1.6}}>{L("panelEmpty",uiLang)}</div>}
            {pending.length>0 && <div style={{marginTop:captured.length?12:14,paddingTop:captured.length?12:0,borderTop:captured.length?`1px solid ${C.border}`:"none"}}>
              <div style={{fontSize:10,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:7}}>{L("panelStillTo",uiLang)}</div>
              {pending.map(([label]) => <div key={label} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",fontSize:12,color:C.muted}}>
                <span aria-hidden="true" style={{flexShrink:0,width:13,height:13,borderRadius:"50%",border:`1.5px solid ${C.border}`}}/>{label}
              </div>)}
            </div>}
            {/* The generic correction hint that used to sit here is gone: every captured
                row already has its own "Correct X in the chat" pencil (Fix, above), and
                every chat message already carries a visible, always-shown Edit link right
                under it. Both are self-explanatory on their own; a sentence telling people
                they can "just type a correction" was teaching a weaker version of what two
                actual buttons already do, in an interface that's a chat and already sells
                itself as "a conversation, not a form." */}
          </>;
        })()}
      </div>}

      {/* Header */}
      <div ref={headerRef} style={{background:C.card,borderBottom:`1px solid ${C.border}`,padding:mob?"8px 12px":"0 24px",display:"flex",alignItems:"center",justifyContent:"space-between",minHeight:56,height:mob?"auto":56,flexWrap:mob?"wrap":"nowrap",gap:mob?6:0,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <LumenMark size={32}/>
          <div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{display:"inline-flex",flexDirection:"column",lineHeight:1.05}}>
                <span style={{fontWeight:800,fontSize:16,color:A,letterSpacing:"-0.01em"}}>Lumen</span>
                <span style={{fontWeight:700,fontSize:8,color:dark?"#8fa8d8":NAVY,letterSpacing:"0.02em"}}>by Talkwalker</span>
              </span>
              {/* The mode label is deliberately quieter than the wordmark: at equal
                  weight "Lumen" and "Onboarding Assistant" read as two competing
                  headlines. Small uppercase behind a hairline divider makes the brand
                  lead and this read as what it is, the mode. */}
              <span style={{color:C.muted,fontSize:9.5,fontWeight:700,letterSpacing:"0.07em",textTransform:"uppercase",paddingInlineStart:8,borderInlineStart:`1px solid ${C.border}`,whiteSpace:"nowrap"}}>{L("hdrAssistant",uiLang)}</span>
            </div>
            <div style={{fontSize:11,color:C.muted,marginTop:1}}>
              <>{L("hdrTagline",uiLang)}</>
            </div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {started && <button onClick={()=>setShowPanel(s=>!s)} aria-label={showPanel?"Hide captured answers":"Show captured answers"} aria-pressed={showPanel} title="Show what's been captured so far" style={{background:showPanel?A:C.card,border:`1px solid ${showPanel?A:C.border}`,borderRadius:"50%",width:32,height:32,cursor:"pointer",color:showPanel?"white":C.muted,display:"inline-flex",alignItems:"center",justifyContent:"center"}}><Ic d={IC.panel}/></button>}
          <button onClick={()=>{init();setSound(s=>!s);}} aria-label={sound?"Turn sound off":"Turn sound on"} title={sound?"Sound on":"Sound off"} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"50%",width:32,height:32,cursor:"pointer",color:C.muted,display:"inline-flex",alignItems:"center",justifyContent:"center"}}><Ic d={sound?IC.sound:IC.mute}/></button>
          <button onClick={()=>setTheme(th=>th==="dark"?"light":"dark")} aria-label={dark?"Switch to light mode":"Switch to dark mode"} title={dark?"Light mode":"Dark mode"} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:"50%",width:32,height:32,cursor:"pointer",color:C.muted,display:"inline-flex",alignItems:"center",justifyContent:"center"}}><Ic d={dark?IC.sun:IC.moon}/></button>
        </div>
      </div>

      {/* Stepper */}
      {started && <div style={{background:C.card,borderBottom:`1px solid ${C.border}`,padding:"14px 24px",flexShrink:0}}>
        {/* Same translate as the message column and the composer below. The outer
            bar stays full-width (it carries the background and border); only this
            centred block moves, so the stepper keeps sitting directly above the
            conversation it describes. Without it the chat shifted 160px when the
            side panel opened and the stepper did not — measured at 1440x900,
            centres 560 vs 720. Matching the easing keeps them moving together. */}
        <div style={{maxWidth:640,margin:"0 auto",display:"flex",alignItems:"flex-end",gap:16,transform:sideCol&&showPanel&&started?(uiLang==="Arabic"?"translateX(160px)":"translateX(-160px)"):"none",transition:"transform 0.25s ease"}}>
          <div style={{flex:1}}><Stepper progress={progress} dark={dark} compact={mob} lang={uiLang}/></div>
          {/* Shown on mobile too (compact form): the welcome screen promises "pause
              anytime", and the mostly-mobile audience needs the safe-to-leave signal. */}
          {/* crossDevice, not bare seedId: the "any device" wording is a promise about
              the SERVER draft, so it must not outlive a server draft that is failing.
              srvOk===null (nothing written yet) stays optimistic; only a real failure
              downgrades to the on-device wording, and if THAT is failing too the
              indicator disappears rather than claim something untrue. */}
          {!sent && (draftOk || crossDevice) && <div style={{fontSize:11,color:C.muted,whiteSpace:"nowrap",paddingBottom:2}}>{L(mob?"savedShort":(crossDevice?"savedFullAny":"savedFull"),uiLang)}</div>}
        </div>
      </div>}

      <div aria-live="polite" style={{position:"absolute",width:1,height:1,overflow:"hidden",clip:"rect(0 0 0 0)",whiteSpace:"nowrap"}}>
        {(messages.filter(m=>m.role==="assistant").slice(-1)[0]?.content)||""}
      </div>
      {/* Messages */}
      <div ref={msgRef} style={{flex:1,overflowY:"auto",padding:"24px 16px",maxWidth:760,width:"100%",margin:"0 auto",alignSelf:"center",transform:sideCol&&showPanel&&started?(uiLang==="Arabic"?"translateX(160px)":"translateX(-160px)"):"none",transition:"transform 0.25s ease"}}>

        {!started && !saved && (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"100%",padding:"18px 24px 20px",textAlign:"center",position:"relative",overflow:"hidden"}}>
            {/* Masked and shortened (was 220px tall, unmasked): the 2px stroke used to run
                straight through the h1 glyphs and read as a line struck through the title,
                worst on mobile where it wraps to two lines and sits deeper into the band.
                The band now fades out above the heading and reads as a backdrop to the mark. */}
            <svg aria-hidden="true" viewBox="0 0 900 240" preserveAspectRatio="none" style={{position:"absolute",top:0,left:0,width:"100%",height:120,pointerEvents:"none",WebkitMaskImage:"linear-gradient(to bottom, #000 40%, transparent 100%)",maskImage:"linear-gradient(to bottom, #000 40%, transparent 100%)"}}>
              <defs><linearGradient id="lw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#7C3AED" stopOpacity="0"/><stop offset="0.5" stopColor="#7C3AED" stopOpacity="0.16"/><stop offset="1" stopColor="#7C3AED" stopOpacity="0"/></linearGradient></defs>
              <path d="M0,150 C180,60 320,220 480,130 C640,40 760,180 900,90 L900,0 L0,0 Z" fill="url(#lw)"/>
              <path d="M0,190 C220,110 380,240 560,150 C720,70 820,200 900,140" fill="none" stroke="#7C3AED" strokeOpacity="0.18" strokeWidth="2"/>
            </svg>
            <div style={{position:"relative",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:2,animation:"slideUpFade .5s ease-out both"}}>
              <div aria-hidden="true" style={{position:"absolute",width:150,height:150,borderRadius:"50%",background:"radial-gradient(closest-side, rgba(126,72,236,.22), transparent)",animation:"haloPulse 4s ease-in-out infinite",pointerEvents:"none"}}/>
              <div style={{position:"relative",animation:"orbBreathe 5s ease-in-out infinite"}}><LumenMark size={68}/></div>
            </div>
            <h1 style={{margin:"10px 0 6px",color:C.text,fontSize:26,fontWeight:700,animation:"slideUpFade .5s ease-out both",animationDelay:"60ms"}}>{(seed&&seed.contactName)?L("welcomeTitleSeeded",uiLang,{name:seed.contactName.split(" ")[0]}):L("welcomeTitle",uiLang)}</h1>
            {seed && <div style={{display:"inline-flex",alignItems:"center",gap:6,margin:"0 0 12px",padding:"5px 13px",borderRadius:999,background:`${A}14`,color:LINK,fontSize:12,fontWeight:600,animation:"slideUpFade .5s ease-out both",animationDelay:"110ms"}}><span aria-hidden="true">✦</span>{L("preparedFor",uiLang,{company:seed.company})}</div>}
            {/* maxWidth matches the steps block below (480) and the disclosure further down,
                rather than each picking its own measure. Five blocks at five different
                widths — 420/480/440/514/353 before this — left no shared vertical edge
                anywhere on the screen, which is what read as "floating" rather than
                composed, even though each width read fine on its own line-length. */}
            <p style={{color:C.muted,fontSize:14,margin:"0 0 14px",maxWidth:480,lineHeight:1.6,animation:"slideUpFade .5s ease-out both",animationDelay:"150ms"}}>{seed?L("welcomeSubSeeded",uiLang,{company:seed.company}):L("welcomeSub",uiLang)}</p>
            {/* Prepared-link load failed (expired or store error). Copy is intentionally
                inline English: this path forces uiLang to English (the seed, and its
                language, never loaded), so an i18n key would only ever render English
                here anyway. Non-blocking — the client can still start fresh below. */}
            {seedError && !seed && <div role="status" style={{maxWidth:440,margin:"0 0 22px",padding:"11px 15px",borderRadius:T.radius.md,background:dark?"#3a2f12":"#fffbeb",border:`1px solid ${dark?"#5b4a1a":"#fde68a"}`,color:dark?"#fde68a":"#92400e",fontSize:13,lineHeight:1.5,textAlign:"left",animation:"slideUpFade .5s ease-out both",animationDelay:"170ms"}}>{L(seedExpired ? "seedErrExpired" : "seedErrTransient", uiLang)}</div>}
            {/* Deliberately NOT capped to the 480 measure used below: six pills need 514px
                to sit on one line, and constraining the row wrapped them 5+1, orphaning the
                Arabic pill alone on its own line — worse than the misalignment it was meant
                to fix. A wrapping button row reads fine at its own natural width; it's the
                paragraphs that needed a shared edge. */}
            <div style={{margin:"0 0 16px",animation:"slideUpFade .5s ease-out both",animationDelay:"210ms"}}>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:C.muted,marginBottom:8}}>{L("chooseLang",uiLang)}</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center",alignItems:"center"}}>
                {UI_LANGS.map(l => { const on = uiLang===l.code; return (
                  <button key={l.code} onClick={()=>setUiLang(l.code)} aria-pressed={on} style={{padding:"9px 16px",borderRadius:999,fontSize:13,minHeight:40,cursor:"pointer",border:"1px solid",background:on?A:"transparent",borderColor:on?A:C.border,color:on?"white":C.text,fontWeight:on?700:500,boxShadow:on?"0 4px 14px rgba(126,72,236,0.30)":"none",transition:"all 0.15s"}}>{l.native}</button>
                ); })}
              </div>
            </div>
            <div style={{width:"100%",maxWidth:480,margin:"0 auto 18px",textAlign:uiLang==="Arabic"?"right":"left",animation:"slideUpFade .5s ease-out both",animationDelay:"270ms"}}>
              {[[L("step1Title",uiLang),crossDevice?L("step1DescAny",uiLang):(draftOk?L("step1Desc",uiLang):L("step1DescNoSave",uiLang))],
                [L("step2Title",uiLang),L("step2Desc",uiLang)],
                [L("step3Title",uiLang),L("step3Desc",uiLang)]].map(([t,d],i) => (
                <div key={i} style={{display:"flex",gap:12,padding:"7px 0",borderBottom:i<2?`1px solid ${C.border}`:"none"}}>
                  <div style={{width:32,height:32,borderRadius:8,background:`${A}14`,color:A,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,marginTop:1}}><Ic d={[IC.clock,IC.chat,IC.send][i]} size={17}/></div>
                  <div><div style={{fontSize:13,fontWeight:700,color:C.text,marginBottom:2}}>{t}</div><div style={{fontSize:12,color:C.muted,lineHeight:1.5}}>{d}</div></div>
                </div>
              ))}
            </div>
            <p style={{color:C.muted,fontSize:12,margin:"0 0 16px",maxWidth:480,lineHeight:1.6,animation:"slideUpFade .5s ease-out both",animationDelay:"360ms"}}>{L("disclaimer",uiLang)}</p>
            <button onClick={startConvo} style={{background:A,color:"white",border:"none",borderRadius:12,padding:"14px 48px",fontSize:15,fontWeight:700,cursor:"pointer",boxShadow:"0 4px 14px rgba(126,72,236,0.30)",animation:"slideUpFade .5s ease-out both",animationDelay:"390ms"}}>{seed?L("startBtnSeeded",uiLang,{company:seed.company}):L("startBtn",uiLang)}</button>
          </div>
        )}

        {!started && saved && (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:380,textAlign:"center"}}>
            <LumenMark size={64}/>
            <h1 style={{margin:"20px 0 8px",color:C.text,fontSize:22,fontWeight:700}}>{L("welcomeBackTitle",uiLang)}</h1>
            <p style={{color:C.muted,fontSize:14,margin:"0 0 8px"}}>{L("welcomeBackDesc",uiLang)}</p>
            {/* Hide a meaningless "0% complete" — a saved-but-barely-started draft
                shouldn't greet the client with a zero. */}
            <p style={{color:P,fontSize:13,fontWeight:600,margin:"0 0 24px"}}>{(saved?.progress?.percent||0) > 0 ? L("savedPercent",uiLang,{pct:saved.progress.percent}) : L(seedId?"savedAnyDevice":"savedOnDevice",uiLang)}</p>
            {/* The language picker also belongs HERE, not only on the first-visit screen.
                Sales sets the seeded language and does not always know it, so a client can
                easily be mid-conversation in the wrong one — and once started there was no
                control anywhere to change it. The only escape was Start over, which erases
                every answer to fix a dropdown. Choosing here marks an explicit override so
                resumeConvo will not immediately restore the saved language over the top. */}
            <div style={{margin:"0 0 22px"}}>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase",color:C.muted,marginBottom:8}}>{L("chooseLang",uiLang)}</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8,justifyContent:"center",alignItems:"center"}}>
                {UI_LANGS.map(l => { const on = uiLang===l.code; return (
                  <button key={l.code} onClick={()=>{ langOverrideRef.current = true; setUiLang(l.code); }} aria-pressed={on} style={{padding:"7px 14px",borderRadius:999,fontSize:12.5,minHeight:36,cursor:"pointer",border:"1px solid",background:on?A:"transparent",borderColor:on?A:C.border,color:on?"white":C.text,fontWeight:on?700:500,transition:"all 0.15s"}}>{l.native}</button>
                ); })}
              </div>
            </div>
            {!confirmFresh ? (
              <div style={{display:"flex",gap:12}}>
                <button onClick={resumeConvo} style={{background:P,color:"white",border:"none",borderRadius:10,padding:"13px 28px",cursor:"pointer",fontWeight:600}}>{L("resumeBtn",uiLang)}</button>
                <button onClick={()=>setConfirmFresh(true)} style={{background:"transparent",border:`1px solid ${C.border}`,color:C.muted,borderRadius:10,padding:"13px 28px",cursor:"pointer"}}>{L("startOverBtn",uiLang)}</button>
              </div>
            ) : (
              /* Two-step confirm: one stray tap next to Resume must not silently erase
                 a draft that can be most of a finished onboarding — that would break
                 the "pick up where you left off" promise the welcome screen makes. */
              <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:12}}>
                <p style={{color:"#92400e",fontSize:13,margin:0,maxWidth:340,lineHeight:1.5}}>{L("eraseWarn",uiLang)}</p>
                <div style={{display:"flex",gap:12}}>
                  <button onClick={()=>setConfirmFresh(false)} style={{background:P,color:"white",border:"none",borderRadius:10,padding:"13px 28px",cursor:"pointer",fontWeight:600}}>{L("keepBtn",uiLang)}</button>
                  <button onClick={()=>{setConfirmFresh(false);const keep=sidRef.current;lsClearDraft(seedId);srvClearDraft(seedId);resetSession();sidRef.current=keep;}} style={{background:"transparent",border:"1px solid #fca5a5",color:"#dc2626",borderRadius:10,padding:"13px 28px",cursor:"pointer",fontWeight:600}}>{L("eraseBtn",uiLang)}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {canCollapse && collapsed && <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:20,paddingInlineStart:38}}>
          <div style={{height:1,width:20,background:C.border}}/>
          <button onClick={()=>setCollapsed(false)} style={{background:"transparent",border:"none",padding:0,fontSize:12,color:C.muted,cursor:"pointer",textDecoration:"underline"}}>{L("showEarlier",uiLang,{n:messages.length-SHOW})}</button>
        </div>}

        {messages.slice(vStart).map((m,ri) => {
          const i = vStart+ri;
          const canEdit = m.role==="user"&&!m.isWidget&&!m.isAttachment&&!loading;
          // Date separator for a resumed conversation. Without it, a bubble from
          // Monday sits flush against one from Thursday and both just show a time,
          // which misleads the client AND the consultant reading the transcript.
          const gap = i>0 ? gapLabel(messages[i-1] && messages[i-1].at, m.at, uiLang) : null;
          const sep = gap ? <div key={"gap"+i} style={{display:"flex",alignItems:"center",gap:10,margin:"4px 0 18px"}} role="separator" aria-label={gap}>
            <div style={{flex:1,height:1,background:C.border}}/>
            <div style={{fontSize:10.5,fontWeight:700,letterSpacing:"0.04em",textTransform:"uppercase",color:C.muted,whiteSpace:"nowrap"}}>{gap}</div>
            <div style={{flex:1,height:1,background:C.border}}/>
          </div> : null;
          if (m.role==="divider") return <div key={"dw"+i}>{sep}<div style={{display:"flex",alignItems:"center",gap:10,margin:"6px 0 22px"}} role="separator" aria-label={`${m.label}${m.sub?`, ${m.sub}`:""}`}>
            <div style={{flex:1,height:1,background:C.border}}/>
            <div style={{fontSize:11,fontWeight:600,color:C.muted,whiteSpace:"nowrap"}}>✓ {m.label}{m.sub?<span style={{fontWeight:400}}> · {m.sub}</span>:null}</div>
            <div style={{flex:1,height:1,background:C.border}}/>
          </div></div>;
          return <div key={"mw"+i}>{sep}<div style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:18,animation:m.role==="assistant"?"slideUpFade 0.4s ease-out forwards":"none"}}>
            {m.role==="assistant" && <div style={{flexShrink:0,marginInlineEnd:10,marginTop:2}}><OwlAvatar/></div>}
            <div style={{maxWidth:m.role==="assistant"?"min(88%, 580px)":"78%"}}>
              {m.content && <div>
                <div style={{background:m.role==="user"?(m.isWidget?C.hi:C.uBg):(dark?C.card:"#F5F3FB"),border:`1px solid ${m.role==="user"?(m.isWidget?P:C.border):(dark?C.border:"#E5E0F3")}`,color:m.role==="user"?(m.isWidget?C.wTx:C.uTx):C.text,borderRadius:uiLang==="Arabic"?14:(m.role==="assistant"?"4px 14px 14px 14px":"14px 4px 14px 14px"),padding:"11px 15px",fontSize:14,lineHeight:1.7,boxShadow:m.role==="assistant"?"0 1px 3px rgba(1,43,58,0.06)":"none"}}>
                  {m.isAttachment
                    ? <div><div style={{display:"flex",alignItems:"center",gap:8}}><Ic d={IC.clip} size={15}/><span style={{wordBreak:"break-word",fontWeight:600}}>{m.content}</span></div>{m.attachTrunc && <div style={{fontSize:11,opacity:0.85,marginTop:4}}>{AT("trunc",uiLang)}</div>}</div>
                    : <MsgText text={m.content}/>}
                </div>
                <div style={{display:"flex",gap:8,alignItems:"center",justifyContent:m.role==="user"?"flex-end":"flex-start",marginTop:4}}>
                  {canEdit && <button onClick={()=>{setInput(L("editPrefill",uiLang,{quote:m.content}));setTimeout(()=>taRef.current?.focus(),50);}} title={L("editTitle",uiLang)} style={{background:"transparent",border:"none",color:"#64748b",cursor:"pointer",fontSize:11,padding:"2px 6px",borderRadius:4,opacity:0.85}}>✎ {L("editLabel",uiLang)}</button>}
                </div>
              </div>}
              {m.role==="assistant" && m.quickReplies?.length>0 && (()=>{
                const next = messages[i+1];
                const chosen = next?.isChip ? next.chipLabel||next.content : null;
                if (chosen) return <div style={{fontSize:11,color:C.muted,marginTop:6,fontStyle:"italic"}}>{L("youChose",uiLang)} <strong style={{color:C.text}}>{chosen}</strong></div>;
                return null;
              })()}
              {/* Early-send offer. There is deliberately NO standing "send now" control
                  during the chat: an always-visible exit invites clients to submit a
                  half-finished brief. Instead the assistant emits [OFFER_SEND] only when
                  the client signals they have to stop, so the option appears at the one
                  moment it is the right answer. Suppressed once sent. */}
              {m.role==="assistant" && m.offerSend && !sent && !done && <div style={{marginTop:10}}>
                <button onClick={()=>setShowExport(true)} style={{display:"inline-flex",alignItems:"center",gap:7,background:dark?"#241c3d":"#f4f1fe",border:`1px solid ${dark?"#3a2f5c":"#e0d6fb"}`,color:LINK,borderRadius:9,padding:"9px 15px",fontSize:12.5,fontWeight:700,cursor:"pointer"}}>
                  <Ic d={IC.send} size={13}/>{L("sendNowBtn",uiLang)}
                </button>
              </div>}
              {m.role==="assistant" && m.widgets?.map((w,wi) => {
                // renderWidget returns null for a widget that is suppressed (e.g. a
                // single-shot type already submitted on an earlier turn, like a
                // re-offered USERS form). Skip the wrapper entirely in that case;
                // otherwise it draws an empty card — the blank bubble a client can see.
                const rendered = renderWidget(w,i,w==="TOPICS"?m.topicSuggestions:null);
                if (!rendered) return null;
                return <div key={w} ref={i===messages.length-1&&wi===0?lastWidgetRef:null} role="group" aria-label={L("focusWidgetGroup",uiLang)} tabIndex={-1} style={{background:C.card,border:`1px solid ${C.border}`,borderLeft:`3px solid ${A}`,borderRadius:12,padding:"12px 14px",marginTop:8,boxShadow:"0 2px 10px rgba(1,43,58,0.08)",outline:"none"}}>{rendered}</div>;
              })}
            </div>
          </div></div>;
        })}

        {showQR && !loading && <div ref={qrRef} role="group" aria-label={L("focusRepliesGroup",uiLang)} tabIndex={-1} style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:-8,marginBottom:18,marginInlineStart:38,marginInlineEnd:0,outline:"none"}}>
          {last.quickReplies.map((qr,idx) => {
            // Action chip: opens the composer's file picker instead of sending text.
            // Tolerant of the model translating the token — see isAttachToken.
            const isAttach = isAttachToken(qr);
            return <button key={idx} onClick={isAttach?(()=>attachRef.current?.click()):(()=>sendMsg(qr,qr))} disabled={isAttach&&(loading||attaching)} style={{background:"transparent",border:`1px solid ${LINK}`,color:LINK,borderRadius:16,padding:"6px 14px",fontSize:13,cursor:"pointer",fontWeight:600}}>{isAttach?<span style={{display:"inline-flex",alignItems:"center",gap:6}}><Ic d={IC.clip} size={13}/>{AT("label",uiLang)}</span>:qr}</button>;
          })}
        </div>}
        {loading && <div role="status" aria-live="polite" aria-label={L("thinking",uiLang)} style={{display:"flex",justifyContent:"flex-start",marginBottom:18,animation:"slideUpFade 0.3s ease-out forwards"}}>
          <div style={{flexShrink:0,marginInlineEnd:10,marginTop:2}}><OwlAvatar/></div>
          <div style={{background:dark?C.card:"#F5F3FB",border:`1px solid ${dark?C.border:"#E5E0F3"}`,borderRadius:14,padding:"14px 18px",maxWidth:"88%",boxShadow:"0 1px 3px rgba(1,43,58,0.06)"}}>
            {/* `attaching` stays true for the WHOLE document turn (set before file
                extraction, cleared only after sendToAPI resolves), so it doubles
                cleanly as "this loading turn is a doc turn" without new state. */}
            <TypingIndicator lang={uiLang} doc={attaching}/>
          </div>
        </div>}

        {retryMsg && !loading && <div style={{display:"flex",justifyContent:"flex-start",marginBottom:18,animation:"slideUpFade 0.3s ease-out forwards"}}>
          <div style={{flexShrink:0,marginInlineEnd:10,marginTop:2}}><OwlAvatar/></div>
          <div style={{background:dark?"#3a2f1a":"#fffbeb",border:`1px solid ${dark?"#5c4a24":"#fde68a"}`,borderRadius:12,padding:"12px 16px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{flexShrink:0}}><path d="M1 1l22 22 M16.72 11.06A10.94 10.94 0 0 1 19 12.55 M5 12.55a10.94 10.94 0 0 1 5.17-2.39 M10.71 5.05A16 16 0 0 1 22.58 9 M1.42 9a15.91 15.91 0 0 1 4.7-2.88 M8.53 16.11a6 6 0 0 1 6.95 0 M12 20h.01"/></svg>
            <span style={{fontSize:13,color:dark?"#e8d9b5":"#92400e"}}>{L("retryFail",uiLang)}</span>
            <button onClick={()=>sendToAPI(retryMsg,true)} style={{background:A,color:"white",border:"none",borderRadius:8,padding:"7px 16px",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",boxShadow:T.shadow.glow}}>{L("tryAgain",uiLang)}</button>
          </div>
        </div>}

        {initErr && !loading && <div style={{display:"flex",justifyContent:"flex-start",marginBottom:18,animation:"slideUpFade 0.3s ease-out forwards"}}>
          <div style={{flexShrink:0,marginInlineEnd:10,marginTop:2}}><OwlAvatar/></div>
          <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"14px 18px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <span style={{fontSize:13,color:C.muted}}>{L("initErrMsg",uiLang)}</span>
            <button onClick={()=>{ const t=initErr; setInitErr(null); t==="resume"?resumeConvo():startConvo(); }} style={{background:P,color:"white",border:"none",borderRadius:7,padding:"6px 14px",fontSize:12,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>{L("tryAgain",uiLang)}</button>
          </div>
        </div>}

        {/* Show the finish state (Sheet link + next steps) on ANY successful send,
            not only at 100%. A "send anyway" from the review modal submits below 100%,
            so gating on `done` alone dropped the client back into the chat with no
            confirmation or link after an early send. `sent` covers both paths. */}
        {(done || sent) && !loading && <FinishCard C={C} cdata={cdata} setShowExport={setShowExport} linkCopied={linkCopied} setLinkCopied={setLinkCopied} sent={sent} sheetLink={sheetLink} onSeeProserv={onSeeProserv} lang={uiLang}/>}

        <div ref={botRef}/>
      </div>

      {/* Input */}
      {started && <div style={{background:C.card,borderTop:`1px solid ${C.border}`,padding:"12px 16px",paddingBottom:"calc(12px + env(safe-area-inset-bottom, 0px))",flexShrink:0}}>
        <div style={{maxWidth:760,margin:"0 auto",transform:sideCol&&showPanel&&started?(uiLang==="Arabic"?"translateX(160px)":"translateX(-160px)"):"none",transition:"transform 0.25s ease"}}>
          <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
            {/* Attach a supporting document at any point (not just at the QUERIES step). */}
            <input ref={attachRef} type="file" accept=".txt,.csv,.xlsx,.xls,.docx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={onAttachFile} style={{display:"none"}} aria-hidden="true"/>
            <button onClick={()=>attachRef.current?.click()} disabled={loading||attaching} aria-label={AT("label",uiLang)} title={AT("label",uiLang)}
              style={{background:"transparent",border:`1.5px solid ${C.border}`,color:C.muted,borderRadius:12,width:44,height:44,flexShrink:0,cursor:loading||attaching?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",opacity:loading||attaching?0.5:1}}>
              {attaching?<Spinner dark/>:<Ic d={IC.clip} size={18}/>}
            </button>
            <textarea ref={taRef} value={input}
              onChange={e=>{setInput(e.target.value);if(taRef.current){taRef.current.style.height="auto";taRef.current.style.height=taRef.current.scrollHeight+"px";}}}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();}}}
              aria-label={L("phReply",uiLang)} placeholder={last?.role==="assistant"&&(last.widgets||[]).some(w=>!wState[`${messages.length-1}-${w}`]?.submitted)?L("phAnswerAbove",uiLang):L("phReply",uiLang)} rows={1}
              style={{flex:1,background:C.bg,border:`1.5px solid ${C.border}`,borderRadius:10,padding:"11px 14px",fontSize:mob?16:14,resize:"none",outline:"none",color:C.text}}/>
            <button onClick={()=>sendMsg()} aria-label="Send message" disabled={!input.trim()&&!loading}
              style={{background:A,color:"white",border:"none",borderRadius:12,width:44,height:44,cursor:input.trim()||loading?"pointer":"default",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",opacity:input.trim()||loading?1:0.4,boxShadow:input.trim()&&!loading?"0 4px 14px rgba(126,72,236,0.35)":"none"}}>
              {loading?<Spinner/>:<span style={{fontSize:18}}>↑</span>}
            </button>
          </div>
          {attachNote && <div style={{fontSize:11,color:"#92400e",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"6px 10px",marginTop:6}}>{attachNote}</div>}
          {!mob && input.trim() && <div style={{fontSize:11,color:C.muted,marginTop:6,opacity:0.75,textAlign:uiLang==="Arabic"?"left":"right"}}>{L("sendHint",uiLang)}</div>}
          {/* NO standing early-send control here, by design. A permanent "review and
              send" under the composer put an exit in front of every client on every
              turn, and answered "stuck" with "give up", which is exactly the behaviour
              we want to discourage. The escape hatch still exists: the assistant emits
              [OFFER_SEND] the moment a client says they have to stop (see the inline
              offer in the transcript above), and the finish card covers the client who
              completes normally. So it appears when it is the right answer, not before. */}
        </div>
      </div>}
    </div>
  );
}


// ================= DEMO SHELL =================

export function buildWorkbook(XL, merged, users) {
  const co = merged.company || {}, topics = merged.topics || [], channels = merged.channels || [],
        rpts = merged.reports || [], alts = merged.alerts || [];
  const companyName = co.name || "Draft";
  const wb = XL.utils.book_new();

  // Intro paragraphs are SPLIT into short rows sized to the merged width: the
  // community xlsx writer carries no cell styles, so "wrap text" can't be set and
  // a long single-cell paragraph renders as one clipped/overflowing line at
  // default row height — the "glitch at the top" a client reported. Short rows
  // need no wrapping.
  const boSheet = XL.utils.aoa_to_sheet([
    ["Welcome to your Lumen onboarding setup form!"],
    ["During onboarding, our team will configure your initial setup to help you get started quickly."],
    ["Please review and complete each tab: About your business, Users list, Topics/Filters, Social Channels, Reports."],
    [],
    ["Field","Instructions / Example","Comments"],
    ["Company Name","",co.name||""],
    ["Date","",new Date().toLocaleDateString()],
    ["Contact Email","",co.email||""],
    ["Industry","",co.industry||""],
    ["Relevant Geographic Markets","Example: US, Germany, UK",co.markets||""],
    ["Key Languages","Example: English, German",co.languages||""],
    ["Priorities (Top 3 in priority order)","Example: 1. Reputation Management, 2. Competitive Intelligence, 3. Issue Tracking",co.objectives||""],
    ["Priority details","Anything else about your priorities",co.objectiveDetails||""],
    ["Goal","What insights or outcomes are you most interested in?",co.useCase||""],
    ["Preferred Onboarding Language","English",co.onboardingLanguage||"English"],
    ["Preferred Time Zone","CET",co.timezone||""],
    ["Teams/Departments Using Platform","Marketing, Comms, PR",co.teams||""],
    ["Main Point of Contact (Name + Email)","Jane Smith - jane@company.com",co.contact||co.email||""],
    ["Additional Comments or Questions","",""],
  ]);
  boSheet["!merges"] = [{s:{r:0,c:0},e:{r:0,c:2}},{s:{r:1,c:0},e:{r:1,c:2}},{s:{r:2,c:0},e:{r:2,c:2}}];
  boSheet["!cols"]   = [{wch:40},{wch:50},{wch:40}];
  XL.utils.book_append_sheet(wb, boSheet, "About your business");

  // Same no-wrap constraint as above: the old single cell with embedded \n
  // rendered as one broken line — one row per line instead.
  const usersAoa = [
    ["Lumen Scoping Project Structure"],
    ["List of Users Requiring Access to the Tool"],
    ["Admin: Full access to Analytics, Dashboards, Reports, IQ Apps, and Settings."],
    ["Full Tool: Full access excluding user management."],
    ["Read-Only: View-only access."],
    [],
    ["First Name","Last Name","Role/Department","E-mail","Access Rights"],
    ...((users && users.length) ? users.map(u=>[u.firstName||"",u.lastName||"",u.role||"",u.email||"",u.access||""]) : [["","","","",""]]),
  ];
  const usersSheet = XL.utils.aoa_to_sheet(usersAoa);
  usersSheet["!merges"] = [0,1,2,3,4].map(r=>({s:{r,c:0},e:{r,c:4}}));
  usersSheet["!cols"]   = [{wch:15},{wch:15},{wch:20},{wch:30},{wch:15}];
  XL.utils.book_append_sheet(wb, usersSheet, "Users list");

  if (merged.queries && merged.queries !== "__skip__") {
    const qAoa = [
      ["Migrated queries (client's original content, as submitted)"],
      ["Reference for rebuilding queries in Lumen. May contain untranslated syntax from the client's previous tool."],
      [],
      ...String(merged.queries).split("\n").map(l=>[l]),
    ];
    const qSheet = XL.utils.aoa_to_sheet(qAoa);
    qSheet["!merges"] = [{s:{r:0,c:0},e:{r:0,c:2}},{s:{r:1,c:0},e:{r:1,c:2}}];
    qSheet["!cols"]   = [{wch:100}];
    XL.utils.book_append_sheet(wb, qSheet, "Migrated queries");
  }

  const tRows = [
    ["Lumen Project Plan - Topics/Filters"],
    ["Please list the brands, competitors, industry topics, campaigns, or categories you would like to monitor."],
    [],
    ["What is a Topic?","","A Topic is the broad subject you are tracking - the bucket that catches all the data."],
    ["Examples:","","\"Coca-Cola\", \"Apple\", \"Sustainability in Fashion\""],
    ["What is a Filter?","","A Filter is a specific lens you use to sort through the data in a topic."],
    ["Examples:","","Product categories, regions, campaigns, events, holidays, or crisis management topics"],
    ["Full Example:","","Topic: The Walt Disney Company | Filters: Movies, Retail, Disney Parks, Disney+"],
    ["Do you have existing queries to migrate?","","Please export any existing queries and include them below."],
    [],
    ["#","Topics/Filters","Group Name\nExamples: Competitors, Industry, Campaigns","Topic/Filter name","Keywords","URLs","Hashtags","Comments"],
  ];
  topics.forEach((tp,i) => tRows.push([i+1,tp.type||"",tp.group||"",tp.name||"",tp.keywords||"",tp.urls||"",tp.hashtags||"",tp.rationale||tp.comments||""]));
  while (tRows.length < 31) tRows.push([tRows.length-10,"","","","","","",""]);
  const topicsSheet = XL.utils.aoa_to_sheet(tRows);
  topicsSheet["!merges"] = [{s:{r:0,c:0},e:{r:0,c:7}},{s:{r:1,c:0},e:{r:1,c:7}}];
  topicsSheet["!cols"]   = [{wch:4},{wch:12},{wch:20},{wch:25},{wch:30},{wch:30},{wch:15},{wch:40}];
  XL.utils.book_append_sheet(wb, topicsSheet, "Topics-Filters-Hashtags");

  const chRows = [
    ["Lumen Project Plan - Social channels"],
    ["Please list the social media profiles you wish to track (Brands, Competitors, or Influencers)."],
    [],
    ["What is a Channel?","A Channel in Lumen is a specific social media account or online source that you monitor."],
    ["Why Add Channels?","Adding channels allows you to monitor and analyse any public social media account."],
    ["Which channels should I add?","Include your own brand accounts, competitor channels, influencers, or thought leaders."],
    [],
    ["#","Author name","Channel type","Channel URL","Owned/Public"],
    // owned arrives from the model's CHANNELS marker as "true"/"false" — map it to
    // the human labels the column header promises instead of printing raw booleans.
    ...channels.map((c,i) => [i+1,c.author||"",c.type||"",c.url||"",(c.owned==="true"||c.owned===true)?"Owned":(c.owned==="false"||c.owned===false)?"Public":(c.owned||"")]),
  ];
  while (chRows.length < 33) chRows.push([chRows.length-7,"","","",""]);
  const chSheet = XL.utils.aoa_to_sheet(chRows);
  chSheet["!merges"] = [{s:{r:0,c:0},e:{r:0,c:4}},{s:{r:1,c:0},e:{r:1,c:4}}];
  chSheet["!cols"]   = [{wch:4},{wch:25},{wch:15},{wch:45},{wch:15}];
  XL.utils.book_append_sheet(wb, chSheet, "Social Channels");

  const rdRows = [
    ["Lumen Project Plan - Dashboards/Reports"],
    ["You may request dashboards, reports, or alerts during onboarding. Please ensure your Topics are created first."],
    [],
    ["What is a dashboard?","","A fully customisable, interactive overview of your data, shared via URL and updates live."],
    ["What is a report?","","A customisable snapshot for a specific time period, ideal for scheduled email delivery."],
    ["What is an alert?","","An automated email notification triggered by specific events like spikes in mentions or negative sentiment."],
    [],
    ["Dashboard / report / alert name","Main objective","","Details (time frame, KPIs, etc.)","Comments"],
    ...((rpts.length) ? rpts.map(r=>[r.name||"",r.objective||"","",r.details||"",r.comments||""]) : [["","","","",""]]),
    [],
    ["Alert","Name","Type","Details (time frame, KPIs, etc.)","Comments"],
    ...((alts.length) ? alts.map(a=>["Alert",a.name||"",a.type||"",a.details||"",a.comments||""]) : [["Alert","","","",""]]),
  ];
  const rdSheet = XL.utils.aoa_to_sheet(rdRows);
  rdSheet["!merges"] = [{s:{r:0,c:0},e:{r:0,c:4}},{s:{r:1,c:0},e:{r:1,c:4}}];
  rdSheet["!cols"]   = [{wch:30},{wch:30},{wch:5},{wch:30},{wch:30}];
  XL.utils.book_append_sheet(wb, rdSheet, "Reports-Dashboards-Alerts");

  const filename = "Lumen_Setup_Brief_" + companyName.replace(/\s+/g,"_") + "_" + new Date().toISOString().slice(0,10) + ".xlsx";
  return { wb, filename };
}


const TEAL = "#012B3A", CHERRY = "#FF4C46", MINT = "#DFFFDE";

const EXAMPLE_BRIEF = {
  merged: {
    company:{name:"Acme Corp",email:"jane@acmecorp.com",industry:"Consumer Goods (Footwear & Apparel)",useCase:"Protect brand reputation, track competitors, catch customer issues early",contact:"Jane Smith",markets:"United States, United Kingdom",languages:"English",objectives:"Reputation Management, Competitive Intelligence, Crisis Management",teams:"Marketing, PR",timezone:"GMT / UTC"},
    topics:[
      {name:"Acme Corp Brand",keywords:'"Acme Corp" OR @AcmeCorp',urls:"https://acmecorp.com",hashtags:"#AcmeCorp",comments:"Primary brand monitoring"},
      {name:"Nike",keywords:'"Nike" OR @Nike',urls:"",hashtags:"#Nike",comments:"Competitor, client-confirmed"},
      {name:"Customer Service Issues",keywords:'"Acme" AND (refund OR complaint)',urls:"",hashtags:"",comments:"Crisis early warning"},
    ],
    channels:[{author:"Acme Corp",type:"Instagram",url:"https://instagram.com/acmecorp",owned:"Owned"}],
    reports:[{name:"Brand Health Dashboard",objective:"Reputation Management",details:"Real-time, all markets",comments:""}],
    alerts:[{name:"Crisis Alert",type:"Sentiment spike",details:"Negative sentiment > 20% in 1 hour",comments:""}],
  },
  users:[{firstName:"Jane",lastName:"Smith",email:"jane@acmecorp.com",role:"Marketing Director",access:"Admin"}],
  handoff:{maturity:"Early — knows the pain, not the tooling",goalInOwnWords:"“I want to know when people complain about us before my CEO does”",hesitations:"Unsure about UK market priority; hesitated on competitor list beyond Nike",aiSuggestedUnconfirmed:"Adidas and Puma as competitors; GMT timezone",followUps:"Add 2-3 colleagues as users; confirm owned TikTok handle",consultantTips:"Lead the review call with the crisis-alert setup — that's the outcome she cares about most."},
  filename:"Lumen_Setup_Brief_Acme_Corp_"+new Date().toISOString().slice(0,10)+".xlsx",
  sentAt:new Date(),
};

function DemoBar({ stage, setStage, brief }) {
  const steps = [["sales","1. Sales generates link"],["client","2. Client onboarding chat"],["proserv","3. What Proserv receives"],["dash","4. Proserv dashboard"]];
  return (
    <div style={{background:TEAL,color:"white",display:"flex",alignItems:"center",gap:14,padding:"0 16px",height:44,flexShrink:0,fontSize:12}}>
      <span style={{fontWeight:700,whiteSpace:"nowrap"}}>Lumen Onboarding — Demo</span>
      <div style={{display:"flex",gap:6}}>
        {steps.map(([k,label]) => (
          <button key={k} onClick={()=>setStage(k)}
            style={{background:stage===k?"white":"rgba(255,255,255,0.12)",color:stage===k?TEAL:"white",border:"none",borderRadius:14,padding:"5px 12px",fontSize:11,fontWeight:stage===k?700:400,cursor:"pointer",whiteSpace:"nowrap"}}>
            {label}{k==="proserv"&&brief?" ●":""}
          </button>
        ))}
      </div>
      <span style={{marginLeft:"auto",opacity:0.75,whiteSpace:"nowrap"}}>Chat is live · hosting, sign-in, Drive &amp; Slack are simulated</span>
    </div>
  );
}

function Field({ label, opt, value, onChange, placeholder, area }) {
  const st = {width:"100%",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 12px",fontSize:13,fontFamily:"inherit",color:TEAL,outline:"none",boxSizing:"border-box",resize:"vertical"};
  return (
    <div style={{marginBottom:14}}>
      <div style={{fontSize:12,fontWeight:700,marginBottom:5}}>{label} {opt && <span style={{fontWeight:400,color:"#5b6b76"}}>(optional)</span>}</div>
      {area ? <textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={3} style={st}/>
            : <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={st}/>}
    </div>
  );
}

function SalesStage({ onGenerated }) {
  const [company,setCompany] = useState("");
  const [contactName,setContactName] = useState("");
  const [email,setEmail] = useState("");
  const [industry,setIndustry] = useState("");
  const [language,setLanguage] = useState("English");
  const [notes,setNotes] = useState("");
  const [link,setLink] = useState(null);
  const [copied,setCopied] = useState(false);
  const fillExample = () => { setCompany("Acme Corp"); setContactName("Jane Smith"); setEmail("jane@acmecorp.com"); setIndustry("Consumer goods — footwear and apparel"); setNotes("Enterprise tier. Main interest is competitive intelligence; key competitor is Nike."); };
  const generate = () => {
    if (!company.trim()) return;
    setLink({ url:`https://onboarding.hootsuite.com/?s=${crypto.randomUUID()}`, seed:{company:company.trim(),contactName:contactName.trim(),email:email.trim(),industry:industry.trim(),notes:notes.trim(),language} });
  };
  return (
    <div style={{flex:1,overflowY:"auto",background:"white",color:TEAL,fontFamily:"Arial, sans-serif"}}>
      <div style={{maxWidth:520,margin:"0 auto",padding:"40px 20px"}}>
        <h1 style={{fontSize:20,margin:"0 0 6px"}}>Generate a client onboarding link</h1>
        <p style={{fontSize:13,color:"#5b6b76",margin:"0 0 20px",lineHeight:1.5}}>Internal page for the sales team. Fill in what we already know — the client is greeted by name and never re-asked the basics.</p>

        <div style={{display:"flex",alignItems:"center",gap:8,background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"9px 12px",fontSize:12,marginBottom:22}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:"#16a34a",flexShrink:0}}/>
          <span>Signed in as <strong>damien@hootsuite.com</strong></span>
          <span style={{color:"#5b6b76",marginLeft:"auto",fontSize:11}}>Google sign-in, @hootsuite.com only · simulated</span>
        </div>

        <Field label="Company" value={company} onChange={setCompany} placeholder="Acme Corp"/>
        <Field label="Contact name" opt value={contactName} onChange={setContactName} placeholder="Jane Smith"/>
        <Field label="Contact email" opt value={email} onChange={setEmail} placeholder="jane@acmecorp.com"/>
        <Field label="Industry" opt value={industry} onChange={setIndustry} placeholder="Consumer goods — footwear and apparel"/>
        <div style={{marginBottom:16}}>
          <label style={{display:"block",fontSize:13,fontWeight:700,marginBottom:5}}>Onboarding language <span style={{fontWeight:400,color:"#5b6b76"}}>· the client can change this on their welcome screen</span></label>
          <select value={language} onChange={e=>setLanguage(e.target.value)} style={{width:"100%",border:"1px solid #e2e8f0",borderRadius:8,padding:"11px 12px",fontSize:14,color:TEAL,background:"white",cursor:"pointer"}}>
            {UI_LANGS.map(l=><option key={l.code} value={l.code}>{l.native}</option>)}
          </select>
        </div>
        <Field label="What do you already know about this client?" opt area value={notes} onChange={setNotes} placeholder="Why they're buying, competitors they named, report audience, tier sold, language, anything sensitive — never shown to the client, quietly shapes the assistant's suggestions"/>

        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          <button onClick={generate} disabled={!company.trim()} style={{background:company.trim()?CHERRY:"#f0b5b3",color:"white",border:"none",borderRadius:8,padding:"12px 24px",fontSize:14,fontWeight:700,cursor:company.trim()?"pointer":"default"}}>Generate link</button>
          <button onClick={fillExample} style={{background:"transparent",border:"none",color:"#5b6b76",fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Use example client</button>
        </div>

        {link && (
          <div style={{marginTop:20,background:MINT,border:"1px solid #b9e8b8",borderRadius:10,padding:14}}>
            <strong style={{fontSize:13}}>✓ Link ready</strong>
            <div style={{fontSize:12,wordBreak:"break-all",background:"white",border:"1px solid #e2e8f0",borderRadius:6,padding:"8px 10px",margin:"8px 0 10px"}}>{link.url}</div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <button onClick={()=>onGenerated(link.seed)} style={{background:TEAL,color:"white",border:"none",borderRadius:6,padding:"9px 16px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Open the link as the client →</button>
              <button onClick={()=>{try{navigator.clipboard?.writeText(link.url);}catch(e){} setCopied(true);setTimeout(()=>setCopied(false),1500);}} style={{background:"white",color:TEAL,border:"1px solid #e2e8f0",borderRadius:6,padding:"9px 14px",fontSize:12,cursor:"pointer"}}>{copied?"Copied ✓":"Copy link"}</button>
            </div>
            <div style={{fontSize:11,color:"#5b6b76",marginTop:8,lineHeight:1.4}}>In production the salesperson pastes this into their email. Here, click through to experience it as the client.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function SlackCard({ variant, brief }) {
  const co = brief?.merged?.company || {};
  const stalled = variant === "stalled";
  const fields = stalled
    ? [["Company", co.name||"Acme Corp"],["Contact email", co.email||"jane@acmecorp.com"],["Progress","60%"],["Last active","2 days ago"]]
    : [["Company", co.name||"—"],["Contact", `${co.contact||"—"} (${co.email||"no email"})`],["Topics", String((brief?.merged?.topics||[]).length)],["Users", String((brief?.users||[]).length)],["Industry", co.industry||"—"],["Markets", co.markets||"—"]];
  return (
    <div style={{background:"white",border:"1px solid #ddd",borderRadius:10,overflow:"hidden",fontFamily:"Arial, sans-serif"}}>
      <div style={{background:"#3f0e40",color:"white",padding:"8px 14px",fontSize:12,fontWeight:700}}># proserv-lumen-onboarding</div>
      <div style={{display:"flex",gap:10,padding:"12px 14px"}}>
        <div style={{width:36,height:36,borderRadius:6,background:"#7c6fe0",color:"white",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>🦉</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,marginBottom:4}}><strong>Lumen Onboarding</strong> <span style={{background:"#e8e8e8",borderRadius:3,padding:"0 4px",fontSize:9,fontWeight:700,color:"#616061"}}>APP</span> <span style={{color:"#616061",fontSize:11}}>{new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span></div>
          <div style={{fontSize:14,fontWeight:700,marginBottom:8}}>{stalled?"🟡 Lumen onboarding stalled":"🟢 Lumen setup brief completed"}</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 16px",fontSize:12,marginBottom:8}}>
            {fields.map(([k,v]) => <div key={k}><div style={{fontWeight:700}}>{k}:</div><div style={{color:"#1d1c1d"}}>{v}</div></div>)}
          </div>
          {!stalled && <div style={{fontSize:11,color:"#616061",marginBottom:6}}>Client has edit access to the Sheet until the review call</div>}
          <div style={{fontSize:12,color:"#1264a3"}}>
            {stalled
              ? <>Partial brief available — a consultant can pick this up or nudge the client. <u>💬 Open session</u></>
              : <><u>📄 Open the requirements document</u> &nbsp;·&nbsp; <u>🔍 View full session</u></>}
          </div>
          {!stalled && <div style={{marginTop:8,paddingTop:8,borderTop:"1px solid #eee",fontSize:12,color:"#1d1c1d"}}>
            <span style={{color:"#616061"}}>↳ threaded reply</span> &nbsp; Matched: <strong>{co.name||"Acme Corp"}</strong> <em style={{color:"#616061"}}>(existing client)</em><br/>
            <span style={{color:"#1264a3"}}>@consultant (IC)&nbsp;&nbsp;@tam (TAM)</span>
          </div>}
        </div>
      </div>
    </div>
  );
}

function DriveCard({ brief }) {
  const fname = (brief?.filename || EXAMPLE_BRIEF.filename).replace(/\.xlsx$/, "");
  const download = async () => {
    const b = brief || EXAMPLE_BRIEF;
    const XLSX = await loadXLSX();
    const { wb, filename } = buildWorkbook(XLSX, b.merged, b.users);
    XLSX.writeFile(wb, filename);
  };
  return (
    <div style={{background:"white",border:"1px solid #ddd",borderRadius:10,overflow:"hidden",fontFamily:"Arial, sans-serif"}}>
      <div style={{padding:"10px 14px",borderBottom:"1px solid #eee",fontSize:12,color:"#5f6368",display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontSize:14}}>▸</span> Proserv Shared Drive <span>›</span> <strong style={{color:"#202124"}}>Lumen Onboarding Briefs</strong>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:12,padding:"12px 14px"}}>
        <div style={{width:34,height:34,borderRadius:6,background:"#e6f4ea",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>📊</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:700,color:"#202124",wordBreak:"break-all"}}>{fname}</div>
          <div style={{fontSize:11,color:"#5f6368"}}>just now · uploaded by lumen-onboarding@…iam.gserviceaccount.com</div>
        </div>
        <button onClick={download} style={{background:TEAL,color:"white",border:"none",borderRadius:6,padding:"8px 14px",fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0}}>⬇ Download (real file)</button>
      </div>
    </div>
  );
}

function ProservStage({ brief, useExample }) {
  return (
    <div style={{flex:1,overflowY:"auto",background:"#f8f9fa",color:TEAL,fontFamily:"Arial, sans-serif"}}>
      <div style={{maxWidth:620,margin:"0 auto",padding:"36px 20px 60px"}}>
        <h1 style={{fontSize:20,margin:"0 0 6px"}}>What Proserv receives</h1>
        <p style={{fontSize:13,color:"#5b6b76",margin:"0 0 24px",lineHeight:1.5}}>The moment the client clicks “Send to my Lumen team”, three things happen automatically — no client download, no email attachment, nothing to chase.</p>

        {!brief && (
          <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:"12px 14px",fontSize:12,marginBottom:20,display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <span>No brief sent yet in this demo — finish the chat in step 2, or</span>
            <button onClick={useExample} style={{background:CHERRY,color:"white",border:"none",borderRadius:6,padding:"6px 12px",fontSize:12,fontWeight:700,cursor:"pointer"}}>show with example data</button>
          </div>
        )}

        <div style={{fontSize:12,fontWeight:700,margin:"0 0 8px",textTransform:"uppercase",letterSpacing:"0.05em",color:"#5b6b76"}}>1 · Slack notification (your existing webhook pattern)</div>
        <SlackCard brief={brief}/>

        <div style={{fontSize:12,fontWeight:700,margin:"24px 0 8px",textTransform:"uppercase",letterSpacing:"0.05em",color:"#5b6b76"}}>2 · Brief lands in the Google Drive folder</div>
        <DriveCard brief={brief}/>
        <div style={{fontSize:11,color:"#5b6b76",margin:"6px 2px 0"}}>The download button generates the actual XLSX — same tabs as the current requirements spreadsheet.</div>

        {(brief?.handoff) && <>
          <div style={{fontSize:12,fontWeight:700,margin:"24px 0 8px",textTransform:"uppercase",letterSpacing:"0.05em",color:"#5b6b76"}}>2b · Consultant handoff — a Google Doc the client never sees</div>
          <div style={{background:"white",border:"1px solid #ddd",borderRadius:10,padding:"14px 16px",fontSize:12,lineHeight:1.7,fontFamily:"Arial, sans-serif"}}>
            {[["Maturity",brief.handoff.maturity],["Goal in their own words",brief.handoff.goalInOwnWords],["Hesitations",brief.handoff.hesitations],["AI-suggested, unconfirmed",brief.handoff.aiSuggestedUnconfirmed],["Follow-ups for the review call",brief.handoff.followUps],["Tips for the consultant",brief.handoff.consultantTips]].map(([k,v])=>v?<div key={k}><strong>{k}:</strong> {v}</div>:null)}
          </div>
          <div style={{fontSize:11,color:"#5b6b76",margin:"6px 2px 0"}}>Generated by the assistant during the conversation — the difference between “reading a spreadsheet” and “being briefed”.</div>
        </>}

        <div style={{fontSize:12,fontWeight:700,margin:"24px 0 8px",textTransform:"uppercase",letterSpacing:"0.05em",color:"#5b6b76"}}>3 · And if a client stalls, nothing is lost</div>
        <SlackCard variant="stalled" brief={brief}/>
        <div style={{fontSize:11,color:"#5b6b76",margin:"6px 2px 0"}}>Sent automatically after 48h of inactivity at 40%+ progress. A half-finished brief becomes a warm follow-up instead of a silent drop-off.</div>

        <div style={{marginTop:28,background:"white",border:"1px solid #e2e8f0",borderRadius:10,padding:"14px 16px",fontSize:12,lineHeight:1.7}}>
          <strong>In this demo:</strong> the conversation, widgets, brief-building and XLSX file are fully real (live AI). The hosting, resumable session links, Google sign-in, Drive upload and Slack posts are visual simulations of the built, ready-to-deploy Netlify app.
        </div>
      </div>
    </div>
  );
}

function DashboardStage({ brief, onOpenHandoff }) {
  const downloadBrief = async () => {
    const b = brief || EXAMPLE_BRIEF;
    const XLSX = await loadXLSX();
    const { wb, filename } = buildWorkbook(XLSX, b.merged, b.users);
    XLSX.writeFile(wb, filename);
  };
  const P = "#012B3A";
  const rows = [
    { co:"Acme Corp", em:"jane@acmecorp.com", by:"tom.reid", st:"completed", pct:100, start:"Jul 1, 09:12", last:"Jul 1, 09:26", min:"14 min", tok:"31k", cost:"$1.24", calls:19, brief:true, handoff:true },
    { co:"Northwind Foods", em:"m.alvarez@northwind.com", by:"sara.kim", st:"in_progress", pct:60, start:"Jul 2, 15:40", last:"Jul 3, 08:55", min:"11 min", tok:"18k", cost:"$0.71", calls:12, brief:false, handoff:false, sofar:true },
    { co:"Helios Bank", em:"p.dubois@heliosbank.eu", by:"tom.reid", st:"stalled", pct:40, start:"Jun 29, 10:02", last:"Jul 1, 10:15", min:"9 min", tok:"14k", cost:"$0.55", calls:9, brief:false, handoff:false, sofar:true },
    { co:"Verde Cosmetics", em:"l.ricci@verdecos.it", by:"sara.kim", st:"seeded", pct:0, start:"—", last:"Jul 3, 07:30", min:"—", tok:"0", cost:"$0.00", calls:0, brief:false, handoff:false },
  ];
  const pill = st => ({
    completed:{bg:"#DFFFDE",c:"#166534",l:"Completed"},
    in_progress:{bg:"#E8F1FE",c:"#1d4ed8",l:"In progress"},
    stalled:{bg:"#FEF3E2",c:"#92400e",l:"Stalled"},
    seeded:{bg:"#f1f5f9",c:"#475569",l:"Link sent"},
  })[st];
  const kpis = [["12","sessions total"],["7/9","completed (78%)"],["14 min","median completion time"],["8.9 h","est. time saved (vs 90 min manual)"],["$9.12","est. AI spend · $1.30/brief"]];
  return (
    <div style={{flex:1,overflowY:"auto",background:"#f7f8fa",fontFamily:"Arial, sans-serif",color:P}}>
      <div style={{background:"white",borderBottom:"1px solid #e2e8f0",padding:"12px 24px",display:"flex",alignItems:"center",gap:12}}>
        <div style={{fontSize:15,fontWeight:700}}>Lumen Onboarding — Dashboard</div>
        <div style={{marginLeft:"auto",fontSize:11,color:"#5b6b76"}}>signed in as damien.thierry@hootsuite.com</div>
      </div>
      <div style={{maxWidth:1080,margin:"0 auto",padding:"20px 16px"}}>
        <div style={{fontSize:11,color:"#5b6b76",marginBottom:12}}>This is the live view at <b>/dashboard.html</b> — Google sign-in, @hootsuite.com only. Example data below; the Acme row is your demo session.</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:10,marginBottom:16}}>
          {kpis.map(([v,l],i)=>(<div key={i} style={{background:"white",border:"1px solid #e2e8f0",borderRadius:10,padding:"12px 14px"}}>
            <div style={{fontSize:20,fontWeight:700}}>{v}</div><div style={{fontSize:10.5,color:"#5b6b76",marginTop:3,lineHeight:1.4}}>{l}</div></div>))}
        </div>
        <div style={{background:"white",border:"1px solid #e2e8f0",borderRadius:12,overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12.5,minWidth:820}}>
            <thead><tr>{["Client","Status","Progress","Started","Last active","Time","Tokens / cost","Report"].map(h=>(
              <th key={h} style={{textAlign:h==="Time"||h==="Tokens / cost"?"right":"left",fontSize:10,textTransform:"uppercase",letterSpacing:"0.04em",color:"#5b6b76",padding:"9px 12px",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>))}</tr></thead>
            <tbody>{rows.map((r,i)=>{ const pl = pill(r.st); return (
              <tr key={i}>
                <td style={{padding:"10px 12px",borderBottom:"1px solid #eef1f4"}}><div style={{fontWeight:700}}>{r.co}</div><div style={{fontSize:10.5,color:"#5b6b76"}}>{r.em} · seeded by {r.by}</div></td>
                <td style={{padding:"10px 12px",borderBottom:"1px solid #eef1f4"}}><span style={{background:pl.bg,color:pl.c,fontSize:10.5,fontWeight:700,borderRadius:10,padding:"2px 9px",whiteSpace:"nowrap"}}>{pl.l}</span></td>
                <td style={{padding:"10px 12px",borderBottom:"1px solid #eef1f4"}}><div style={{width:80,height:6,background:"#eef1f4",borderRadius:3}}><div style={{width:`${r.pct}%`,height:"100%",background:P,borderRadius:3}}/></div><div style={{fontSize:10.5,color:"#5b6b76",marginTop:2}}>{r.pct}%</div></td>
                <td style={{padding:"10px 12px",borderBottom:"1px solid #eef1f4",whiteSpace:"nowrap"}}>{r.start}</td>
                <td style={{padding:"10px 12px",borderBottom:"1px solid #eef1f4",whiteSpace:"nowrap"}}>{r.last}</td>
                <td style={{padding:"10px 12px",borderBottom:"1px solid #eef1f4",textAlign:"right",whiteSpace:"nowrap"}}>{r.min}{r.sofar&&<div style={{fontSize:10,color:"#5b6b76"}}>so far</div>}</td>
                <td style={{padding:"10px 12px",borderBottom:"1px solid #eef1f4",textAlign:"right",whiteSpace:"nowrap"}}>{r.tok}<div style={{fontSize:10,color:"#5b6b76"}}>{r.cost} · {r.calls} calls</div></td>
                <td style={{padding:"10px 12px",borderBottom:"1px solid #eef1f4",whiteSpace:"nowrap"}}>
                  {r.brief ? <>
                    <button onClick={downloadBrief} style={{background:"none",border:"none",color:"#0b6b3a",fontWeight:700,fontSize:11.5,cursor:"pointer",padding:0,textDecoration:"underline"}}>Open brief ⤓</button><br/>
                    <button onClick={onOpenHandoff} style={{background:"none",border:"none",color:"#5b6b76",fontSize:11,cursor:"pointer",padding:0,textDecoration:"underline"}}>Consultant handoff ↗</button>
                  </> : "—"}
                </td>
              </tr>); })}</tbody>
          </table>
        </div>
        <div style={{fontSize:10.5,color:"#5b6b76",marginTop:12,lineHeight:1.5}}>Estimates: time saved = completed sessions × (90 min manual baseline − median completion time). AI cost from exact per-call token metering at $3/$15 per MTok in/out. In production the “Open brief” link goes to the delivered Google Sheet in Drive.</div>
      </div>
    </div>
  );
}

export default function Demo() {
  const [stage,setStage] = useState("sales");
  const [seed,setSeed] = useState(null);
  const [brief,setBrief] = useState(null);
  const [chatKey,setChatKey] = useState(0);
  return (
    <div style={{height:VH_FULL,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <DemoBar stage={stage} setStage={setStage} brief={brief}/>
      {stage==="sales" && <SalesStage onGenerated={sd=>{setSeed(sd);setBrief(null);setChatKey(k=>k+1);setStage("client");}}/>}
      {stage==="client" && (
        <div style={{flex:1,minHeight:0}}>
          <OnboardingApp key={chatKey} seed={seed} onBriefSent={setBrief} onSeeProserv={()=>setStage("proserv")}/>
        </div>
      )}
      {stage==="proserv" && <ProservStage brief={brief} useExample={()=>setBrief(EXAMPLE_BRIEF)}/>}
      {stage==="dash" && <DashboardStage brief={brief} onOpenHandoff={()=>setStage("proserv")}/>}
    </div>
  );
}

// ================= LIVE CLIENT CHAT ENTRY =================
// Standalone client-facing page: no demo tab shell. Fetches the client-safe seed
// the Sales page stored under ?s=<id> (consultant notes never reach the browser),
// then runs the onboarding chat full-bleed. onBriefSent writes to the session
// store (handled inside OnboardingApp.handleSend); here we just need a no-op sink
// and no "see Proserv" navigation.
export function LiveChat() {
  const [state, setState] = useState({ loading: true, seed: null, seedId: null, seedError: false, seedExpired: false });
  useEffect(() => {
    let alive = true;
    // seedError is true when a ?s= link was present but its prepared profile could
    // not be loaded (expired, or the store failed both attempts). It's surfaced so
    // the client gets an explanation instead of silently dropping to a generic
    // session. (Notes still shape the session server-side via seedId if the record
    // is actually reachable there.)
    fetchSeedFromURL().then(r => { if (alive) setState({ loading: false, seed: r.seed, seedId: r.seedId, seedError: !!r.seedError, seedExpired: !!r.seedExpired }); });
    return () => { alive = false; };
  }, []);
  if (state.loading) return <BootScreen/>;
  return (
    <div style={{height:VH_FULL,display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <div style={{flex:1,minHeight:0}}>
        <OnboardingApp seed={state.seed} seedId={state.seedId} seedError={state.seedError} seedExpired={state.seedExpired} onBriefSent={()=>{}} onSeeProserv={null}/>
      </div>
    </div>
  );
}
