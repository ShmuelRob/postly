# Postly Technical Design

Postly is one TypeScript monolith on Google Cloud. Code owns the workflow, and models run only bounded tasks, so a model cannot publish or approve anything.

## Principles

- One repository, one language, and one deployable image, running as a web process and a worker process.
- A deterministic state machine manages each business, conversation, and post.
- Every model call goes through one internal layer, and its output is validated against a schema.
- Every external vendor sits behind an internal interface, so it can be replaced.
- Approval and publishing are code paths with no model involved.

## Stack

| Layer | Choice | Status |
| --- | --- | --- |
| Language and runtime | TypeScript in strict mode on Node | Decided |
| Server | Fastify | Decided |
| Database | Postgres with row-level security | Decided |
| Data access | Drizzle | Decided |
| Jobs and scheduling | pg-boss | Decided; move to Temporal only if long-running workflows outgrow it |
| Validation | Zod | Decided |
| Design engine | HTML templates, Playwright with Chromium, and sharp | Decided |
| Internal console | React | Decided |
| Hosting | Google Cloud: Cloud Run, Cloud SQL, and Cloud Storage | Decided |
| Models | Google for now, behind a replaceable model layer | May change |
| WhatsApp | Twilio, with 360dialog as an alternative | Pending policy answer |
| Publishing | Zernio, with Ayrshare as an alternative | Pending test |
| Payments | Placeholder behind an internal interface; PayPlus and Grow are candidates | Open |
| Monitoring and alerting | Required | Open |
| Module boundaries | dependency-cruiser rules, enforced in CI | Decided |
| CI | GitHub Actions: typecheck, unit and contract tests, end-to-end suite; a failure blocks merging | Decided |
| Test database | Postgres in Docker through Testcontainers, so roles and RLS behave as in production | Decided |
| Holiday calendar | `@hebcal/core` with the Israel schedule, computed in `business.timezone` | Decided |
| Fonts | Hebrew fonts under the SIL Open Font License, stored in the repository; see [design-styles.md](design-styles.md) | Decided |
| End-to-end reports | A static HTML report per run: WhatsApp transcript, rendered images, publishing simulator log, and pass or fail | Decided |

The worker must run continuously, so Cloud Run needs at least one active instance for it.

## Modules

| Module | Responsibility |
| --- | --- |
| Messaging | Receives webhooks, removes duplicates, merges short message bursts, sends messages and templates |
| Workflow | State machines for onboarding, conversation, and posts |
| Model layer | Task routing, prompt versions, schema validation, cost tracking, and logging |
| Content | Fact extraction, weekly planning, captions, and factual checks |
| Design | Renders posts from style templates and produces a file for each network |
| Publishing | Connects channels, publishes, and checks status |
| Business data | Profiles, preferences, post history, and media library |
| Billing | Payment links, subscription status, and the placeholder provider |
| Console | Conversations, drafts, errors, manual intervention, and the global pause |

## Task routing

| Step | Owner | Model tier |
| --- | --- | --- |
| Intent detection | Model | Low cost |
| Voice transcription | Transcription model | Dedicated |
| Profile field extraction during onboarding | Model | Mid tier |
| Fact extraction into a fixed structure | Model | Mid tier |
| Weekly post planning | Model, validated by code | Mid tier |
| Caption writing per channel | Model | Strongest that is cost-effective in Hebrew |
| Change request interpretation | Model | Mid tier |
| Image selection and quality check | Vision model | Mid tier |
| Factual comparison against the source | Code, with an optional model check | Low cost |
| Rendering, approval, scheduling, and publishing | Code only | None |

## Control over prompts, models, and flow

- Prompts: each task has a versioned template, and each call records the version used.
- Models: a configuration table sets model, provider, fallback, temperature, and cost limit per task.
- Flow: states, transitions, retries, and approval points are defined in code. One business or the whole system can be paused.
- Quality: each run stores input, prompt, output, cost, and duration. Prompt or model changes run against a real Hebrew example set first.

## Core data model

The full schema is in [database-schema.md](database-schema.md), and the state machines are in [state-machines.md](state-machines.md).

