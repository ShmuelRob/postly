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
- `PaymentProvider`: create payment link, get subscription status, cancel subscription.
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
| Week cutoff | Thursday 12:00: a week still `reminded` moves to `skipped` (`WEEK_ENDED`) |
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
- **Unprocessed messages.** A burst waits in memory for the quiet window, and its messages stay in `message` with `processed_at` null until the workflow has consumed them. A sweep at startup and then every quiet window hands every such message older than the quiet window to the workflow again, grouped by business and sender, so a restart, a second instance, or a failed handler loses nothing (review queue item 14).

## Failure handling required in Phase 1

- The 24-hour window closes mid-flow: send an approved template, or wait for the owner.
- A draft gets no response: keep it unapproved and do not publish it.
- Approval arrives after the proposed time: propose a new time.
- One channel fails: record per-channel status, retry safely, and notify the owner and team.
- A channel disconnects: daily health check, then notify the owner with a template.
- A message comes from an unknown number: never accept approval or changes from it.
- A model output fails validation: retry within a limit, then route to the console.

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

## Still required before core development

- Final style spec and a real Hebrew example set, replacing the provisional ones in [design-styles.md](design-styles.md).
- Conversation copy, WhatsApp template text, and channel connection guidance.
- Success metrics and acceptance criteria.
- Console specification, monitoring choice, and media retention policy.
