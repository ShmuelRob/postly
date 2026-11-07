# Postly Contracts

Status: approved contract (2026-11-02).

This document defines the Zod schemas for model tasks, the business profile, and the internal provider interfaces. The code in `src/contracts/` implements it one to one. Field-level details that are easy to read in code (string lengths, exact regexes) live in the code; this document fixes names, shapes, and rules.

## Shared types

| Schema | Shape |
| --- | --- |
| `Phone` | E.164 string, such as `+972501234567` |
| `Network` | `instagram` or `facebook` |
| `Language` | `he`, `ar`, `en`, or `ru` |
| `VisualStyle` | `clean`, `warm`, or `dynamic` |
| `PostFormat` | `single` or `carousel` |
| `ContentType` | `products`, `promotions`, `behind_the_scenes`, `tips`, `holidays_and_events`, `testimonials` |
| `ContentHash` | Lowercase hex SHA-256, 64 characters |

## Business profile

`BusinessProfile` is the complete profile stored in `business.profile` once onboarding is approved. `BusinessProfileDraft` is the same shape with every field optional, used during onboarding. Defaults come from the PRD and are applied by `BusinessProfile`, so a missing optional field resolves to its default.

| Field | Required | Default |
| --- | --- | --- |
| `name`, `field`, `mainProducts` | Yes | |
| `location`: `city`, `address`, `hours`, `fulfillment` (`pickup`, `delivery`, or both) | Yes | |
| `targetAudience` | Yes | `Local residents` |
| `differentiator` | Yes | |
| `languages` | No | `["he"]`; more than one means a mix |
| `tone`: `register` (`formal`, `warm`, `humorous`), `address` (`masculine`, `feminine`, `plural`), `emoji` (boolean) | No | `warm`, `plural`, emoji allowed |
| `contentTypes` | No | `products`, `promotions` |
| `formats` | No | `single` |
| `channels` | Yes | At least one network |
| `postsPerWeek` | No | 3; integer from 2 to 5 |
| `schedule`: `publishOnShabbatAndHolidays`, `days` (0 to 6, Sunday is 0), `hours` (`HH:MM`) | No | No Shabbat or holidays; empty days and hours mean the agent proposes times |
| `brand`: `logoAssetId`, `colors` (hex) | No | Business name as text, style colors |
| `style` | Yes | |
| `callToAction` | No | `visit` (also `call`, `message`, `order_online`) |
| `contact`: `phone`, `whatsapp`, `website`, `orderUrl` | No | |
| `forbiddenTopics` | No | Politics, competitor comparisons |
| `fixedHashtags` | No | Empty; the agent chooses by field and location |
| `approverPhone` | Yes | The number that completed onboarding |

`missingRequiredProfileFields(draft)` returns the required fields that are still empty. The onboarding guard `PROFILE_FIELDS_COMPLETE` passes only when it returns none other than `style`, which the style selection step fills.

### `OpenQuestion`