| Entity | Key contents |
| --- | --- |
| `business` | Profile, status, style, and approver phone number |
| `channel_connection` | Network, provider account identifier, and connection status |
| `preference_rule` | Rule saved from a correction, and the correction it came from |
| `weekly_update` | Original message, transcript, and extracted facts |
| `post` | Business, plan, and current state |
| `post_version` | Caption, rendered media, content hash, and factual sources |
| `approval` | Approved version hash, approver number, and time |
| `publication` | Channel, schedule, status, provider post identifier, attempts, and error |
| `conversation_state` | Current step and open question |
| `subscription` | Plan, status, and payment provider identifiers |
| `model_run` | Task, prompt version, model, cost, input, and output |
| `message` | Every inbound and outbound WhatsApp message, for deduplication, the 24-hour window, and the console |
| `media_asset` | Owner photos, logos, voice messages, and rendered files |
| `console_item` | Work routed to a person: failed validation, failed publishing, unknown numbers, and handoffs |
| `model_task_config`, `prompt_template`, `system_control` | System tables: model settings per task, prompt versions, and the global pause |

Every business-owned table is protected by row-level security. The publishing job accepts only a publication tied to an approved version hash.

## Internal interfaces

Request and response schemas for each interface are in [contracts.md](contracts.md).

- `MessagingProvider`: send text, send template, send buttons, receive media, verify webhook.
- `PublishingProvider`: create connection link, get connection status, publish, get publication status, get metrics.
- `ModelProvider`: generate structured output, analyze image, transcribe audio.
- `PaymentProvider`: create payment link, get subscription status, cancel subscription, verify a signed status webhook.
- `TemplateRenderer`: render a post version to a file for each network.

## Operational defaults

These are defaults stored in configuration, so they can change without a code change. Times are in `business.timezone`.

| Setting | Default |
| --- | --- |
| Message burst merge | Inbound messages from one number are merged until 20 seconds pass without a new one |
| Model output retries | `model_task_config.max_retries` is 2, so 3 attempts in total before routing to the console |
| Publication retries | 3 attempts in total, 5 and then 15 minutes apart, each preceded by a provider status check |
| Business week | Sunday 00:00 to Saturday 23:59; the `weekly_update` row is created at Sunday 00:00 |
| Weekly reminder | Monday 10:00, if the week is still `awaiting` |
| Week cutoff | Thursday 12:00: a week still `awaiting` or `reminded` moves to `skipped` (`WEEK_ENDED`) |
| Channel health check | Daily at 06:00 |
| No publishing on Shabbat and holidays | From 30 minutes before candle lighting to 30 minutes after havdalah, by the business's city when `@hebcal/core` knows it, otherwise Jerusalem |

## Onboarding flow

