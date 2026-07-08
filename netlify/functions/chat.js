// Server-side Anthropic proxy (Netlify Functions v2). The API key lives ONLY
// here (Netlify env var), never in the browser. The client sends
// { system, messages, maxTokens? }; this adds the key + model and forwards.
//
// Setup: Netlify > Site config > Environment variables > ANTHROPIC_API_KEY
// Endpoint: /.netlify/functions/chat

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_CEILING = 4000;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export const config = { path: "/.netlify/functions/chat" };

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.error("ANTHROPIC_API_KEY is not set on this Netlify site");
    return json(500, { error: "server_not_configured" });
  }

  let body;
  try { body = await req.json(); }
  catch { return json(400, { error: "bad_json" }); }

  const { system, messages, maxTokens } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(400, { error: "missing_messages" });
  }

  const requested = Number(maxTokens) || MAX_TOKENS_CEILING;
  const max_tokens = Math.min(Math.max(requested, 1), MAX_TOKENS_CEILING);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens,
        ...(system ? { system } : {}),
        messages,
      }),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      console.error("Anthropic error", res.status, data && data.error);
      return json(res.status === 200 ? 502 : res.status, { error: "upstream_error", status: res.status });
    }
    return json(200, { content: data.content || [] });
  } catch (err) {
    console.error("Proxy fetch failed", err);
    return json(502, { error: "upstream_unreachable" });
  }
};

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
