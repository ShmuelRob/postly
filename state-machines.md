# Postly State Machines

Status: draft contract, pending human approval.

Every business, conversation, post, and external connection in Postly moves through a deterministic state machine defined in code. Models never change state directly: a model output becomes an event only after code validates it. This document is the source of truth for states, events, and guards; the code in `src/contracts/state-machines/` implements it one to one.

## Conventions

- Each machine is a transition table: `(state, event) -> next state`. Any pair not listed is invalid and is rejected with an error, never silently ignored.
- Guards are code checks that must pass before a transition is applied. They are listed per transition and live in the owning module, not in the table.
- Terminal states have no outgoing transitions.
- State names are the values stored in the database enum of the same machine.
- Pauses do not change post or publication state. A global pause or a paused business makes the publishing job defer work, and the job re-checks the pause flags right before calling the provider.

## Business

Stored in `business.status`.

| From | Event | To | Guard |
| --- | --- | --- | --- |
| `onboarding` | `ONBOARDING_COMPLETED` | `active` | Profile complete and approved; at least one channel connection is `verified` |
| `active` | `PAUSE` | `paused` | Team action from the console |
| `paused` | `RESUME` | `active` | At least one channel connection is `verified` |
| `onboarding` | `CANCEL` | `cancelled` | |
| `active` | `CANCEL` | `cancelled` | |
| `paused` | `CANCEL` | `cancelled` | |

`cancelled` is terminal. On cancellation, channels are disconnected immediately and data deletion is scheduled after the retention period.

## Onboarding

Stored in `conversation_state.step` while the business is `onboarding`. The steps follow the PRD onboarding order.

| From | Event | To | Guard |
| --- | --- | --- | --- |
| `intro` | `INTRO_SENT` | `profile_questions` | |
| `profile_questions` | `PROFILE_FIELDS_COMPLETE` | `brand_assets` | All required profile fields are filled |
| `brand_assets` | `BRAND_ASSETS_DONE` | `style_selection` | Owner sent assets or skipped them |
| `style_selection` | `STYLE_CHOSEN` | `profile_review` | Chosen style is one of the three styles |
| `profile_review` | `PROFILE_CORRECTED` | `profile_review` | Summary is resent after the correction |
| `profile_review` | `PROFILE_APPROVED` | `channel_connection` | Approval comes from the approver number |
| `channel_connection` | `CHANNEL_CONNECTED` | `channel_test` | At least one connection is `connected` |
| `channel_test` | `CHANNEL_TEST_FAILED` | `channel_connection` | |
| `channel_test` | `CHANNEL_TEST_PASSED` | `completed` | Every chosen channel is `verified` |

`completed` is terminal and triggers `ONBOARDING_COMPLETED` on the business.

## Human handoff

Handoff is a flag, not a state: `conversation_state.handoff_at` is set when the agent gets stuck or the owner asks for a person, and cleared by the team from the console. While it is set, the agent sends no automatic replies and applies no events from inbound messages; messages are still stored for the console. Clearing the flag resumes the onboarding or conversation step that was current, so no step is lost.

## Conversation

Stored in `conversation_state.step` once the business is `active` or `paused`. It tracks what the agent is waiting for from the owner. The open question, if any, is stored in `conversation_state.open_question`.

| From | Event | To | Guard |
| --- | --- | --- | --- |
| `idle` | `UPDATE_RECEIVED` | `processing_update` | Message is from the approver number |
| `processing_update` | `QUESTION_ASKED` | `awaiting_answer` | Exactly one focused question is open |
| `awaiting_answer` | `ANSWER_RECEIVED` | `processing_update` | |
| `processing_update` | `DRAFTS_SENT` | `reviewing_drafts` | Every sent draft passed the fact check |
| `reviewing_drafts` | `CHANGE_REQUESTED` | `processing_update` | |
| `reviewing_drafts` | `ALL_DRAFTS_RESOLVED` | `confirming_schedule` | Every post in the update is `approved` or `cancelled` |
| `confirming_schedule` | `SCHEDULE_CHANGE_REQUESTED` | `confirming_schedule` | New times are proposed |
| `confirming_schedule` | `SCHEDULE_CONFIRMED` | `idle` | Publications are created for every approved post |
| `confirming_schedule` | `CHANGE_REQUESTED` | `processing_update` | |

A new weekly update while drafts are open is treated as a change request on the open drafts. Free text such as "sounds good" while in `reviewing_drafts` is not an event: the agent resends the drafts with buttons and the state stays the same.

## Weekly update

Stored in `weekly_update.status`. A row is created at the start of each business week, before any message arrives.

| From | Event | To | Guard |
| --- | --- | --- | --- |
| `awaiting` | `REMINDER_SENT` | `reminded` | Sent with an approved template |
| `awaiting` | `UPDATE_RECEIVED` | `received` | |
| `reminded` | `UPDATE_RECEIVED` | `received` | |
| `reminded` | `WEEK_ENDED` | `skipped` | No update arrived |
| `received` | `FACTS_EXTRACTED` | `planned` | Extraction output passed schema validation |
| `received` | `EXTRACTION_FAILED` | `needs_review` | Retries are exhausted |
| `needs_review` | `FACTS_EXTRACTED` | `planned` | Team action from the console |

