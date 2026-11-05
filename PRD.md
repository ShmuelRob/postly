# Postly Product Spec (PRD)

Postly is an AI agent that manages Instagram and Facebook for small business owners through WhatsApp. This spec covers the process, the context held for each business, the architecture decisions, and what the agent can and cannot do in Phase 1.

## Product overview

Postly writes, designs, and publishes 2 to 5 posts a week on Instagram and Facebook for small business owners. All communication with the owner happens in WhatsApp, so no app or additional interface is needed.

| Topic | Definition |
| --- | --- |
| Target audience | Independent small business owners, mostly with a weak or inconsistent social media presence |
| Communication channel | WhatsApp, through a third-party provider in Phase 1 |
| Publishing channels | Instagram and Facebook in Phase 1, and connecting one of them is enough; more networks later |
| Output | 2 to 5 posts a week, as set in the business profile; each approved post goes to all connected channels and counts as one post |
| Publishing | Through a unified social API, connected to the customer's Instagram business account and Facebook Page |
| Guiding principle | Nothing goes live without the owner's explicit approval |

## Product flow

```mermaid
flowchart TD
  A[WhatsApp introduction] --> B[Build the business profile]
  B --> C[Choose a visual style]
  C --> D[Connect at least one channel - end of onboarding]
  D --> E{Weekly update?}
  E -- update sent --> F[Prepare content drafts]
  E -- no update --> G[Reminder, then no post that week]
  F --> H[Approve or request changes]
  H -- change requested --> F
  H -- approved --> I[Schedule and publish to connected channels]
```

## How the agent works

Decided by the human on 2026-11-05; the design and the human's decisions on it are in [docs/agent.md](docs/agent.md).

Postly is a **hybrid agent**. A language-model agent runs the conversation's thinking: it gathers the business's details, asks follow-up questions when an answer is vague or a detail is missing, asks for a photo, and creates and fixes the posts. It acts only through a fixed set of checked actions (tools). Code decides everything that must never go wrong: which message is actually sent and when, the 24-hour window and templates, the fact check, approval, scheduling, rendering and publishing. The agent never sends a message or publishes by itself, and nothing it writes counts as an approval.

