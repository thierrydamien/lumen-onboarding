// Server-side Anthropic proxy. The API key lives ONLY here (Netlify env var),
// never in the browser. The client sends { system, messages, maxTokens? };
// this function adds the key and the model, forwards to Anthropic, and returns
// the raw response. Because the frontend is served from the same Netlify site,
// the call is same-origin and needs no CORS headers.
//
// Setup:
//   1. Netlify site settings > Environment variables > add ANTHROPIC_API_KEY
//   2. Deploy. The endpoint is /.netlify/functions/chat
//
// Cost control: the model and the max_tokens ceiling are fixed here, so a
// tampered client cannot run a bigger/more expensive request than intended.

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS_CEILING = 4000;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    // Misconfiguration, not a client error. Log server-side, tell the client
    // something generic so it shows the retry banner rather than hanging.
    console.error("ANTHROPIC_API_KEY is not set on this Netlify site");
    return json(500, { error: "server_not_configured" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "bad_json" });
  }

  const { system, messages, maxTokens } = body;
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
      // Surface the upstream status so the client's existing api_<status>
      // handling still works, but never leak the key or internal detail.
      console.error("Anthropic error", res.status, data && data.error);
      return json(res.status === 200 ? 502 : res.status, {
        error: "upstream_error",
        status: res.status,
      });
    }

    // Return the content array in the same shape the client already parses:
    // it does (d.content || []).map(b => b.text).join("").
    return json(200, { content: data.content || [] });
  } catch (err) {
    console.error("Proxy fetch failed", err);
    return json(502, { error: "upstream_unreachable" });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  };
}
