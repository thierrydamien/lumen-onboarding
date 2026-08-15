// Public, read-only configuration for the internal Sales page.
//
// The Sales page needs to know (a) whether the Google Sign-In gate is switched
// on for this site and (b) which OAuth Client ID to use. Both are PUBLIC values
// — the Client ID ships in the page markup by design, and its security comes
// from the authorized-JavaScript-origins list in Google Cloud plus the consent
// screen being set to "Internal", not from being secret.
//
// This exists so the Client ID lives in ONE place (a Netlify environment
// variable) rather than being pasted into public/sales.html, which would mean a
// code change + redeploy to rotate it, and would put a per-deployment value in
// version control.
//
// Deliberately returns ONLY these two fields. It must never grow into a general
// "dump the environment" endpoint: it is unauthenticated by necessity (the page
// has to call it before the user has signed in).

export const config = { path: "/.netlify/functions/app-config" };

export default async () => {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const domain = process.env.ALLOWED_EMAIL_DOMAIN || "";
  // googleAuth is the single switch the page branches on. Both must be present:
  // a client id with no domain would sign people in and then let ANY Google
  // account through, which is worse than no gate at all because it looks secure.
  const googleAuth = !!(clientId && domain);
  return new Response(
    JSON.stringify({ googleAuth, clientId: googleAuth ? clientId : "", domain: googleAuth ? domain : "" }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        // Short cache: long enough to avoid a request per page load, short
        // enough that flipping the gate on/off takes effect without a redeploy.
        "Cache-Control": "public, max-age=60",
      },
    }
  );
};