- **Persona.** The agent introduces herself as "Postly" ("פוסטלי" in Hebrew), your AI social agent, as in the demo (decided 2026-11-05). The name is global; the team can set another name for a single business. In Hebrew she always speaks in the feminine. Her name never appears in a post.
- **Limits.** Each agent run has a step limit, a cost limit per run and per business per day, an overall daily cost limit, and a time limit; they are settings the team can change (the starting values are in [docs/agent.md](docs/agent.md#limits)). When a limit is hit, or the agent is unsure, a person from the Postly team takes over and the owner is told so.
- **Gradual rollout.** Each flow (onboarding, weekly update, drafts) switches to the agent separately, globally or per business, so the earlier fixed flow stays as the fallback until the agent proves itself.

## WhatsApp onboarding

1. Opening: the agent introduces itself and explains how the service works and how long onboarding will take.
2. Introduction: the agent asks plain-language questions, one at a time, to fill the required profile fields, follows up on a vague answer (for example "where exactly?" or "until what time?"), and closes by asking whether there is anything else customers should know. The owner can answer by text or voice message. Code decides when enough is known to move on.
3. Brand assets: the agent collects the logo, photos of the business and products, and any existing colors or design language.
4. Style selection: the agent sends a sample post about the business in each of the three styles, and the owner chooses one.
5. Profile summary and approval: the agent sends a short summary of what it understood, and the owner corrects or approves it.
6. Channel connection (last step): the owner connects at least one channel through a link: an Instagram business account, a Facebook Page, or both, right before publishing starts. See Connecting Instagram and Facebook.

Channel connection comes last so the owner has already seen value in the sample posts before the most cumbersome technical step.

## Business profile: the context the agent holds

Each business has a separate profile, and one customer's information is never used for another business. The profile has three parts: what the owner must provide, what has a default, and what the agent learns over time.

### Required fields and defaults

| Field | What is asked | Required | Default |
| --- | --- | --- | --- |
| Business name and field | What the business sells or provides, and its main products | Yes | None |
| Location and hours | City, address, hours, and pickup or delivery | Yes | None |
| Target audience | Who the customers are: age, neighborhood or area, and why they come | Yes | Local residents |
| What makes the business different | Why customers choose it over a competitor | Yes | None |
| Post language | Hebrew, Arabic, English, Russian, or a mix | No | Hebrew |
| Tone of voice | Formal, warm and familial, or humorous; masculine, feminine, or plural address; emoji use | No | Warm, plural address |
| Content types | Products, promotions, behind the scenes, tips, holidays and events, customer testimonials | No | Mix of products and promotions |
| Formats | Single post or carousel | No | Single post |
| Publishing channels | Instagram, Facebook, or both; one channel is enough | Yes | None |
| Publishing frequency | Posts per week, from 2 to 5 | No | 3 per week |
| Publishing days and hours | Asked during onboarding: whether to publish on Shabbat and holidays, and on which days and hours | No | No publishing on Shabbat and holidays |
| Logo and brand colors | Logo file and fixed colors, if any | No | Business name as text and style colors |
| Visual style | One of the three styles | Yes | None |
| Call to action | What the customer should do: visit, call, send a message, order online | No | Visit the store |
| Contact details | Phone, WhatsApp, website, or order link | No | None |
| Forbidden topics and language | Topics, words, or competitors not to mention | No | No politics, no competitor comparisons |
| Fixed hashtags | Hashtags of the business or city | No | Agent chooses by field and location |
| Approving contact | One number that approves posts in WhatsApp | Yes | The person who completed onboarding |

### Context that updates automatically

- Post history: what was published, when, and on which channel, to avoid repeating an idea.
- Preferences from corrections: every change the owner requests (for example no exclamation marks, or shorter captions) is saved immediately as a rule. A later phase will let owners define what is one-time and what is saved to memory.
- A library of the business's photos for reuse when needed.
- Weekly state: whether an update arrived, and how many posts are approved and scheduled.

## Visual styles

| Style | Characteristics |
| --- | --- |
| Clean | Bold typography, plenty of white space, few elements |
| Warm | Earth tones and textures |
| Dynamic | Bold graphic elements and a sense of movement |

Each style is a set of strict rules (colors, fonts, frames, caption and logo placement) with an output example. Designs are built from fixed templates rather than free generation, to keep them consistent. Dynamic learning from an existing style is reserved for Phase 2.

## Connecting Instagram and Facebook

This is the last onboarding step, right before the first post.

1. Choose channels: the business activates Instagram, Facebook, or both; one channel is enough.
2. Prepare the account: if the Instagram account is personal, the agent guides the owner step by step, with screenshots, to convert it to a business account. If the business chose Facebook and has no Page, the agent guides the owner to create one.
3. Connect channels: the owner receives a link and approves the connection to Postly, without sharing a password and without access to other customers' channels.
4. Test the connection: the agent verifies a post can be scheduled to each chosen channel, and only then does the business become active. The check asks the publishing provider to validate a scheduled post on the account; nothing is published.

## Weekly update and content preparation

Once a week, the owner sends the agent what is new in WhatsApp, for example new flowers or a promotion on dates, by text or voice message, along with photos.

- The agent reads the update, notes each fact with the owner's exact words as its source, and asks one focused question at a time when a detail a post needs is missing (for example when the promotion ends) or when no photo came.
- The agent splits the update into the number of posts set in the profile, and writes a caption and hashtags for each, adapted to each channel.
- Each post is built on the owner's own photo, with a fixed set of edits: cropping, straightening, brightness and contrast, a title band in the business's style, an optional badge (such as "-15%" or "New"), and the logo. A badge with a number must match a detail the owner gave. There is no image generation. The design is the same on both channels, with light adjustments to caption and size.
- A post can be a carousel of 2 to 10 slides; the agent chooses the order and the cover.
- If material is missing, the agent uses photos from the library or asks one focused question.
- If the owner sends several photos for what the plan makes a single post, the agent asks which they want: a carousel, one photo (the others are dropped), or a separate post per photo.
- Drafts are sent to the owner in WhatsApp, and the owner can request changes in plain words until satisfied: the agent applies each fix (caption, title, badge, photo edits, slide order, or one channel only) and sends the new version.
- One update a week is the norm. A second update while the drafts are still being prepared gets a reply that the agent is still working on the first; while drafts are open it is a change to them; after the week's update was already handled it counts for next week.

### Content safeguards

- A price, discount percentage, date, time, address, or phone number appears only if it came from the owner or the profile.
- Code compares these details in the draft against their source. If something does not match, the draft is not sent, and the agent corrects it or asks.
- If a detail is missing, the agent asks one question, for example when the promotion ends.
- A customer testimonial is published only from text the owner sent.
- Factual details are highlighted in the draft, so they are easy to check before approval.

## Approval and publishing

- Nothing goes live without the owner's explicit approval.
- Each draft has WhatsApp buttons: "Approve" and "Change". Each tap is tied to an exact post version, and any change invalidates an earlier approval.
- A free-text message such as "sounds good" does not count as approval. The agent resends the draft with the buttons.
- A free-text message that approves and asks for a fix at once, such as "perfect, just add the hours", is a change: the agent applies the fix and sends the new version with its buttons, and the owner taps Approve once more. Every new or changed version needs its own tap.
- One tap approves the post for all connected channels. A request to publish on only one channel is handled as a change.
- In Phase 1, each business has one approver, and approval is accepted only from that number. Number changes are done manually by the Postly team.
- After approval, and only then, the agent proposes publishing times based on the days and hours in the profile, and the owner approves or changes them. Without performance data the proposal says the time is the owner's usual slot; recommending the hours when followers are most active needs past results and comes later (WP-72).
- The agent schedules the posts, and they go live through the unified API on the connected channels at the set time.
- After publishing, the agent sends a short WhatsApp confirmation using an approved template, because the 24-hour window has usually closed. If publishing failed on a channel, it tells the owner and the Postly team which channel failed.

## A week without an update

If the owner has not sent an update, the agent sends a weekly reminder using an approved template. If no update arrives after that, no content is published that week.

In WhatsApp Business, a business-initiated message more than 24 hours after the customer's last message requires an approved message template. The reminder and publishing confirmations are therefore built with the WhatsApp provider in Phase 1. Proactive content suggestions remain a future capability.

## Payment, support, and disconnection

- Payment: there is no trial; the owner pays at once. The price is ILS 300 a month (decided 2026-11-04), kept in one setting the team can change from the console, with a history of every change; a new price applies to payment links sent after the change. When onboarding finishes (the channels pass their test and the business becomes active), the agent sends a payment link in WhatsApp; payment happens on the payment provider's page, and only identifiers and status are stored. The payment provider is not yet selected (PayPlus and Grow are candidates), so the payment simulator stands in behind an internal layer.
- Unpaid and failed payments (billing hold, T16, 2026-11-05): an owner who has not paid gets a 7-day grace period. It starts when the first payment link is sent (`pending`), or when a renewal fails (`past_due`). WhatsApp reminders go out on days 1, 3 and 6; publishing continues during the grace period. On day 7 publishing pauses: the business is paused through the same per-business pause the team uses, the owner is told, and nothing is deleted or cancelled: drafts, approvals already given, scheduled posts and all data stay. While paused, as with a team pause, new approvals and publishing wait. Payment recovers the subscription to `active`, resumes the business, and the waiting posts publish. A pause the team set is never lifted by a payment.
- Support: when the agent gets stuck, the founder responds during the pilot, in hours to be defined.
- Cancellation and disconnection: channels are disconnected immediately, and data is deleted after a retention period, 30 days by default (provisional until the human sets it).
- Global pause: a console button stops all publishing during security events and days of mourning.
- Monthly report: the owner receives a simple performance report, if the publishing provider supplies the data: on the first of each month, the number of posts published in the previous month, their total reach, and their total engagement (likes, comments, and shares). A month with no published post, or with no metric from the provider, sends nothing.

## Architecture

### WhatsApp connection

Decision: Phase 1 connects to WhatsApp through a Meta-authorized third-party provider (BSP) on the WhatsApp Business Platform. The recommendation is Twilio, with 360dialog as an alternative. Later, Postly moves to a direct WhatsApp Cloud API connection through its own Meta Business account.

Why a third-party provider now:

- Fast setup: a number, plus receiving and sending messages through a simple API and webhook.
- The provider handles business verification, template approval, and media (images and voice messages).
- An official, approved route, without the blocking risk of unofficial WhatsApp Web use.

What this costs:

- Provider fees on top of Meta's pricing.
- Provider dependency; moving directly to Meta will require migration work.

To keep migration easy, the agent's code talks to one internal messaging layer (send, receive, media), and only that layer knows the provider. Postly's WhatsApp number is registered from day one in Postly's Meta Business account, so the number stays the same after migration.

### Social network connection

Decision: Phase 1 publishes through a unified API designed for multi-tenant products. The recommendation is [Zernio](https://zernio.com/pricing), with [Ayrshare](https://www.ayrshare.com/use-cases/saas-platforms/) as an alternative, subject to a short test. If costs justify it, Postly can later move to a direct connection to Meta's Graph API.

Why a unified API now:

- The owner connects their channels without access to a shared Postly account.
- One integration covers Instagram and Facebook, and more networks later.
- The provider holds the app approvals with the networks and handles permissions.

What this costs:

- A per-customer cost that grows with the number of connected channels.
- Provider dependency; moving to another provider or directly to Meta will require reconnecting channels.

To keep migration easy, the agent's code talks to one internal publishing layer (connect channel, publish, check status), and only that layer knows the provider.

### System components

```mermaid
flowchart TD
  O[Business owner] --> W[WhatsApp provider - Twilio on WhatsApp Business Platform]
  W -- webhook --> S[Agent server - language model and conversation management]
  S --> D[Database - business profiles, posts, media]
  S --> E[Design engine - templates per style]
  S -- schedule --> U[Unified social API]
  U --> N[Instagram and Facebook]
```

- The agent server receives messages from the provider, loads the business profile by phone number, and manages conversation state.
- The database separates businesses; each model call receives only the relevant business's context.
- The design engine combines image, caption, and logo on a fixed template, so all of a business's posts look consistent.
- The unified API holds the permissions for Instagram accounts and Facebook Pages, and publishes at the scheduled time.

## Agent capabilities

### Can do in Phase 1

- Run an onboarding conversation in WhatsApp and fill in a business profile, with follow-up questions on vague answers.
- Ask one focused follow-up question about a missing detail or a missing photo in the weekly update.
- Understand text, voice messages, and images from the owner.
- Write captions and hashtags in the chosen language and tone, using only verified factual details.
- Edit the owner's photos with a fixed set of operations (crop, straighten, brightness and contrast, title band, an optional badge, carousel order) according to one of the three styles.
- Send drafts with approval buttons, receive changes, and save them immediately as rules.
- Schedule approved posts to connected channels and report success or failure.
- Send a weekly reminder and a simple monthly report.
- Guide conversion to an Instagram business account, Facebook Page creation, and connecting channels to Postly.

### Cannot do in Phase 1

- Publish without explicit approval.
- Suggest content on its own initiative.
- Accept approvals from more than one number per business.
- Learn a style from the business's existing Instagram or Facebook presence.
- Generate images from scratch, change what a photo shows, or create videos.
- Publish on networks other than Instagram and Facebook.
- Reply to comments or direct messages on Instagram and Facebook.
- Manage paid advertising.

| Capability | Phase |
| --- | --- |
| Onboarding, business profile, and separate context | Phase 1 |
| Three defined styles with examples | Phase 1 |
| Connecting at least one channel at the end of onboarding | Phase 1 |
| Weekly update, drafts, changes, and button approval | Phase 1 |
| Hybrid agent for onboarding, weekly data gathering, drafts and fixes, behind checked tools | Phase 1 |
| Photo edits from a fixed set, the badge element, and carousels | Phase 1 |
| Safeguards for factual details and customer testimonials | Phase 1 |
| Scheduling and publishing to Instagram and Facebook | Phase 1 |
| Weekly reminder and publishing confirmations through approved templates | Phase 1 |
| Simple monthly report, if the provider supplies data | Phase 1 |
| Global publishing pause | Phase 1 |
| WhatsApp through a third-party provider | Phase 1 |
| Multiple approvers and backup; consider separating business and individual customers | Phase 2 |
| Defining what is one-time and what is saved to memory | Phase 2 |
| Dynamic learning from an existing style | Phase 2 |
| Direct move to Meta's WhatsApp Cloud API | Phase 2 |
| Proactive content suggestions | Future |
| Networks beyond Instagram and Facebook | Future |

## Risks and open questions

- WhatsApp policy is the most severe risk: Meta prohibits AI providers when the technology is the primary functionality. Postly needs a written answer from the provider, an agent limited to its workflow, human handoff, and a fallback channel.
- Visual consistency is a key risk; the answer is strict templates and a rule-based design engine.
- Phase 1 has no direct connection to social network APIs; the unified API provider handles permissions, which creates a dependency on it.
- An initial estimate for WhatsApp and publishing is about $6-10 per customer a month, before models, transcription, storage, and support. The ILS 300 price is not yet validated against costs.
- Channel connection is the step where owners may drop off; it needs short, clear guidance.

### Open questions

- Whether Gemini Flash Lite and 20 messages of history are enough for the agent; revisited if the manual eval or dev use shows it is too weak ([docs/agent.md](docs/agent.md#decisions)).
- Payment provider: PayPlus and Grow are the candidates, with a placeholder implementation for now.
- What ILS 300 includes, and the billing hold copy (H6).
- Pilot support hours, and the data deletion period after cancellation (30 days provisionally).
- A written answer on WhatsApp policy, plus legal entity setup, Meta Business verification, a phone number, and templates.
- Testing Zernio and Ayrshare: link-based connection, Hebrew, carousels, failure notifications, performance data, and terms of use.
- Model and transcription quality in Hebrew, and full per-customer costs.
- Terms of use, privacy, content liability, and consent for using photos.
- Monitoring and alerting are required, but no solution is selected yet.
