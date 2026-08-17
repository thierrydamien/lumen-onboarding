# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Register

product

App UI where design serves the task. The welcome screen carries a first
impression, but everything after it is a tool and is judged on clarity, cognitive
load, and whether the client gives real answers.

## Users

Three distinct audiences on one Netlify site, each with their own surface:

- **New Lumen clients** (`/chat`, the only client-facing surface). Someone at a
  company that has just bought Lumen, opening a personalised link sent by their
  account contact. Their job: describe what they want to monitor so the
  implementation team can configure the platform for them. They arrive with
  varying expertise, no training, and no obligation to finish. Six UI languages
  (English, French, German, Spanish, Italian, Arabic), Arabic fully RTL.
- **Sales / CS** (`/sales`, internal). Generates a client's link, optionally
  pre-filling details or importing a completed media brief, and adds
  confidential notes the client never sees. Often working through several
  clients in one sitting.
- **Proserv / implementation** (`/dashboard`, internal). Reads what came back,
  spots who has stalled, opens the generated brief. Behind a Google Sign-In plus
  a shared access token.

## Product Purpose

A guided conversation that replaces a requirements form. A new client talks to
an assistant for roughly fifteen minutes, in their own language, pausing and
resuming on any device, and the result is a structured setup brief plus an
editable Google Sheet delivered to the implementation team.

Success is **brief quality**: the implementation team receives answers specific
enough to configure a real Lumen environment from, without a follow-up round of
chasing. A completed session that produces vague answers is a failure even
though it looks like a success in the dashboard.

## Positioning

The mechanism a plain form cannot copy: the assistant already knows what a good
answer looks like for each question, so it can recognise a vague one and ask a
follow-up in the moment. It also arrives pre-briefed. Sales seeds the link with
the company, contact, industry, service package, and anything already known, so
the client confirms rather than repeats, and the service package silently scopes
how much is gathered (topic, channel, and dashboard allowances) without ever
asking the client about their contract.

## Operating Context

- Reached by a one-off emailed link, `/chat?s=<seedId>`. **The URL is the
  secret**: it is the only thing between a stranger and that client's session.
- Tied to one person. Not shareable, not collaborative. The link's owner is
  whoever best understands the monitoring goals.
- Resumable across devices and sessions; drafts persist in localStorage and a
  server draft store, reconciled on load.
- Clients may bring existing material: keyword lists or query syntax exported
  from a previous tool (Brandwatch and similar), or a filled media brief
  template. Both are importable, and pasted query syntax is the one input that
  cannot be reconstructed later.
- Ends in a handoff, not a purchase: the brief goes to the implementation team,
  who then book a requirements review call.

## Capabilities and Constraints

- React client, single file (`src/lumen.jsx`, ~4,900 lines), bundled by Vite.
  No build-time TypeScript. The two internal pages are static HTML with inline
  scripts and no build step.
- Netlify Functions plus Netlify Blobs for every store. No database.
- Sync-first chat: the client tries the synchronous proxy every turn and falls
  back to a background function with polling only for heavy turns.
- Widgets (chip selectors, ranked selectors, topic cards, a user form, a query
  box) are mixed into the conversation. Every widget submission is editable
  afterwards, and every captured answer is editable from a side panel.
- Six languages across five parallel translation tables. Adding a language means
  adding it to those tables **before** offering it anywhere.
- Deploys cost money. Work is batched and verified locally against a stubbed
  network before shipping.
- The repository is public. Nothing sensitive may enter the client bundle;
  consultant notes are injected server-side and never reach the browser.

## Brand Commitments

**Binding, not open to redesign:**

- Hootsuite brand: Cherry `#FF4C46`, Dark Teal `#012B3A`, Mint `#DFFFDE`.
- Lumen purple as the product accent; the waveform mark and the
  "Lumen — by Talkwalker" lockup.
- Inter as the typeface, self-hosted (deliberately not the Google Fonts CDN).
  Arial is the documented fallback.
- The existing token scale in `src/lumen.jsx` (`T`): radius, three shadow
  depths, a motion scale with a shared ease-out curve, and a five-step text
  scale (caption 11, body 13, emphasis 15, title 20, hero 28).

**Voice:** a knowledgeable peer. The assistant should read like someone who has
run this setup a hundred times, knows what a good answer looks like, and will
say so, including pushing back or asking a follow-up when an answer is too thin
to configure from.

## Anti-references

Explicitly named as what this must not become:

- **A form wearing a chat costume.** Conversational framing as decoration, with
  a questionnaire underneath. Widget after widget, no actual dialogue.
- **A survey or intake questionnaire.** Extractive: much asking, no sense that
  the answers were understood or that the client gets anything back.

Both failure modes point the same way: the client must be able to tell that they
are being listened to, not harvested.

## Evidence on Hand

- `demo/` holds a real worked example: a filled brief (`apple-brief.docx`),
  consultant notes, and a demo script.
- `public/media-brief-template.xlsx` is the real template Sales sends clients.
- Captured live transcripts in `ab-transcripts.txt`, and a live-conversation
  harness (`tools/live-convo.mjs`) that drives the deployed backend.
- Measured manual effort for the reports this replaces exists from earlier work
  and should not be re-invented: it was gathered per client, not estimated.
- **Absent, do not fabricate:** no client testimonials, no completion-rate or
  drop-off data, no analytics of any kind, and no record of how any real client
  has rated the experience.

## Product Principles

1. **A vague answer is a failed answer.** The measure is whether the
   implementation team can configure from it, not whether the client reached the
   end. Prefer one good follow-up over a completed section.
2. **Never lose what the client typed.** Their own query syntax, their own
   wording on a topic, a note they corrected. These cannot be reconstructed, and
   silently dropping one is the worst thing this product can do.
3. **Confirm, don't re-ask.** Anything Sales already knows arrives pre-filled.
   Making a client repeat what they told their account contact reads as
   institutional carelessness.
4. **The client can always change their mind.** Every answer stays editable,
   from the transcript and from the panel. Nothing is locked by having moved on.
5. **Interruption is the normal case, not the exception.** Fifteen minutes of a
   working day gets interrupted. Resuming must cost nothing and must never
   present a stale or partial version of what they said.

## Accessibility & Inclusion

No formal conformance target set: best effort, and not a ship blocker. In
practice the bar applied so far has been WCAG 2.2 AA on anything cheap to fix,
with keyboard operability and correct focus handling treated as functional
requirements rather than accessibility extras. Findings that are specifically AA
failures should be called out as such so the decision stays visible.

Full RTL support for Arabic is a functional requirement, not a nicety: layout
mirrors, and the language can be changed after a session has started.