`planned` and `skipped` are terminal. A week with `skipped` publishes no content.

## Post

Stored in `post.status`. This is the machine that protects the approval rule.

| From | Event | To | Guard |
| --- | --- | --- | --- |
| `planned` | `DRAFT_STARTED` | `drafting` | |
| `drafting` | `DETAIL_MISSING` | `awaiting_clarification` | One question is sent to the owner |
| `awaiting_clarification` | `DETAIL_PROVIDED` | `drafting` | |
| `drafting` | `DRAFT_READY` | `awaiting_approval` | New `post_version` exists and passed the fact check; draft was sent with buttons |
| `drafting` | `DRAFT_FAILED` | `needs_review` | Model validation or fact check retries are exhausted |
| `needs_review` | `DRAFT_STARTED` | `drafting` | Team action from the console |
| `awaiting_approval` | `APPROVED` | `approved` | See approval guard |
| `awaiting_approval` | `CHANGE_REQUESTED` | `drafting` | |
| `approved` | `CHANGE_REQUESTED` | `drafting` | Existing approval is invalidated |
| `approved` | `SCHEDULED` | `scheduled` | Owner confirmed the times; one publication per connected channel exists |
| `scheduled` | `CHANGE_REQUESTED` | `drafting` | Approval is invalidated; pending publications are cancelled |
| `scheduled` | `PUBLISHING_STARTED` | `publishing` | First publication started |
| `publishing` | `ALL_PUBLISHED` | `published` | Every publication is `published` |
| `publishing` | `PARTIALLY_PUBLISHED` | `partially_published` | At least one `published` and at least one `failed` |
| `publishing` | `ALL_FAILED` | `failed` | Every publication is `failed` |
| `partially_published` | `ALL_PUBLISHED` | `published` | A retried publication succeeded from the console |
| `failed` | `PUBLISHING_STARTED` | `publishing` | Team retry from the console |
| any of `planned`, `drafting`, `awaiting_clarification`, `awaiting_approval`, `approved`, `scheduled`, `needs_review` | `CANCELLED` | `cancelled` | |

`published` and `cancelled` are terminal.

### Approval guard

`APPROVED` is accepted only when all of these hold:

1. The event comes from a WhatsApp button tap, never from free text or a model output.
2. The sender phone equals `business.approver_phone`.
3. The button payload carries the content hash of a `post_version`, and that hash equals the hash of `post.current_version_id`.
4. The post is in `awaiting_approval`.

Any new `post_version` invalidates earlier approvals (`approval.invalidated_at` is set). A request to publish on only one channel is a change request.

### Publishing guard

The publishing job publishes a publication only when its `approved_version_hash` equals the hash of an approval that is not invalidated, that approval belongs to the post's current version, and neither the global pause nor a business pause is active.

## Publication

Stored in `publication.status`. One row per post per channel.

| From | Event | To | Guard |
| --- | --- | --- | --- |
| `scheduled` | `STARTED` | `in_progress` | Publishing guard passes |
| `in_progress` | `SUCCEEDED` | `published` | Provider returned a post identifier |
| `in_progress` | `ATTEMPT_FAILED` | `retry_pending` | Attempts are below the retry limit |
| `in_progress` | `ATTEMPTS_EXHAUSTED` | `failed` | Owner and team are notified with the failed channel |
| `retry_pending` | `STARTED` | `in_progress` | Publishing guard passes |
| `failed` | `RETRY_REQUESTED` | `retry_pending` | Team action from the console |
| `scheduled` | `CANCELLED` | `cancelled` | |
| `retry_pending` | `CANCELLED` | `cancelled` | |

`published` and `cancelled` are terminal. Before each retry the job checks the provider status, so a post that went live is not published twice.

## Channel connection

Stored in `channel_connection.status`.

| From | Event | To | Guard |
| --- | --- | --- | --- |
| `pending` | `CONNECTED` | `connected` | Provider reports the account is linked |
| `connected` | `TEST_PASSED` | `verified` | A test schedule succeeded on this channel |
| `connected` | `TEST_FAILED` | `pending` | A new connection link is sent |
| `verified` | `HEALTH_CHECK_FAILED` | `disconnected` | Owner is notified with a template |
| `disconnected` | `RECONNECT_REQUESTED` | `pending` | A new connection link is sent |
| any state except `revoked` | `REVOKED` | `revoked` | Business cancelled or owner removed the channel |

`revoked` is terminal.

## Subscription

Stored in `subscription.status`. The payment provider is a placeholder in Phase 1, so these states come from the internal `PaymentProvider` interface.

| From | Event | To | Guard |
| --- | --- | --- | --- |
| `trialing` | `PAYMENT_SUCCEEDED` | `active` | |
| `trialing` | `TRIAL_ENDED` | `past_due` | No successful payment |
| `active` | `PAYMENT_FAILED` | `past_due` | |
| `past_due` | `PAYMENT_SUCCEEDED` | `active` | |
| `trialing` | `CANCELLED` | `cancelled` | |
| `active` | `CANCELLED` | `cancelled` | |
| `past_due` | `CANCELLED` | `cancelled` | |

`cancelled` is terminal. What a `past_due` subscription blocks is an open question, together with the trial length.
