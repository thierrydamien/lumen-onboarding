// Scheduled keep-warm. Every 10 minutes, poke the serverless functions on the
// client's critical path — chat (the model proxy) and seed (the seeded-session
// fetch) — so their containers stay hot. A cold container's heavy first call can
// exceed the function timeout and produce the "we couldn't reach the assistant"
// failure for the first client after an idle period. Keeping the container warm
// prevents that cold start. It is one of three layers: the client-side auto-retry
// is the safety net for the rare remaining cold hit, and raising the Netlify
// function timeout to 26s gives even a cold call room to finish.
//
// No model call is made and nothing is written: a GET is rejected early by each
// function (chat returns 405, seed returns 401) BEFORE any Anthropic or Blobs work,
// which still boots and warms the container. Cost is negligible (a couple of cheap
// invocations every 10 minutes).

export const config = { schedule: "*/10 * * * *" };

const TARGETS = ["/.netlify/functions/chat", "/.netlify/functions/seed"];

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
