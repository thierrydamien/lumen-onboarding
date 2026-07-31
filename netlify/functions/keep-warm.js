// Scheduled keep-warm. Every minute, poke the serverless functions on the
// client's critical path so their containers stay hot. A cold container's first
// call can add several seconds, which after an idle period hits the first client
// of the next session. Keeping the container warm prevents that cold start; the
// client-side auto-retry is the safety net for the rare remaining cold hit.
// (Was 10 min, then 3 min — production logs showed some turns in the SAME short
// test session with ~4-5s of extra wall time unaccounted for by genMs, and others
// with none, an intermittent pattern pointing at container idle-recycling between
// pings. Typical idle-recycle windows are several minutes, so 3 min was already
// likely keeping things warm nearly all the time; 1 min narrows the residual
// cold-start window further for negligible extra cost — diminishing returns past
// this point, but no downside to taking it.)
//
// The critical path is the SYNC-FIRST flow: the synchronous /chat proxy is the
// hot path again (the client tries it first every turn), with chat-background +
// chat-status as the fallback for rare heavy turns, plus seed (the seeded-session
// fetch). All four stay on the list so whichever path a turn takes is warm.
//
// No model call is made and nothing is written: a bare GET is rejected early by
// each function BEFORE any Anthropic or Blobs work, which still boots and warms
// the container — chat-background returns 202 (no rid), chat-status returns 400
// (no id), seed returns 401. Cost is negligible even at this frequency (checked
// against Netlify's credit usage breakdown: Compute + Web requests combined are a
// small fraction of total account usage, and cover ALL function traffic, not just
// these pings).

export const config = { schedule: "* * * * *" };

const TARGETS = [
  "/.netlify/functions/chat",
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