What the agent is waiting for, stored in `conversation_state.open_question` (added in WP-30, queued for the human): `key` (which question of the step), `askedFields` (profile fields the question asks for; may be empty), `attempts` (how many times it was asked), `photoAssetIds` (business photos the owner sent during onboarding, not part of the profile), and an optional `postId` (the post a drafts question is about: `photo_choice` or `change_request`; added 2026-11-03 by WP-32, queued for the human), and optional `proposals` (the `schedule_confirmation` question: each proposed post's `postId` and time `at`; added 2026-11-04 by WP-34, queued for the human). The key `drafts_waiting` (WP-35, no schema change) marks drafts that could not be sent because the 24-hour window had closed. The schema is in `src/contracts/open-question.ts`.

## Model tasks

Each task has an input schema and an output schema. The model layer validates the output against the task's output schema before anything else sees it; an invalid output is retried within `model_task_config.max_retries` and then routed to the console. Approval, scheduling, and publishing are not model tasks, and no model output is ever accepted as an approval.

| Task | Input | Output |
| --- | --- | --- |
| `intent_detection` | Message text, current conversation step, whether drafts are open | `intent` and `confidence` (0 to 1). Intents: `weekly_update`, `answer`, `change_request`, `schedule_response`, `question`, `support_request`, `cancel_request`, `other`. There is no approval intent. |
| `transcription` | Voice media asset id, language hint | Transcript text and detected language |
| `profile_extraction` | Owner message, current `BusinessProfileDraft`, the fields being asked | A partial `BusinessProfileDraft` with only the fields found, and the fields still unclear |
| `fact_extraction` | Weekly update text and transcript, a profile summary | `facts`: each with an `id`, `type`, `value`, and `sourceQuote`; and `missingDetails` |
| `weekly_planning` | Extracted facts, posts per week, content types, formats, available media asset ids | 2 to 5 `posts`: each with `topic`, `contentType`, `format`, `factIds`, `mediaAssetIds`, and `brief` |
| `caption_writing` | Post plan, facts, business context, active preference rules, target networks, languages, tone, fixed hashtags, and optional `changes` (the change instructions on a redraft; added 2026-11-03 by WP-32, queued for the human) | `captions`: per network, `text` and `hashtags`; and `usedFactIds` |
| `change_interpretation` | Change request text, current captions, current plan | `changes` to apply (at least one, each with a `target` of `caption`, `design`, `media`, `channels`, or `schedule` and an `instruction`), and an optional `rule` to save as a preference with its `scope` |
| `image_review` | Media asset id, purpose (post photo or logo) | `usable`, `score` (0 to 1), `issues`, and an optional normalized `crop` (`x`, `y`, `w`, `h` in 0..1, the same rectangle as a `DesignSpec` crop, WP-94) |
| `fact_check` | Caption text and the facts it may use | `mismatches`: each with the caption text and the issue |

With the hybrid agent (2026-11-05, [agent.md](agent.md), queued under H1 and H7) three tasks are added, each on Gemini 3.5 Flash-Lite in `model_task_config` (A8), all with the input `AgentContext` and the output `AgentStep` ([Agent](#agent)): `agent_onboarding`, `agent_weekly` and `agent_drafts`. `image_review` gains output fields: `description` (up to 200 characters, what the photo shows, for the agent), and suggested `rotateDeg`, `brightness` and `contrast` within the [photo edit ranges](agent.md#photo-edits). The one-shot tasks stay in the registry as the fallback (agent.md, A9).

Fact types are `price`, `discount_percent`, `date`, `date_range`, `time`, `address`, `phone`, `product`, `promotion`, `testimonial`, and `other`.

Code checks that the schema cannot express:

- `fact_extraction`: every `sourceQuote` appears verbatim in the source text or transcript (whitespace runs count as one space), and the quote of a `testimonial` fact appears in the typed text the owner sent.
- `weekly_planning`: the number of posts equals `postsPerWeek`, every `factIds` entry exists, and every format is allowed by the profile.
- A failed code check counts as a failed attempt: the model layer takes the check as `RunOptions.check`, retries, and then routes to the console, as for a schema failure.
- `caption_writing`: every price, discount, date, time, address, and phone number in a caption matches a fact in `usedFactIds` or the profile. This code comparison is the fact check; the `fact_check` model task is optional and only adds mismatches. The exact rules are in technical-design.md, Drafts flow.

What a `post_version` stores (WP-32): `captions` is `ChannelCaptions`; `rendered_media` (`RenderedMedia`) maps each network to its rendered `media_asset` ids in slide order; `fact_sources` (`FactSource[]`) is the used facts, each `factId`, `type`, `value`, and `sourceQuote`; `content_hash` is the SHA-256 of the canonical JSON of `{ format, captions, renderedMedia }`. The schemas are in `src/contracts/post-version.ts`.

## Agent

Proposed 2026-11-05 with the hybrid agent ([agent.md](agent.md)); queued for the human (H1). The schemas are in `src/contracts/agent.ts` and `src/contracts/design-spec.ts` (WP-89). The content shapes that both the model tasks and the tools use (`Fact`, `PlannedPost`, `ChannelCaptions`, the preference scopes) moved to `src/contracts/content.ts`, re-exported by `model-tasks.ts`, so the two files do not import each other. `AgentToolCall` is a plain union of objects with a literal `tool`, so its JSON Schema uses `anyOf` for the model's structured output. Until the scripted agent (WP-91) exists, the model simulator answers an agent task with one `hand_off_to_console` step.

| Schema | Shape |
| --- | --- |
| `AgentName` | `onboarding`, `weekly`, or `drafts` |
| `AgentContext` | The agent's input, built by code from one business: `agent`, `persona` (`name`: the business override or the global name for the language; the persona always speaks in the feminine, A2), `languages`, `tone`, `profile` (the draft or the full profile) and `missingFields`, `messages` (the last 20 within 14 days: `role` `owner` or `postly`, `text`, `at`, `photos` with their asset id and `image_review` notes), `step`, `openQuestion`, `week` (update text, transcript, recorded facts, declines), `posts` (id, state, plan, current captions and `DesignSpec`, and `photos`: the planned photos with their `image_review` notes), `rules` (active preference rules), `history` (the last 8 topics), `tools` (names allowed now), `doneRule` (text), `budget` (steps and cost left), and `toolResults` (the previous steps' results in this turn). No phone numbers, provider ids or payment data |
| `AgentStep` | The output of every agent task: `calls`, one or more `AgentToolCall`s run in order (no upper limit since 2026-11-07: the turn's `maxToolCalls` bounds them; agent.md, Runtime), and `confidence` (0 to 1). The schema checks shape only (2026-11-07): a `set_profile_field` value is any JSON profile value and the tool checks it against its field; `plan_posts.posts` and a draft design's `photos` have no upper limit and code checks both (agent.md, Tools) |
| `AgentToolCall` | A discriminated union on `tool`: `ask_owner`, `set_profile_field`, `record_fact`, `request_photo`, `record_decline`, `plan_posts`, `create_draft`, `apply_change`, `hand_off_to_console`, `end_turn`; each variant's fields and code checks are in [agent.md](agent.md#tools). `request_photo`'s `purpose` is `logo`, `business`, `week` (the weekly update before any post exists; added 2026-11-06 by WP-93) or `post`, and only `post` carries a `postId` |
| `AgentToolResult` | `ok` with `data` (for example the new fact id or the version id), or `refused` with `reason` and `detail`. Reasons: `not_allowed`, `unknown_id`, `invalid_input`, `quote_not_found`, `value_not_in_quote`, `fact_mismatch`, `forbidden_content`, `plan_invalid`, `badge_invalid`, `edit_out_of_range`, `render_failed`, `no_change`, `window_closed`, `question_limit`, `photo_request_limit`, `skipped` (a call the step did not run, returned so the agent can send it again; 2026-11-07) |
| `DesignSpec` | `photos` (1 for a single post, 2 to 10 for a carousel, the first is the cover), each `assetId`, optional `crop` (`x`, `y`, `w`, `h` in 0..1), `rotateDeg` (-10 to 10, steps of 0.5), `brightness` and `contrast` (-0.3 to 0.3); `title` (1 to 40 characters, at most 2 lines); optional `badge` (`kind`: `discount`, `price`, `new`, `sale`, `holiday`; `text` up to 8 characters for `discount` and `price`, fixed by kind otherwise; `factId` for `discount` and `price`); `carouselLayout` (`standard` or `numbered`) |
| `AgentTurnStopReason` | `done`, `waiting_for_owner`, `end_turn`, `handed_off`, `max_steps`, `max_tool_calls`, `turn_budget`, `daily_budget`, `global_budget`, `timeout`, `stuck`, `low_confidence`, `refusals`, `invalid_output` |

Code checks the schemas cannot express are listed per tool in [agent.md](agent.md#tools). A refused call changes nothing. No tool takes or returns an `InboundMessage`, a button payload, or an approval, so no agent output can reach `ApprovalService`.

`post_version` gains `design_spec` (the `DesignSpec` it was rendered from); the content hash is unchanged (it covers the rendered media). `BusinessProfile` gains an optional `persona` (`agentName`), default empty, which overrides the global name "Postly" / "פוסטלי" in `system_control.agent_name` (agent.md, A1, decided 2026-11-05). There is no gender field: the persona is feminine (A2). `ModelProvider` is unchanged: the agent tasks are ordinary `generateStructured` calls.

## Provider interfaces

Each vendor is reached only through its interface. Requests and responses that cross the boundary are Zod schemas, so a simulator and a real adapter accept and return the same shapes.

### `MessagingProvider`

| Method | Request | Response |
| --- | --- | --- |
| `sendText` | `to`, `text`, optional `mediaUrl` (an image shown with the text) | `providerMessageId` |
| `sendTemplate` | `to`, `templateName`, `language`, `variables` | `providerMessageId` |
| `sendButtons` | `to`, `text`, optional `mediaUrl`, `buttons` (1 to 3, each `id` and `title`) | `providerMessageId` |
| `getMedia` | `providerMediaId` | `mimeType`, `data` |
| `verifyWebhook` | raw request `headers`, `body`, `url` | `InboundMessage[]`, or a rejection when the signature is invalid |

`sendText` with a `mediaUrl` sends the image with the text as its caption (added in WP-30 for the style samples, 2026-11-03, queued for the human): `sendButtons` is the only other way to show an image, and its buttons carry approval payloads only, so onboarding choices are answered by text.

`InboundMessage` has `provider`, `providerMessageId`, `from`, `to`, `receivedAt`, and one `content` of kind `text`, `voice`, `image` (with optional caption), or `button_reply`. Approval buttons use the payload `ApprovalButtonPayload`: `action` (`approve` or `change`), `postId`, `versionId` (the `post_version` row the button was sent for; T15), and `versionHash`. The button `id` sent with `sendButtons` encodes it as `<action>:<postId>:<versionId>:<versionHash>`; `versionId` is optional in the schema, and a payload without it encodes as `<action>:<postId>:<versionHash>` and is checked by hash alone. Every button Postly sends carries `versionId` (`encodeButtonId` / `decodeButtonId` in `src/contracts/providers/messaging.ts`), so a real adapter maps the tapped id back to the payload (WP-32).

WhatsApp accepts free-form messages (`sendText`, `sendButtons`) only within 24 hours of the owner's last inbound message; outside that window only an approved template (`sendTemplate`) goes through. A free-form send outside the window fails with `WindowClosedError`, which carries `to` and `lastInboundAt` (null when the number never wrote). The messaging module checks the window from its `message` rows before calling the provider, and an adapter throws the same error when the vendor reports a closed window. The caller then sends an approved template or waits for the owner (technical-design.md, Failure handling).

### `PublishingProvider`

| Method | Request | Response |
| --- | --- | --- |
| `createConnectionLink` | `businessId`, `networks` | `url`, `expiresAt` |
| `getConnectionStatus` | `businessId`, `network` | `status` (`pending`, `connected`, `disconnected`), `providerAccountId` |
| `testSchedule` | `providerAccountId`, `network` | `ok`, and `error` when not ok. Asks the provider whether a post can be scheduled on the account (the channel test, WP-34). It validates only: nothing is created, scheduled or published |
| `publish` | `idempotencyKey` (the publication id), `providerAccountId`, `network`, `caption`, `mediaUrls`, `format`, `scheduledFor` | `providerPostId` |
| `getPublicationStatus` | `providerPostId` | `status` (`scheduled`, `published`, `failed`), optional `error`, optional `publishedAt` |
| `getMetrics` | `providerAccountId`, `from`, `to` | Per post: `providerPostId`, `reach`, `likes`, `comments`, `shares`; any metric may be missing. The monthly report (WP-43) uses it |
| `disconnectAccount` | `providerAccountId`, `network` | `disconnectedAt`. Removes Postly's access to the account at the provider, so nothing more can be published on it; disconnecting an account that is already gone succeeds. Added 2026-11-04 by WP-43 for cancellation; queued for the human |

### `ModelProvider`

| Method | Request | Response |
| --- | --- | --- |
| `generateStructured` | `task`, `model`, `prompt`, `input`, JSON schema of the output, `temperature` | Raw `output`, `inputTokens`, `outputTokens`, optional `thinkingTokens` (the part of `outputTokens` that is reasoning, for the timing log lines), `costUsd` |
| `analyzeImage` | `task`, `model`, `prompt`, `imageUrl`, JSON schema of the output | Same as `generateStructured` |
| `transcribeAudio` | `model`, `prompt` (the active version of the `transcription` prompt; added 2026-11-05 by T5), `audioUrl`, `languageHint` | `text`, `language`, `costUsd` |

The Google adapter (`src/modules/model-layer/adapters/vertex.ts`) calls Vertex AI `generateContent` with the service account's Application Default Credentials, never an API key. It asks for JSON output against the request's JSON schema, sends photos and voice notes as inline bytes fetched from their URL, uses the request's `prompt` as the instruction for every method (it adds no prompt of its own), validates every request with the Zod schema above (a bad request throws before any call), and computes `costUsd` from the response's token counts and a per-model price table in the adapter, with a global and a non-global price (Vertex prices Gemini 3 and later higher off the `global` endpoint); thinking tokens (`thoughtsTokenCount`) count as output tokens. A model missing from that table is refused. The location is `global`, a multi-region (`eu`, `us`; host `aiplatform.<location>.rep.googleapis.com`) or a single region (`<region>-aiplatform.googleapis.com`). Every request is a single `user` turn and never carries a frequency or presence penalty (Gemini 3.5 Flash-Lite rejects both a last `model` turn and the penalties); for the `agent_*` tasks on a model that takes a thinking level it sends `thinkingConfig.thinkingLevel = "MEDIUM"` (agent.md, [Running on dev](agent.md#running-on-dev)). Its tests run the shared contract suite against a fake transport. **The schema Vertex receives.** Vertex AI takes only a subset of JSON Schema in `responseJsonSchema`, so the adapter sends a trimmed copy and the model layer still validates the output against the full Zod schema: it drops `$schema`, and it drops every `maxItems` at any depth, because Gemini 3.5 Flash-Lite answers any schema containing one with HTTP 400 "Request contains an invalid argument" (found on dev, 2026-11-07: the `agent_onboarding` schema failed until every `maxItems` was removed, while `minItems`, `minimum`/`maximum`, `exclusiveMinimum`, `pattern`, `format` and `propertyNames` were accepted). Only the keyword is dropped, never a property that happens to be named `maxItems`. An over-long array therefore reaches the model layer, fails Zod, and is retried as an invalid output. A unit test runs the trimming over every model task's output schema. **Errors.** When Vertex answers with an error, the adapter's error carries the HTTP status and Vertex's own `error.status`, `error.message` and `error.details` (at most 1000 characters), never the request, so `model_run.error` says why a call failed.

The provider returns raw output. Only the model layer validates it against the task schema. `task` names the model task the request serves (one of the tasks above); a real adapter may ignore it, and the simulator uses it to pick its scripted output and checks that the JSON schema is that task's output schema.

### `PaymentProvider`

| Method | Request | Response |
| --- | --- | --- |
| `createPaymentLink` | `businessId`, `plan`, `price` (`amountAgorot`, a positive integer, and `currency`, `ILS`) | `url`, `providerCustomerId` |
| `getSubscriptionStatus` | `providerSubscriptionId` | `status` (a subscription state), `currentPeriodEnd` |
| `cancelSubscription` | `providerSubscriptionId` | `cancelledAt` |
| `verifyWebhook` (on `PaymentWebhooks`) | `headers`, `body`, `url` (the provider's signed callback) | `PaymentEvent`: `providerEventId`, `businessId`, `providerCustomerId`, `providerSubscriptionId`, `status` (a subscription state), optional `currentPeriodEnd` |

`verifyWebhook` sits on a sibling interface, `PaymentWebhooks`, that every payment adapter implements next to `PaymentProvider`; billing takes both. It is separate so the `PaymentProvider` stubs in the pinned H5 tests stay valid. `verifyWebhook` throws `InvalidWebhookSignatureError` when the signature does not verify. It is how Postly learns the `providerSubscriptionId` after the owner pays, and every later status change (a failed renewal, a recovered payment, a cancellation). `businessId` is the one passed to `createPaymentLink`, echoed back by the provider (a reference or metadata field), so billing finds the subscription inside that business's context without a system role; billing also checks that `providerCustomerId` (and a stored `providerSubscriptionId`) match the row. **The callback is only a trigger:** callbacks can arrive late, twice, in parallel, or out of order, so billing never applies the event's `status`. It locks the subscription row (`select ... for update`), reads the current status with `getSubscriptionStatus`, and applies a transition only when that status differs from the stored one; the owner is told only when the status actually changes. A stale or repeated callback therefore changes nothing and sends nothing. `providerEventId` is for logs and support. Added 2026-11-03 by WP-42, settling the WP-03 gap; queued for the human.

`price` is the plan's current price from `plan_price` (database-schema.md), passed so the provider's page charges it; Postly never hard-codes a price. Added 2026-11-04 by T1 (no trial, ILS 300); queued for the human.

### `TemplateRenderer`

| Method | Request | Response |
| --- | --- | --- |
| `render` | `style`, `format`, `photoUrls`, `overlayText`, optional `logoUrl`, `brandColors`, `networks`; proposed with the agent (2026-11-05, H1): optional `edits` (per photo, in `photoUrls` order: `crop`, `rotateDeg`, `brightness`, `contrast`, as in `DesignSpec`), optional `badge` (`kind`, `text`), optional `carouselLayout` | Per network, a list of files (several for a carousel), each with `storagePath`, `width`, `height`, `mimeType` |

The edits are applied in the order rotate, crop, tone, before the style template; an out-of-range value or a badge that breaks its rules ([agent.md](agent.md#badge-element), and design-styles.md once H2 adds it) is rejected. Without `edits`, `badge` and `carouselLayout` a render is exactly as today.

The business context a render needs but `RenderRequest` does not carry (the business name for the no-logo fallback, the business languages for text direction, the storage prefix, and the `image_review` crops) is bound when the renderer is created: the design module's `forBusiness()` returns a `TemplateRenderer` for one business. A single post with more than one photo is rejected. Decided 2026-11-02 and queued for the human; moving these fields onto `RenderRequest` later is a contract change.

## Approval and publishing

Status: added 2026-11-03 by the H5 test author, queued for the human. The narrow surfaces of the [approval guard and publishing guard](state-machines.md#approval-guard), in `src/contracts/approval.ts`. WP-33 implements `ApprovalService` and WP-34 implements `PublishingJob`; the human-owned tests in `test/h5/` call only these and the test world described there.

| Interface | Method | Request | Response |
| --- | --- | --- | --- |
| `ApprovalService` | `handleApprovalReply` | `businessId`, an `InboundMessage` | `ApprovalDecision`: `approved` with `approvalId`, or `refused` with a reason |
| `PublishingJob` | `runPublication` | `publicationId` | `PublishOutcome` |

Approval refusals: `not_a_button` (free text, voice, or image, whatever it says, and a Change button, which is a button but never an approval; WP-33), `not_approver` (sender is not `business.approver_phone`), `unknown_post` (no such post for this business, including another business's post), `stale_version` (the button's hash is not the current version's hash, or its version id is not the current version's id, so a later version with the same hash never revives an old button; T15), `wrong_state` (the post is not `awaiting_approval`), `handoff` (the conversation is in [handoff](state-machines.md#human-handoff), so no event is applied), `duplicate` (the same inbound message, by provider message id, was already handled; `approval.message_id` is unique). A refusal changes nothing. `handleApprovalReply` takes only an `InboundMessage`, so no model output can reach it as an approval.

Publish outcomes: `published` and `already_published` (the provider status check found the post live, so `publish` was not called again) carry `providerPostId`; `retry_pending` and `failed` carry the error; `deferred` (`global_pause`, `business_pause`, `handoff`) and `refused` (`not_approved`, `not_current_version`, `cross_business`, `wrong_state`; checked in the order of the [publishing guard](state-machines.md#publishing-guard)) change nothing and reach no provider.
