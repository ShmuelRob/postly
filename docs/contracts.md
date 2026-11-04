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

What the agent is waiting for, stored in `conversation_state.open_question` (added in WP-30, queued for the human): `key` (which question of the step), `askedFields` (profile fields the question asks for; may be empty), `attempts` (how many times it was asked), `photoAssetIds` (business photos the owner sent during onboarding, not part of the profile), and an optional `postId` (the post a drafts question is about: `photo_choice` or `change_request`; added 2026-11-03 by WP-32, queued for the human), and optional `proposals` (the `schedule_confirmation` question: each proposed post's `postId` and time `at`; added 2026-11-04 by WP-34, queued for the human). The schema is in `src/contracts/open-question.ts`.

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
| `image_review` | Media asset id, purpose (post photo or logo) | `usable`, `score` (0 to 1), `issues`, and an optional normalized `crop` |
| `fact_check` | Caption text and the facts it may use | `mismatches`: each with the caption text and the issue |

Fact types are `price`, `discount_percent`, `date`, `date_range`, `time`, `address`, `phone`, `product`, `promotion`, `testimonial`, and `other`.

Code checks that the schema cannot express:

- `fact_extraction`: every `sourceQuote` appears verbatim in the source text or transcript (whitespace runs count as one space), and the quote of a `testimonial` fact appears in the typed text the owner sent.
- `weekly_planning`: the number of posts equals `postsPerWeek`, every `factIds` entry exists, and every format is allowed by the profile.
- A failed code check counts as a failed attempt: the model layer takes the check as `RunOptions.check`, retries, and then routes to the console, as for a schema failure.
- `caption_writing`: every price, discount, date, time, address, and phone number in a caption matches a fact in `usedFactIds` or the profile. This code comparison is the fact check; the `fact_check` model task is optional and only adds mismatches. The exact rules are in technical-design.md, Drafts flow.

What a `post_version` stores (WP-32): `captions` is `ChannelCaptions`; `rendered_media` (`RenderedMedia`) maps each network to its rendered `media_asset` ids in slide order; `fact_sources` (`FactSource[]`) is the used facts, each `factId`, `type`, `value`, and `sourceQuote`; `content_hash` is the SHA-256 of the canonical JSON of `{ format, captions, renderedMedia }`. The schemas are in `src/contracts/post-version.ts`.

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

`InboundMessage` has `provider`, `providerMessageId`, `from`, `to`, `receivedAt`, and one `content` of kind `text`, `voice`, `image` (with optional caption), or `button_reply`. Approval buttons use the payload `ApprovalButtonPayload`: `action` (`approve` or `change`), `postId`, and `versionHash`. The button `id` sent with `sendButtons` encodes it as `<action>:<postId>:<versionHash>` (`encodeButtonId` / `decodeButtonId` in `src/contracts/providers/messaging.ts`), so a real adapter maps the tapped id back to the payload (WP-32).

WhatsApp accepts free-form messages (`sendText`, `sendButtons`) only within 24 hours of the owner's last inbound message; outside that window only an approved template (`sendTemplate`) goes through. A free-form send outside the window fails with `WindowClosedError`, which carries `to` and `lastInboundAt` (null when the number never wrote). The messaging module checks the window from its `message` rows before calling the provider, and an adapter throws the same error when the vendor reports a closed window. The caller then sends an approved template or waits for the owner (technical-design.md, Failure handling).

### `PublishingProvider`

| Method | Request | Response |
| --- | --- | --- |
| `createConnectionLink` | `businessId`, `networks` | `url`, `expiresAt` |
| `getConnectionStatus` | `businessId`, `network` | `status` (`pending`, `connected`, `disconnected`), `providerAccountId` |
| `testSchedule` | `providerAccountId`, `network` | `ok`, and `error` when not ok. Asks the provider whether a post can be scheduled on the account (the channel test, WP-34). It validates only: nothing is created, scheduled or published |
| `publish` | `idempotencyKey` (the publication id), `providerAccountId`, `network`, `caption`, `mediaUrls`, `format`, `scheduledFor` | `providerPostId` |
| `getPublicationStatus` | `providerPostId` | `status` (`scheduled`, `published`, `failed`), optional `error`, optional `publishedAt` |
| `getMetrics` | `providerAccountId`, `from`, `to` | Per post: `providerPostId`, `reach`, `likes`, `comments`, `shares`; any metric may be missing |

### `ModelProvider`

| Method | Request | Response |
| --- | --- | --- |
| `generateStructured` | `task`, `model`, `prompt`, `input`, JSON schema of the output, `temperature` | Raw `output`, `inputTokens`, `outputTokens`, `costUsd` |
| `analyzeImage` | `task`, `model`, `prompt`, `imageUrl`, JSON schema of the output | Same as `generateStructured` |
| `transcribeAudio` | `model`, `audioUrl`, `languageHint` | `text`, `language`, `costUsd` |

The provider returns raw output. Only the model layer validates it against the task schema. `task` names the model task the request serves (one of the tasks above); a real adapter may ignore it, and the simulator uses it to pick its scripted output and checks that the JSON schema is that task's output schema.

### `PaymentProvider`

| Method | Request | Response |
| --- | --- | --- |
| `createPaymentLink` | `businessId`, `plan` | `url`, `providerCustomerId` |
| `getSubscriptionStatus` | `providerSubscriptionId` | `status` (a subscription state), `currentPeriodEnd` |
| `cancelSubscription` | `providerSubscriptionId` | `cancelledAt` |
| `verifyWebhook` (on `PaymentWebhooks`) | `headers`, `body`, `url` (the provider's signed callback) | `PaymentEvent`: `providerEventId`, `businessId`, `providerCustomerId`, `providerSubscriptionId`, `status` (a subscription state), optional `currentPeriodEnd` |

`verifyWebhook` sits on a sibling interface, `PaymentWebhooks`, that every payment adapter implements next to `PaymentProvider`; billing takes both. It is separate so the `PaymentProvider` stubs in the pinned H5 tests stay valid. `verifyWebhook` throws `InvalidWebhookSignatureError` when the signature does not verify. It is how Postly learns the `providerSubscriptionId` after the owner pays, and every later status change (a failed renewal, a recovered payment, a cancellation). `businessId` is the one passed to `createPaymentLink`, echoed back by the provider (a reference or metadata field), so billing finds the subscription inside that business's context without a system role; billing also checks that `providerCustomerId` (and a stored `providerSubscriptionId`) match the row. **The callback is only a trigger:** callbacks can arrive late, twice, in parallel, or out of order, so billing never applies the event's `status`. It locks the subscription row (`select ... for update`), reads the current status with `getSubscriptionStatus`, and applies a transition only when that status differs from the stored one; the owner is told only when the status actually changes. A stale or repeated callback therefore changes nothing and sends nothing. `providerEventId` is for logs and support. Added 2026-11-03 by WP-42, settling the WP-03 gap; queued for the human.

### `TemplateRenderer`

| Method | Request | Response |
| --- | --- | --- |
| `render` | `style`, `format`, `photoUrls`, `overlayText`, optional `logoUrl`, `brandColors`, `networks` | Per network, a list of files (several for a carousel), each with `storagePath`, `width`, `height`, `mimeType` |

The business context a render needs but `RenderRequest` does not carry (the business name for the no-logo fallback, the business languages for text direction, the storage prefix, and the `image_review` crops) is bound when the renderer is created: the design module's `forBusiness()` returns a `TemplateRenderer` for one business. A single post with more than one photo is rejected. Decided 2026-11-02 and queued for the human; moving these fields onto `RenderRequest` later is a contract change.

## Approval and publishing

Status: added 2026-11-03 by the H5 test author, queued for the human. The narrow surfaces of the [approval guard and publishing guard](state-machines.md#approval-guard), in `src/contracts/approval.ts`. WP-33 implements `ApprovalService` and WP-34 implements `PublishingJob`; the human-owned tests in `test/h5/` call only these and the test world described there.

| Interface | Method | Request | Response |
| --- | --- | --- | --- |
| `ApprovalService` | `handleApprovalReply` | `businessId`, an `InboundMessage` | `ApprovalDecision`: `approved` with `approvalId`, or `refused` with a reason |
| `PublishingJob` | `runPublication` | `publicationId` | `PublishOutcome` |

Approval refusals: `not_a_button` (free text, voice, or image, whatever it says, and a Change button, which is a button but never an approval; WP-33), `not_approver` (sender is not `business.approver_phone`), `unknown_post` (no such post for this business, including another business's post), `stale_version` (the button's hash is not the current version's hash), `wrong_state` (the post is not `awaiting_approval`), `handoff` (the conversation is in [handoff](state-machines.md#human-handoff), so no event is applied), `duplicate` (the same inbound message, by provider message id, was already handled; `approval.message_id` is unique). A refusal changes nothing. `handleApprovalReply` takes only an `InboundMessage`, so no model output can reach it as an approval.

Publish outcomes: `published` and `already_published` (the provider status check found the post live, so `publish` was not called again) carry `providerPostId`; `retry_pending` and `failed` carry the error; `deferred` (`global_pause`, `business_pause`, `handoff`) and `refused` (`not_approved`, `not_current_version`, `cross_business`, `wrong_state`; checked in the order of the [publishing guard](state-machines.md#publishing-guard)) change nothing and reach no provider.
