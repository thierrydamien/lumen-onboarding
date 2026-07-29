// Scheduled keep-warm. Every 10 minutes, poke the serverless functions on the
// client's critical path so their containers stay hot. A cold container's first
// call can add several seconds, which after an idle period hits the first client
// of the next session. Keeping the container warm prevents that cold start; the
// client-side auto-retry is the safety net for the rare remaining cold hit.
//
// The critical path is now the BACKGROUND generation flow, not the synchronous
// proxy: chat-background (kick off a turn) and chat-status (polled repeatedly
// while a turn runs) both need to be warm, plus seed (the seeded-session fetch).
// The old synchronous /chat is only a fallback now, so it drops off this list.
//
// No model call is made and nothing is written: a bare GET is rejected early by
// each function BEFORE any Anthropic or Blobs work, which still boots and warms
// the container — chat-background returns 202 (no rid), chat-status returns 400
// (no id), seed returns 401. Cost is negligible (three cheap pokes every 10 min).

export const config = { schedule: "*/10 * * * *" };

const TARGETS = [
  "/.netlify/functions/chat-background",
  "/.netlify/functions/chat-status",
  "/.netlify/functions/seed",
];

export default async () => {
  const base = process.env.URL || "";
  if (!base) {
    console.warn("keep-warm: URL env not set; skipping");
    return new Response("skip", { status: 200 });
  }
  await Promise.all(
    TARGETS.map(async (path) => {
      try {
        const r = await fetch(base + path, { method: "GET" });
        console.log("keep-warm", path, r.status); // 405/401 are expected — the point is the boot, not the body
      } catch (e) {
        console.warn("keep-warm failed", path, e && e.message);
      }
    })
  );
  return new Response("ok", { status: 200 });
};