Built in WP-30 (2026-11-03); the copy is provisional (H6) and queued for the human. The workflow module runs the [onboarding machine](state-machines.md#onboarding); each step uses the module that owns it.

- **Inbound media.** Messaging downloads every voice note and image through `getMedia`, stores the file, records a `media_asset` row (`voice` or `photo`, source `owner`), and passes the asset ids with the burst. Voice notes are transcribed with the `transcription` task before anything reads the text.
- **Profile questions.** One or two topics per message, in a fixed order: name, field and products; location, hours, and pickup or delivery; audience and differentiator; channels and Shabbat publishing. Each answer goes to `profile_extraction` with the fields asked, and the fields found merge into the `BusinessProfileDraft` in `business.profile`. A question whose required fields stay empty is asked again, up to three times in all, and then the conversation is handed off to a person.
- **Brand assets.** The agent asks for a logo, then for photos of the business; the owner can skip each. The first image after the logo question is the logo (`brand.logoAssetId`).
- **Style samples.** The design module renders one sample post per style from the owner's first photo (or a bundled sample photo when there is none), with the business name and logo, and messaging sends each with its style name. The owner answers with a style name or number.
- **Profile review.** A short summary; the owner approves by text from the approver number, or writes a correction, which goes through `profile_extraction` and resends the summary.
- **Channel connection.** The publishing module creates a `pending` `channel_connection` per chosen network and sends the provider link. The owner writes when done; the module reads the provider status and applies `CONNECTED`, then the test (`TEST_PASSED`), and the business becomes `active`.
- **Unprocessed messages.** A burst waits in memory for the quiet window, and its messages stay in `message` with `processed_at` null until the workflow has consumed them. A sweep at startup and then every quiet window hands every such message older than the quiet window to the workflow again, grouped by business and sender, so a restart, a second instance, or a failed handler loses nothing (review queue item 14). The sweep runs in the web process (`App.start()`), next to the bursts it must skip: a message still waiting or still being handled there is never handed over twice. Across two web instances a slow burst can still be handed over twice; that waits for durable bursts (a pg-boss job keyed by business and sender).

## Weekly update flow

Built in WP-31 (2026-11-03); the copy is provisional (H6) and queued for the human. The workflow module runs the [weekly update machine](state-machines.md#weekly-update) and the conversation's first step; the content module owns the code checks on the model output.

- **Week rows.** A scheduler tick (`WeeklyUpdates.tick(now)`) runs every hour. It finds active businesses with `withSystem('scheduler')`, then per business, in the business's timezone, it does what is due: from Sunday 00:00 it creates the week's `weekly_update` row (`awaiting`; an existing row is kept); from Monday 10:00, for a week still `awaiting`, it applies `REMINDER_SENT` first and then sends the reminder, so a crash or a second tick never sends it twice (at most once: a failed send is logged and not retried; WP-32 fix); from Thursday 12:00 it applies `WEEK_ENDED` to a week still `awaiting` or `reminded` (a week that was never reminded, for example because the business was activated after Monday 10:00, closes at the cutoff too; WP-32 fix). Each step is idempotent, so a late or repeated tick does no harm.
- **Reminder template.** `weekly_reminder`, in the business's first language, with one variable, `businessName`. It goes out with `sendTemplate`, because the 24-hour window is usually closed. The template text is submitted to WhatsApp for approval with the H6 copy.
- **Recognizing an update.** A burst from the approver number while the conversation is `idle` is an update when it holds a photo or a voice note, or when `intent_detection` on its text returns `weekly_update`. Other intents are left to the packages that handle them. Voice notes are transcribed first, as in onboarding.
- **Which week.** The update goes to the current week when it is `awaiting` or `reminded` (`UPDATE_RECEIVED`). A missing row (a business activated mid-week) is created first. **Late update:** when the current week is already `skipped` (after the Thursday cutoff), the update is not lost: it opens next week's row early and counts as next week's update, and the owner is told the posts go out next week. Decided 2026-11-03 by WP-31 and queued for the human.
- **A second update in the same week** (decided 2026-11-03 by WP-32, queued for the human). An update is never dropped without a reply. While the conversation is `processing_update` or `awaiting_answer` (the agent is still preparing the last update's drafts), the owner is told the agent is still working on the previous update and to send the new details as a change once the drafts arrive; nothing is applied. While it is `reviewing_drafts`, the update is a change request on the open drafts (state-machines.md, Conversation). While it is `idle` and the current week is already `received`, `needs_review`, or `planned`, the update counts as next week's update (next week's row is opened early), and the owner is told this week already has its update (not that the week closed); if next week's row is not open either, the owner is told an update for next week is already in.
- **Stored on the row.** `original_text` (the typed text), `transcript` (the voice transcripts joined), `media_asset_ids` (the photos), `received_at`, and after extraction `extracted_facts`.
- **Fact extraction.** `fact_extraction` gets the text, the transcript, and a short profile summary. Code then checks that every `sourceQuote` appears word for word (whitespace runs count as one space) in the text or the transcript, and that a `testimonial` quote appears in the typed text. A failed check counts as a failed attempt in the model layer (`RunOptions.check`), so it retries like a schema failure and then lands in the console.
- **Weekly planning.** `weekly_planning` gets the facts, `postsPerWeek`, the profile's content types and formats, and the photos. Code checks that there are exactly `postsPerWeek` posts, that every `factIds` entry is an extracted fact, every format is in the profile, and every `mediaAssetIds` entry is a photo of this update. The same retry rule applies.
- **Plan stored.** `FACTS_EXTRACTED` saves `extracted_facts` and inserts one `post` per planned post (`planned`, `position` in plan order, `format`, `plan`) in the same transaction; then the conversation moves from `idle` to `processing_update` (`UPDATE_RECEIVED`) and the owner gets a short acknowledgment. Missing details stay in `extracted_facts.missingDetails`; drafting asks about them (WP-32).
- **Failure.** When extraction or planning fails every attempt, `EXTRACTION_FAILED` moves the week to `needs_review` (the console item already exists), the conversation stays `idle`, and the owner is told the team is looking at it. Any other error while extracting, planning, or storing the plan also applies `EXTRACTION_FAILED` and opens an `extraction_failed` console item, so a week never stays `received` unseen (WP-32 fix). A model failure before the update is recognized (transcription or intent) hands the conversation to a person, as in onboarding, and the owner gets a neutral line that a person will answer, never "update received" (WP-32 fix).

## Drafts flow

Built in WP-32 (2026-11-03); the copy and the `caption_writing` version-2 prompt are provisional (H6, H7) and queued for the human. The workflow module runs the [post machine](state-machines.md#post) and the conversation from `processing_update` to `reviewing_drafts`; the content module owns the fact check and the content hash; the design module renders. Approval itself is WP-33.

- **When.** Right after the plan is stored (`FACTS_EXTRACTED`, conversation `processing_update`), the week's posts are drafted one by one in `position` order, in the same handler (WP-44 may move this to a job). When every post is sent, failed, or waiting for an answer, `DRAFTS_SENT` moves the conversation to `reviewing_drafts`. When no draft could be sent at all, the conversation is handed off to a person (the console items already exist) and the owner is told the team is looking at it. Any other error while drafting (not a model failure, for example a send that fails) opens a `draft_failed` console item for the week and hands the conversation to a person, so it never waits in `processing_update` answering every message with "still working" (review of PR #43).
- **Several photos.** A post planned as `single` with more than one photo is not drafted yet: `DRAFT_STARTED`, then `DETAIL_MISSING` (`awaiting_clarification`), and the conversation asks one question (`QUESTION_ASKED`, open question `photo_choice` with the post id): 1 for a carousel, 2 for one photo, 3 for a post per photo. Choices are answered by text, because buttons carry approval payloads only. Code reads the answer from the digit or the words (קרוסלה; אחת; כל תמונה or נפרד); any other answer is asked again, up to three times in all, and then the conversation is handed off. On a valid answer the conversation applies `ANSWER_RECEIVED` and the post `DETAIL_PROVIDED`. Carousel sets the post's `format` to `carousel` (the owner's choice wins over the profile's formats); one photo keeps the first photo; a post per photo keeps the first photo on this post and inserts a new `planned` post for each other photo after the week's last position, so the week can hold more posts than `postsPerWeek`.
- **Caption.** `caption_writing` gets the plan, the facts the plan names, a short business context, the active preference rules, the post's networks (the profile's channels, or the networks of the current version after a channel change), the languages, the tone, the fixed hashtags, and on a redraft the change instructions (`changes`). Code runs the fact check below as `RunOptions.check`, so a mismatch is a failed attempt: the model retries, and when every attempt fails the post moves to `needs_review` (`DRAFT_FAILED`; the model layer's console item exists) and nothing is sent for it. The optional `fact_check` model task is not used in Phase 1.
- **Fact check (code).** Every `usedFactIds` entry must be a fact the plan named. Then each detail in every caption's text and hashtags is matched against sources of its own kind (review of PR #43): a phone (by its digits, `+972` read as `0`) against a phone fact or the profile's contact details; a price (a number next to ₪, ש"ח or שקל) against a price fact or a number shown as a price in a source; a discount (a number with %) against a discount fact or a percentage in a source; a time (`H:MM`) against a time fact or a time in a source such as the hours; a date (`D/M` or `D.M`) against a date fact or a date in a source; a weekday name (יום ראשון to שבת) against the sources. Any other number (a house number, a quantity) may match any number in the sources. So "12 ₪" fails even when the address has 12. The sources are the used facts (value and quote) and the profile's address, city, hours, contact details, and differentiator. A testimonial is written only from a fact the owner typed (checked at extraction). The used facts are stored on the version as `fact_sources`.
- **Rendering.** The design module renders the post in the business's style with the plan's photos (all of them for a carousel, the first for a single post). A post with no photo uses the business's latest owner photo from the media library, or the bundled sample photo when there is none. The overlay text is the plan's `topic`; the logo and brand colors come from the profile; the networks are the post's networks. Every rendered file is stored as a `media_asset` (`rendered`, source `render`) by the design role, and `rendered_media` maps each network to its asset ids in slide order. A render error is handled like a failed draft: `DRAFT_FAILED` and a `draft_failed` console item.
- **Version.** A new `post_version` (the next `version_number`) holds the captions, `rendered_media`, `fact_sources`, `fact_check_passed` (always true: a draft that fails the check is never written), and `content_hash`: SHA-256 (lowercase hex) of the canonical JSON (keys sorted) of `{ format, captions, renderedMedia }`. `post.current_version_id` points at it, in the same transaction.
- **Sending.** The Approve button carries the hash of every network's caption and render, so the owner is shown all of them before the buttons (review of PR #43). Networks go in a fixed order, Instagram then Facebook. Each render of a network after the first that differs from the first's (compared by the files' SHA-256, so an identical render is shown once) is sent first as an image labelled with its network (`sendText` with `mediaUrl`); for a carousel, each slide of the first network is sent too. Then one `sendButtons` message carries the first network's cover image, the captions (shown once when they are identical, otherwise each under its network's name), and a "details to check" line listing the factual details (PRD, Content safeguards), with two buttons, אישור and שינוי. Each button id is `<action>:<postId>:<versionHash>`, which the messaging adapter maps to `ApprovalButtonPayload`. Then `DRAFT_READY` moves the post to `awaiting_approval`.
- **While drafts are open** (`reviewing_drafts`). An Approve tap goes to the [approval flow](#approval-flow) (WP-33). A Change tap asks what to change and remembers the post (open question `change_request` with the post id). A text goes to `intent_detection` (step `reviewing_drafts`, drafts open): a `change_request` or a `weekly_update` is a change request on the post the owner tapped Change on, or else on the only open draft; with several open drafts and no tap, the owner is asked to tap Change on the draft they mean. Any other text (such as "sounds good") resends every open draft with its buttons, unchanged. A post in `awaiting_approval`, `approved` or `scheduled` takes a change here; a change to an `approved` or `scheduled` post invalidates its approval first (see the approval flow). A Change tap does not compare its `versionHash` with the current version: a change always applies to the current version, so an old draft's Change button is harmless. Approve taps never follow this pattern (review of PR #43, item 3). A button tap while the several-photos question is open is not an answer: the question is asked again without counting an attempt (item 4).
- **A change.** `change_interpretation` reads the text with the current captions and plan. The change is saved at once as a preference rule (PRD, Context that updates automatically): the model's `rule` when it gives one, otherwise the instructions joined, with the scope of the first change (`caption`; `design` for design and media; `schedule`; `general` for channels). The rule's `source_message_id` is the owner's message and `source_post_version_id` the version it changed. A `channels` change that names only Instagram or only Facebook narrows the post's networks to that one. Then the conversation applies `CHANGE_REQUESTED` (to `processing_update`), the post `CHANGE_REQUESTED` (to `drafting`), and the post is drafted again with the change instructions and every active rule: a new version, a new hash, and new buttons; `DRAFTS_SENT` returns the conversation to `reviewing_drafts`.
- **Still open.** Missing details from extraction (`extracted_facts.missingDetails`) are not asked about yet: the caption may not invent them, and the fact check blocks any number without a source. Asking one focused question about them is a follow-up.

## Approval flow

Built in WP-33 (2026-11-04), queued for the human (approval code). The approval service (`createApprovals` in the workflow module, running as the `approval` role) implements `ApprovalService` from [contracts.md](contracts.md#approval-and-publishing), behind the [approval guard](state-machines.md#approval-guard). No model is involved.

- **Routing.** Messaging hands every button reply over as a burst of its own. In an active business, an Approve tap from any conversation step goes to the approval service before any other flow; a Change tap goes to drafts. Messages from a number that is no business's approver never reach a business (technical-design.md, Failure handling: an unknown number becomes a console item), so a stranger's tap approves nothing.
- **Checks, in order.** A message that is not a button reply, or a button whose action is not `approve`, is `not_a_button`. A sender other than `business.approver_phone` is `not_approver`. A business that is not `active` (onboarding, paused, cancelled) approves nothing: `wrong_state`. A business in handoff is `handoff`. Then the message is recorded (the stored row when messaging received it, otherwise messaging stores it with `processed_at` set), and one transaction locks the post row (`for update`) and checks: an approval already tied to this message is `duplicate`; no such post for this business (RLS hides another business's post) is `unknown_post`; a hash that is not the hash of `post.current_version_id` is `stale_version` (including a hash of no version and another post's hash); a post not in `awaiting_approval` is `wrong_state`. The transaction is the workflow's `apply` for `APPROVED`, run as the `approval` role (an event may name a role other than the machine's default, when that role may update the status column): the duplicate check comes before it, `not_found` is `unknown_post`, a transition not allowed from the current state is `wrong_state`, and the hash check is the event's guard. Only then the `approval` row is inserted (version id, hash, approver phone, message id, time) and the post moves to `approved`, in the same transaction. A draft is sent before `DRAFT_READY` is applied, so if that event is refused the owner holds buttons for a post that is not `awaiting_approval`; the state check refuses them (`wrong_state`; review of PR #43, item 2). The unique `approval.message_id` turns a concurrent second handling of one message into `duplicate`; the post lock makes a second tap wait and then see `wrong_state`.
- **Replies.** An approval gets a short confirmation. A `stale_version` or `wrong_state` tap gets a line that the draft is no longer current, and the open drafts are sent again with their buttons. `not_approver` and `handoff` get no reply. The conversation stays in `reviewing_drafts` after the last approval: `ALL_DRAFTS_RESOLVED` and the time proposal are WP-34.
- **Invalidation.** Before any new `post_version` is written, and before `CHANGE_REQUESTED` is applied to an `approved` or `scheduled` post, every approval of the post that is not invalidated gets `invalidated_at` (approval role) and its `scheduled` or `retry_pending` publications are cancelled (publishing role). Invalidation comes first, so a failure after it leaves a post that cannot publish, never one that publishes stale content; the publishing guard checks the approval again anyway. When the change is then refused, the post stays `approved` with no valid approval, so a `draft_failed` console item (reason `change refused after approval was invalidated`) tells the team (review of PR #48).
- **Scheduling (interim).** Until WP-34, scheduling an approved post (the owner confirming times) creates one `scheduled` publication for each network of the approved version (the keys of its captions, so a post narrowed to Instagram publishes only there), each on that network's `verified` connection, from the post's valid approval, copies the approved hash, and applies `SCHEDULED`, in one publishing-role transaction. If a network of the approved version has no verified connection, nothing is scheduled and the call fails (review of PR #48); WP-34 turns that into an owner message and a console item. WP-34 adds the time proposals and the publishing job.

## Failure handling required in Phase 1

- The 24-hour window closes mid-flow: send an approved template, or wait for the owner.
- A draft gets no response: keep it unapproved and do not publish it.
- Approval arrives after the proposed time: propose a new time.
- One channel fails: record per-channel status, retry safely, and notify the owner and team.
- A channel disconnects: daily health check, then notify the owner with a template.
- A message comes from an unknown number: never accept approval or changes from it.
- A model output fails validation: retry within a limit, then route to the console.

## Console (Phase 1)

The internal team's console lives in `src/modules/console/`: Fastify routes under `/console` (a JSON API under `/console/api` and a React page rendered on the server) that read and write only through `withSystem('console')` and the workflow module. Its actions:

| Action | Effect |
| --- | --- |
| List businesses, conversations, drafts, console items, and the global pause | Read only |
| Resolve a console item | `status` becomes `resolved` |
| Route a console item | Starts a [handoff](state-machines.md#human-handoff) for the item's business and resolves the item; an item without a business can only be resolved |
| Start or clear a handoff | `startHandoff` / `clearHandoff` of the workflow module |
| Retry a failed publication | Publication `RETRY_REQUESTED`, and the post `PUBLISHING_STARTED` when it is `failed`; the publishing job still checks the approved hash before anything goes live; resolves the matching `publication_failed` items |
| Pause or resume a business | Business `PAUSE` / `RESUME` (resume needs a `verified` channel connection) |
| Pause or resume all publishing | `system_control` through `setGlobalPause` |

Authentication is not defined yet, so the routes answer only requests from the loopback address; anything else gets 403. Team sign-in must be decided before the console is deployed.

## Security

- Row-level security on all business data, and each model call receives only that business's context.
- Provider tokens and secrets stay in a secret manager.
- Webhooks are verified before processing.
- Media URLs stay stable until publishing, and retention follows a defined policy.
- Payment card details are never stored.

## Environments

- Local and test environments use simulators for WhatsApp, publishing, models, and payments. A local playground (WP-45) lets a human play the business owner against those simulators in a browser; it is never deployed.
- Staging uses test accounts and test keys only.
- Production access is limited and separate from agent environments.
- Staging and production run on Google Cloud as described in [deployment.md](deployment.md): one image run as `web`, `worker` or `migrate`, Cloud Run, Cloud SQL with a private IP only, a private media bucket, and Secret Manager. Decided in WP-44: pg-boss connects as its own login `app_jobs`, which owns only the `pgboss` schema and has no grant on any business table; the migration job creates it and sets every login's password from Secret Manager. The weekly tick is an hourly pg-boss schedule on a singleton queue. The web service runs one instance until bursts are durable (review queue item 14). Nothing is deployed until the human applies it (gate H8).

## Still required before core development

- Final style spec and a real Hebrew example set, replacing the provisional ones in [design-styles.md](design-styles.md).
- Conversation copy, WhatsApp template text, and channel connection guidance.
- Success metrics and acceptance criteria.
- Console sign-in for the team, monitoring choice, and media retention policy.
