# Postly Agent

Status: design (2026-11-05). The human decided A1 to A10 on 2026-11-05; the contracts stay queued under H1 and every prompt under H7. No code yet; the work packages are WP-89 to WP-97 in [implementation-plan.md](implementation-plan.md#phase-7-the-agent).

Postly's onboarding, weekly data gathering and post creation move from fixed one-shot model tasks to a **hybrid agent**: an LLM agent gathers the data, asks follow-up questions and creates the posts, and it acts only through tool calls that code checks. Code still owns every state machine, every message that leaves Postly, the fact check, approval, scheduling, rendering and publishing. This document is the source of truth for the agent; [technical-design.md](technical-design.md), [state-machines.md](state-machines.md) and [contracts.md](contracts.md) point here.

## Decisions

Decided by the human on 2026-11-05. The budget values (A4) and the model (A8) are configuration, so they change without a code change.

| # | Question | Decision (2026-11-05) |
| --- | --- | --- |
| A1 | **Persona name** | One global name: "Postly" in English, "פוסטלי" in Hebrew, stored in `system_control.agent_name` (per language; default `{"en": "Postly", "he": "פוסטלי"}`). An optional per-business override `persona.agentName` in the profile is kept. The name appears in the intro, the weekly reminder and greetings, never in a post |
| A2 | **Gender and voice of the persona** | The persona speaks as a woman: feminine grammatical gender in Hebrew everywhere, in the agent's own voice ("אני מכינה", "שלחתי לך") and in every fixed line of copy that speaks as the agent. There is no first-person-plural fallback. The owner is still addressed by the profile's `tone.address` |
| A3 | **Time proposals with buttons** | No buttons: the text confirmation of WP-34 stays (buttons carry approval payloads only) |
| A4 | **Budgets** | Twice the first proposal, accepted as roughly right for now: 12 steps and 24 tool calls a turn, USD 0.06 a turn, USD 1.00 a business a day, USD 50 across all businesses a day, 90 seconds a turn ([Limits](#limits)). Configuration values in `agent_config` and `system_control` |
| A5 | **The weekly greeting** | The existing Monday 10:00 reminder (`weekly_reminder` template), reworded in the persona's voice (H6); no extra greeting |
| A6 | **Badge and sticker set** | `discount`, `price`, `new`, `sale`, `holiday`; the last three are fixed words per language ([Badge](#badge-element)) |
| A7 | **Profile edits after onboarding** | The agent may call `set_profile_field` on an active business; code sends the owner a confirmation of the exact change; the approver number can't be changed |
| A8 | **Model per agent** | Gemini **3.5 Flash-Lite** (`gemini-3.5-flash-lite`) for all three agent tasks, set in `model_task_config`, with thinking at `MEDIUM`. Was `gemini-2.5-flash-lite` until Vertex retired it on 2026-10-20; moved on 2026-11-06 (`drizzle/0023_gemini_3_5_flash_lite.sql`, [Running on dev](#running-on-dev)) |
| A9 | **Retiring the one-shot tasks** | `profile_extraction`, `fact_extraction`, `weekly_planning`, `caption_writing` and `change_interpretation` are no longer reachable in any deployed environment: since 2026-11-06 the agents always run, with no `agent_flows` switch ([Running on dev](#running-on-dev)). The one-shot code stays only for the tests and the local playground that drive it (`oneShotFlows`), until a cleanup package removes it with those tests |
| A10 | **Conversation history the model sees** | The last 20 messages of the conversation within 14 days, plus the current week's update; older context only through the profile, the preference rules and the post history summary |

**Follow-up (A8, A10).** If 3.5 Flash-Lite proves too weak in the manual eval (WP-96) or in dev use, revisit the history size, the model, or both; the trigger and the comparison to run are in [implementation-plan.md](implementation-plan.md#phase-7-the-agent) (WP-97).

## What changes and what does not

| Area | Before | With the agent |
| --- | --- | --- |
| Onboarding questions | A fixed question order; `profile_extraction` per answer | The onboarding agent asks in its own words, follows up on vague answers, and fills fields through `set_profile_field` |
| Weekly update | `fact_extraction`, then `weekly_planning`, once | The weekly agent records facts one by one (`record_fact`), asks about missing details (when does the promotion end?), asks for a photo when there is none, and plans (`plan_posts`) |
| Drafts | `caption_writing`; the overlay text is the plan topic; no photo edits | The drafts agent writes captions, hashtags, the title, an optional badge, photo edits and the carousel order (`create_draft`), and applies fixes (`apply_change`) |
| Messages to the owner | Fixed copy per step | The agent proposes the wording (`ask_owner`, `request_photo`); code decides whether, when and how it is sent |
| State machines | Code | Code. The agent never applies an event; code decides when a step is done |
| Fact check, approval, scheduling, rendering, publishing, templates, the 24-hour window | Code | Code, unchanged |

What the agent never does:

- send a WhatsApp message or a template itself, or choose when one is sent;
- approve anything, propose or confirm times, schedule, render, or publish;
- read or write another business's data, or see secrets, tokens, phone numbers other than the profile's contact details, or payment data;
- generate or alter image content beyond the [fixed photo operations](#photo-edits);
- change the approver number, the business status, a channel connection, the subscription, or a post's state.

## Agents

Three agents share one runtime and one tool framework. Each is a model task with its own versioned prompt (H7), its own allowed tools, and its own "done" rule evaluated by code.

| Agent | Model task | Runs while | Allowed tools | Done when (code decides) |
| --- | --- | --- | --- | --- |
| Onboarding | `agent_onboarding` | Onboarding steps `profile_questions` and `brand_assets`, and corrections in `profile_review` | `ask_owner`, `set_profile_field`, `request_photo`, `record_decline`, `hand_off_to_console`, `end_turn` | `profile_questions`: `missingRequiredProfileFields` is empty (except `style`) and the agent has asked the closing question "anything else customers should know?" once, or the owner declined. `brand_assets`: the logo request and the business-photo request are each answered by an image or a recorded decline |
| Weekly update | `agent_weekly` | Conversation `processing_update` and `awaiting_answer`, week `received` | `ask_owner`, `record_fact`, `request_photo`, `record_decline`, `plan_posts`, `set_profile_field` (A7), `hand_off_to_console`, `end_turn` | A plan passed the [plan checks](#tools); every fact a planned post depends on is recorded or declined. Code then applies `FACTS_EXTRACTED` |
| Drafts | `agent_drafts` | Posts `drafting`; conversation `processing_update`, both after the plan and after a change (see [Fixes](#how-it-fits-the-state-machines)) | `create_draft`, `apply_change`, `ask_owner`, `request_photo`, `plan_posts` (revise only), `record_decline`, `hand_off_to_console`, `end_turn` | Every post of the week is `awaiting_approval`, `awaiting_clarification` or `needs_review`; code then applies `DRAFTS_SENT` |

Steps that stay code-only and agent-free: the intro message, the style samples and the owner's style choice (code reads a style name or number, as today), the profile summary and its approval, channel connection and its test, activation and the payment link, intent routing (`intent_detection` decides which flow takes an idle message), approval, time proposals and confirmation, the reminder and every template.

## Runtime

### A turn

A **turn** is one run of one agent for one business, triggered by a claimed inbound burst routed to that agent by the conversation step, or by a code event (the plan was stored, so drafting starts; a detail was provided; the team cleared a handoff).

1. **Lock.** The turn takes the business's `conversation_state` row (`for update` in a short transaction that inserts the turn's `agent_turn` row as `running`), so at most one turn runs per business: a second trigger that finds a `running` turn younger than twice the turn timeout runs nothing (the burst stays unprocessed and the sweep hands it over again). An older `running` turn is a crashed one; it is closed as `failed` and the new turn starts.
2. **Context.** Code builds the agent's input from this business only ([Context](#context)).
3. **Step.** The model layer runs the agent's task. Its output is an `AgentStep`: one to four tool calls and a `confidence` (0 to 1). The output is Zod-validated like every model task; an invalid output retries within `model_task_config.max_retries` and then routes to the console.
4. **Execute.** Code runs the step's tool calls in order. Each call is checked (allowed for this agent and state, input schema, the tool's code checks) and then applied through the module that owns the data, in that module's transaction and role. A refused call stops the step: the later calls in it are skipped, and the refusal reason goes back to the agent.
5. **Decide.** After each step code evaluates the agent's "done" rule and applies the state machine event when it holds. The turn ends when the agent is done, when a call that waits for the owner (`ask_owner` expecting an answer, `request_photo`) was sent, on `end_turn`, on `hand_off_to_console`, or at a limit.
6. **Loop.** Otherwise the tool results are appended to the context and the next step runs.
7. **Record.** The `agent_turn` row gets the stop reason, the steps (tool calls and results), the total cost and duration; every model call of the turn is a `model_run` with the turn's id.

**No silent turn (2026-11-07).** On dev on 2026-11-06 an owner's last message got no reply: the onboarding turn ended with `end_turn` and sent nothing, the runtime did not evaluate the done rule after `end_turn` (although [end_turn](#end_turn) says it does), and the onboarding flow acts only on `done`. So: after `end_turn` code evaluates the done rule, and the turn ends `done` when it holds. And a flow whose owner waits on a turn, with no code reply after it unless it ends done, runs the turn with `mustReply` (onboarding `profile_questions` and `brand_assets`, the turn after the intro, and the weekly agent): such a turn that ends with `end_turn`, not done, with no message sent by its tools, hands off like a limit (the fixed line, the handoff flag, an `agent_limit` console item with reason `silent_turn`, and the log line `agent turn ended silent`). Flows that reply in code after any turn (profile corrections, the drafts agent) do not pass it. When a turn fails before its context is read, the hand-off line goes to the approver's number read from the business. `TurnResult.messagesSent` counts the messages the turn's tools sent.

A crash mid-turn leaves the turn `running`; the burst it came from is still unprocessed (its claim is a lease), so the sweep re-runs it as a new turn. Each tool call's effect is its own transaction and is recorded in the turn's `steps` right after it runs, so a re-run sees what the crashed turn already did (its recorded calls are in the context's history). A crash between a send and its record can repeat that one message once; WP-90 accepts this (messaging has no idempotency key for free-form sends) and the console shows both turns.

**Where the agent's own memory lives.** Declines (`record_decline`) and the questions already asked (for the repeated-question limit) are read from the business's earlier `agent_turn` rows: the successful `record_decline` and `ask_owner` calls of the current onboarding, or of the current business week once the business is active. No other table stores them.

**Roles (WP-90).** The agent module runs as the existing `workflow` role, which already reads the context tables and writes `conversation_state` and console items; it gains `agent_turn` and read access to `agent_config` and `system_control`. No new database login is created, so no new secret, Terraform change or connection pool is needed (security.md, D7 and D9). Spend is read by the model layer: a business's spend as the `model` role, and the all-business spend as the `scheduler` system role, which gains read access to `model_run`.

### Limits

All limits are configuration values (`agent_config`, a system table, one row per agent, and `system_control` for the global cap), decided by the human on 2026-11-05 (A4). Hitting any of them ends the turn and hands off.

| Limit | Default | When hit |
| --- | --- | --- |
| Steps per turn | 12 | Hand off: `agent_limit` console item, reason `max_steps` |
| Tool calls per turn | 24 | Same, reason `max_tool_calls` |
| Cost per step | `model_task_config.max_cost_usd`, USD 0.02 for the agent tasks | Counts every attempt of the step, retries included: the model layer starts a retry only when the step's spend so far plus the last attempt's cost stays within the cap, and otherwise fails the step (the step then hands off, reason `invalid_output`). Retries never get a cap of their own |
| Cost per turn | USD 0.06 | Same, reason `turn_budget`. A step starts only when the turn's remaining budget is at least the step's cap, so three full steps fit a turn and a fourth does not start. With the retry rule above each step stays within its cap, and the caps of the steps that started fit the budget, so a turn stays within its budget (an attempt that costs more than the one before it can still overshoot by that difference) |
| Cost per business per day | USD 1.00 | Same, reason `daily_budget`; summed from `model_run.cost_usd` of every task (not only the agents') since local midnight in `business.timezone`, checked before each step against the step's cap. A business over its daily budget gets no agent turn until the next day; its messages are kept for the console |
| Cost across all businesses per day | USD 50 (`system_control.agent_daily_cost_cap_usd`) | Every agent turn hands off (reason `global_budget`) and the team gets an alert (the log line `agent global budget reached`, one per stopped turn, and its alert in docs/observability.md); the old one-shot path is not a fallback for cost. Summed from `model_run.cost_usd` of every business since 00:00 UTC, checked before each step |
| Turn duration | 90 seconds | The turn stops after the current tool call, reason `timeout`. A model call is bounded by the time the turn has left: one that hangs past it ends the turn, its late answer is dropped (no tool of it runs), and the turn row closes, so the business's next turn is not blocked |
| Repeated question | The same `ask_owner.topic` 3 times in a week or an onboarding step | Hand off, reason `stuck` (the existing three-attempt rule) |
| Low confidence | `confidence` below 0.4 on a step | The step's calls are not run; hand off, reason `low_confidence` |
| Refused tool calls | 3 refusals in one turn | Hand off, reason `refusals` |

A hand-off from a limit always sends the owner one fixed code line in the business's first language (H6: a person will continue shortly), sets the handoff flag, and opens one console item with the turn id. The console shows the turn's steps.

### Module direction

The workflow module routes a burst or a code event to the agent module (`agent.runTurn(businessId, trigger)`); the agent module never imports workflow. The state machine events a tool needs (for example `DRAFT_READY` inside `create_draft`) reach the tools as callbacks injected when the app is wired (`createAgent({ events, messaging, content, design, ... })`), the same way flows get their providers today. So the dependency runs workflow → agent only, and dependency-cruiser keeps it that way.

**Implementation note (WP-93, 2026-11-06).** Until WP-92, WP-93 and WP-94 have all landed, each flow creates its own agent instance in its workflow file (`workflow/weekly.ts` for the weekly agent) with the events its tools need, and a package adds an event to `AgentEvents` by a module augmentation in its own tool file (`planStored` in `tools/plan.ts`). The turn lock is in the database, so several instances are safe. Once the three packages are in, one `createAgent` in `app.ts` with every event replaces the per-flow instances (a cleanup the manager schedules).

### Context

The agent sees only what its task needs, all from one business (`withBusiness`):

- the profile (or the onboarding draft) and the fields still missing;
- the persona (A1, A2), the business languages and tone;
- the last 20 messages of the conversation within 14 days (A10), with the owner's text and transcripts verbatim, and photos as asset ids with their `image_review` notes ([Photos the agent sees](#photos-the-agent-sees));
- the current step, the open question, the current week's update and its recorded facts and declines;
- the week's posts, each with its plan, state, and current version (captions, design spec);
- the active preference rules and a short post history (the last 8 topics);
- the tool list for this agent and state, the done rule in words, and the remaining step and cost budget.

It never sees phone numbers (the approver's number is replaced by "the owner"), other businesses, tokens, provider ids, or payment data.

**Added by WP-94 (2026-11-06).** The context builder now carries the active preference rules, each post's current captions and `DesignSpec` (from its current version) and, for every photo in the messages and in the week's posts, the `image_review` notes (`description`, `usable`, and a suggested `crop`, `rotateDeg`, `brightness`, `contrast`). The notes live in `media_asset.review`, written once by the workflow when drafting starts (code calls `image_review` for each planned photo that has none; a failed review only means the agent drafts without notes). The `workflow` role gained `SELECT` on `preference_rule`, `post_version` and `media_asset`, and `UPDATE (review)` on `media_asset` (H4, migration 0022). `ContextPost.photos` (the post's planned photos with their notes) is the one contract addition (H1).

### Photos the agent sees

The agent's model call is text only. Every photo the owner sends is reviewed once, when it arrives, by `image_review` (a bounded vision task), whose output gains a short `description`, a suggested `crop`, a suggested `rotateDeg`, and suggested `brightness` and `contrast`. The agent reads those notes and chooses the edits; code clamps them to the allowed ranges. This keeps every agent step cheap and the vision call bounded.

## Tools

Every tool call is one variant of the `AgentToolCall` discriminated union on `tool` ([contracts.md](contracts.md#agent)). The result is an `AgentToolResult`: `ok` with a small `data` object, or `refused` with a `reason` code and a one-line `detail` the agent reads. A refusal changes nothing.

Common rules for every tool:

- The tool must be allowed for the running agent and the current state; otherwise `not_allowed`.
- Ids (`postId`, `mediaAssetId`, `factId`) must belong to this business and to the current week where the tool says so; otherwise `unknown_id`.
- Text meant for the owner or for a post is checked by the [fact check](technical-design.md#drafts-flow): every price, discount, date, time, weekday and phone in it must match its source; otherwise `fact_mismatch` with the offending detail.
- Text is also checked against `forbiddenTopics` and the competitor rule by a code word list (`forbidden_content`) and must be in one of the business's languages.

### `ask_owner`

Proposes one message to the owner.

| Field | Rule |
| --- | --- |
| `text` | 1 to 600 characters, at most one question mark sentence (one focused question); no URL, no phone except the profile's, no button-like markers |
| `topic` | Code word for what is asked (`profile:<field>`, `detail:<factType>`, `photo_choice`, `clarify_change`, `anything_else`, `info`), used for the repeated-question limit |
| `expects` | `answer` (the turn ends and the conversation waits) or `none` (an acknowledgement; the turn may go on) |
| `fields` | Profile fields the question asks for (onboarding), optional |

Code decides: the message is sent with `sendText` only when the 24-hour window is open; a closed window refuses with `window_closed` (the agent then ends the turn; in the weekly flow the existing `drafts_ready`-style template path applies, never the agent's text). At most one `expects: answer` per turn, and at most two messages to the owner per turn in all. With `expects: answer`, code applies `QUESTION_ASKED` (conversation) or `DETAIL_MISSING` (post) and stores the open question (`key` from `topic`, `attempts`). It can't touch: approval, buttons, templates, the timing of sends.

### `set_profile_field`

Sets one field of the onboarding draft (or of the active profile, A7).

| Field | Rule |
| --- | --- |
| `field` | A `BusinessProfile` path from the allowed list: everything except `approverPhone`, `style` (code reads the style choice), `channels` after onboarding, `brand.logoAssetId` (code sets it from the image that answers the logo request), and `persona` (the per-business name override, set by the team) |
| `value` | Validated against that field's own schema in `BusinessProfileDraft` |
| `sourceQuote` | Required for `name`, `location.*`, `contact.*`, `schedule.*`, `differentiator`, `mainProducts` and `fixedHashtags`: words of the owner's own messages in the context, verbatim (whitespace runs count as one space). Optional for fields with defaults (`tone`, `contentTypes`, `formats`) when the agent infers them from the owner's answers |

Code checks the quote (`quote_not_found`): it may come from any of the owner's messages in the context. Code checks that the value's numbers (hours, phone digits, house number) appear in the quote, or in the field's saved value, so a correction ("on Friday we close at 13:00") keeps the numbers the owner gave before (`value_not_in_quote`); a phone matches in its `+972` and local `0` forms. On an active business, code sends the owner a fixed confirmation naming the field and its whole new value (H6, `src/modules/agent/tools/profile-copy.ts`; WP-92), whichever agent made the change; a closed window skips it. It can't touch: the approver, the business status, channels after onboarding, the subscription, posts.

**Nested fields (WP-92).** A part of a nested field (`location.city`) is saved into the profile only once its whole object is valid (all four `location` parts, all three `schedule` parts, and so on). Until then the call succeeds with `saved: false` and the parts still `waitingFor`, and the parts given so far are read back from this onboarding's earlier `set_profile_field` calls (the turn history). So the stored profile is always a valid `BusinessProfileDraft`, and the agent's context never loses it.

### `record_fact`

Records one fact of the current week's update.

| Field | Rule |
| --- | --- |
| `type` | A fact type (contracts.md, Model tasks) |
| `value` | The normalized value (for example `15` for a 15% discount) |
| `sourceQuote` | Verbatim in the week's update text or transcript, or in an owner answer to this week's agent questions; a `testimonial` quote must be in text the owner typed |
| `replaces` | Optional id of an earlier fact this one corrects |

Code checks the quote (`quote_not_found`), that `value` appears in the quote for the factual types (price, discount, date, time, phone; `value_not_in_quote`), and appends the fact to `weekly_update.extracted_facts` with a new id. It can't touch: the profile, posts, other weeks.

### `request_photo`

Asks the owner for a photo.

| Field | Rule |
| --- | --- |
| `purpose` | `logo`, `business` (onboarding), `week` (the weekly update, before any post exists; added 2026-11-06 by WP-93), or `post` (with `postId`, and only `post` names a post) |
| `text` | As `ask_owner.text` |

Code sends the request (window rules as `ask_owner`) and stores the open question `photo_request` with the purpose; the next image from the owner answers it (for `logo`, code sets `brand.logoAssetId`; for `week`, the photo joins `weekly_update.media_asset_ids`, so `plan_posts` may use it). At most two photo requests per post. It can't touch: the media library beyond linking the answering photo.

### `record_decline`

Records that the owner declined something the agent asked for, so the done rule can pass.

| Field | Rule |
| --- | --- |
| `what` | `logo`, `business_photos`, `anything_else`, a `detail:<factType>` of a planned post, or `post_photo` with `postId` |
| `ownerQuote` | Verbatim in the owner's latest burst |

A declined detail means the post is written without it (the fact check then blocks the detail if the caption invents it).

### `plan_posts`

Proposes the week's plan, or revises it.

| Field | Rule |
| --- | --- |
| `mode` | `initial` (week `received`) or `revise` |
| `posts` | Each: `postId` (revise only), `topic`, `contentType`, `format`, `factIds`, `mediaAssetIds` (in carousel order), `brief` |
| `ownerQuote` | Required when the plan departs from the profile: a post count other than `postsPerWeek`, a format not in `formats`, or a post per photo; verbatim in the owner's messages this week |

Code checks (`plan_invalid` with the first failure): the count equals `postsPerWeek` unless `ownerQuote` justifies it (never above 7 a week); every `factIds` entry is a recorded fact of this week; every format is in the profile or justified; every `mediaAssetIds` entry is an owner photo of this week or of the media library; a carousel has 2 to 10 photos and a single post exactly one or none. `initial` applies `FACTS_EXTRACTED` and inserts the posts, as today. `revise` may change only posts in `planned` or `awaiting_clarification` and may add `planned` posts (the several-photos choice); it never touches a post with a version. It can't touch: captions, versions, approvals.

### `create_draft`

Creates the first version of a planned post.

| Field | Rule |
| --- | --- |
| `postId` | A post in `planned`, `drafting` or `awaiting_clarification` with no current version |
| `captions` | Per network of the post: `text` and `hashtags`, as `ChannelCaptions` |
| `usedFactIds` | Facts the captions and design use; each must be named by the post's plan or be a profile detail |
| `design` | A `DesignSpec` ([Photo edits](#photo-edits)) |

Code runs, in order: the fact check on every caption, the hashtags, the title and the badge (`fact_mismatch`); the badge rules (`badge_invalid`); the photo operation ranges (`edit_out_of_range`); rendering (`render_failed`, for example a title that does not fit, with the reason); then writes the `post_version` with the `design_spec`, and sends the draft with the Approve and Change buttons exactly as the drafts flow does today. The events depend on the post's state: from `planned`, `DRAFT_STARTED` then `DRAFT_READY`; from `awaiting_clarification`, `DETAIL_PROVIDED` then `DRAFT_READY` (`DRAFT_STARTED` is not valid there); from `drafting`, `DRAFT_READY` only. The agent never sees or sends the buttons. It can't touch: approvals, an existing version, publications.

### `apply_change`

Applies an owner's fix to a post that has a version.

| Field | Rule |
| --- | --- |
| `postId` | A post in `awaiting_approval`, `approved` or `scheduled` |
| `ownerQuote` | Verbatim in the owner's latest burst: the fix the owner asked for |
| `captions` | Optional, the full new captions |
| `design` | Optional, the full new `DesignSpec` |
| `networks` | Optional, a narrowed network list (publish on one channel only) |
| `rule` | Optional preference rule to save: `text` and `scope` (`caption`, `design`, `schedule`, `general`); the PRD saves every correction as a rule |

At least one of `captions`, `design`, `networks` must change something (`no_change`). Code then does exactly what the drafts flow does for a change today: invalidates every approval of the post and cancels its pending publications first, applies `CHANGE_REQUESTED`, saves the rule, runs the same checks as `create_draft` on the new content, writes a new version, and sends it with new buttons. Free text never approves, even "perfect, just add X": the agent applies the change, and the owner taps Approve on the new version (one extra tap). It can't touch: the approval itself, times, publications other than cancelling them through the invalidation path.

### `hand_off_to_console`

| Field | Rule |
| --- | --- |
| `reason` | `owner_asked_for_person`, `unclear`, `out_of_scope`, `sensitive`, `repeated_failure` |
| `note` | Up to 300 characters for the team; never sent to the owner |

Code sets the handoff flag, opens a `handoff` console item with the turn id and the note, and sends the owner the fixed hand-off line. Always allowed.

### `end_turn`

No fields. Ends the turn without waiting for anything (for example after an acknowledgement). Code still evaluates the done rule.

### The onboarding agent in the flow (WP-92)

Onboarding always runs on the agent (outside the one-shot test compositions, A9):

- **intro** (code): the persona's intro, `onboardingCopy.intro(name)`: her name (A1: the business's `persona.agentName`, else `system_control.agent_name` for the language, else Postly / פוסטלי) and feminine Hebrew (A2). Then the first agent turn asks the first question.
- **profile_questions**: each owner burst runs a turn. When the turn ends `done`, code applies `PROFILE_FIELDS_COMPLETE` (its usual guard) and starts a brand-assets turn at once, which asks for the logo.
- **brand_assets**: an image answers the open photo request: for `photo_request:logo`, code sets `brand.logoAssetId` from the first image; other images join the open question's `photoAssetIds`. Then the turn runs; when it ends `done`, code applies `BRAND_ASSETS_DONE` and sends the style samples.
- **profile_review**: the approval words still approve by code. Any other text runs a turn; `done` (a correction saved) applies `PROFILE_CORRECTED` and code resends the summary; a turn that ends without a change gets the "what to correct?" line; a question from the agent waits for the answer.
- Every other step (style choice, approval, channels, activation, payment link) is code, unchanged. With the flow off, onboarding runs the fixed questions as before.
- The agent's `questionAsked` event stores its open question on `conversation_state` (attempts counted per key), so a repeated topic still meets the three-attempt limit.

**Not yet with the onboarding agent:** a voice note's transcript does not reach the agent, because the context builder reads each message's text only (a runtime follow-up). With the flow on, a voice answer is seen as an empty message.

## How it fits the state machines

The machines do not get new states. What changes is who produces the events' inputs:

- **Onboarding.** `profile_questions` and `brand_assets` become "the onboarding agent gathers until done". After each step of a turn code evaluates the guard of `PROFILE_FIELDS_COMPLETE` and `BRAND_ASSETS_DONE` ([Agents](#agents)) and applies the event; the next code-driven step (the style samples) follows in the same handler, as today. A correction in `profile_review` runs the onboarding agent with `set_profile_field`; code resends the summary (`PROFILE_CORRECTED`).
- **Weekly update.** `UPDATE_RECEIVED` is applied by code as today; the weekly agent then gathers. `QUESTION_ASKED` and `ANSWER_RECEIVED` move the conversation between `processing_update` and `awaiting_answer` while the agent asks about details. The week moves to `planned` (`FACTS_EXTRACTED`) when `plan_posts` passes; `EXTRACTION_FAILED` (`needs_review`) when the weekly agent hands off or hits a limit before a plan.
- **Drafts.** `create_draft` drives `DRAFT_STARTED` and `DRAFT_READY`; a question about a post (several photos, a missing photo) drives `DETAIL_MISSING`, and the owner's answer `DETAIL_PROVIDED`; a hand-off or limit on a post drives `DRAFT_FAILED`. Code applies `DRAFTS_SENT` when every post is resolved. `apply_change` drives the post's `CHANGE_REQUESTED` and a new `DRAFT_READY`.
- **Fixes.** When `intent_detection` routes an owner text in `reviewing_drafts` (or `confirming_schedule`) as a change, code applies the conversation's `CHANGE_REQUESTED` first (to `processing_update`), as today; the drafts agent then runs in `processing_update`. A `clarify_change` question there is an ordinary `QUESTION_ASKED`, and code applies `DRAFTS_SENT` to return the conversation to `reviewing_drafts` once every post is resolved again.
- **Approval and after.** Unchanged and agent-free: `APPROVED` comes only from a button tap; `ALL_DRAFTS_RESOLVED`, the time proposal, `SCHEDULE_CONFIRMED` and publishing are code.

Free text in `reviewing_drafts` that is not a change (such as "looks good") is still not an event: the drafts agent is not called for it; code resends the open drafts with their buttons, as today. Routing between "a change" and "not a change" stays with `intent_detection`.

### How the drafts agent runs (WP-94)

- **Where it starts.** `draftWeek` (after the plan is stored) writes the photo notes and runs one turn (trigger `plan_stored`); an owner text in `reviewing_drafts` that `intent_detection` reads as a change applies the conversation's `CHANGE_REQUESTED` and runs a turn on the burst. An answer to a question the agent asked comes back to it: its open question's key is stored as `agent:drafts:<topic>`, so the drafts flow takes the answer (`ANSWER_RECEIVED`) before the weekly flow can.
- **Who does what.** The tools run the checks that need only data (ids and states, the plan's facts and photos, the 720-pixel crop rule, the fact check of captions, title and badge, the forbidden topics) and call the workflow through the events `draftCreated`, `changeApplied` and `holidayInWeek`; the workflow renders, writes the version (with its `design_spec`), sends it with the buttons and applies the post's events. The agent never sees the buttons.
- **A fix renders first.** `apply_change` renders the new content before it invalidates anything, so a render that fails (`render_failed`) changes nothing and the agent can correct it; only then are the approvals invalidated, `CHANGE_REQUESTED` applied, the rule saved and the new version sent.
- **Done.** On the plan's event the turn is done when no post is planned or drafting. On an owner message it also needs a draft written in this turn (`create_draft` or `apply_change` succeeded), because a fix leaves its post waiting for approval the whole time. After the turn, a post still drafting goes to `needs_review` (`DRAFT_FAILED`), and code applies `DRAFTS_SENT` (or hands off when no draft could be sent).
- **Sticker words and holidays.** The fixed words (`STICKER_WORDS`, he, ar, en, ru) live in the contracts so the workflow resolves a badge's text without the design module; `holidayInWeek` is the jewish-calendar check for the post's Sunday-to-Saturday week.

## Photo edits

A post's design is a `DesignSpec`, a fixed set of operations, written into [design-styles.md](design-styles.md#photo-edits-and-badge) (H2) so the design engine builds them from that doc. The design engine applies them in a fixed order, with sharp, before the style template: rotate, crop, tone. No operation creates, removes or alters image content, and there is no free image generation.

| Operation | Field | Range and rule |
| --- | --- | --- |
| Photo order | `photos[]` | 1 photo for a single post, 2 to 10 for a carousel; the first is the cover |
| Crop | `photos[].crop` | Normalized rectangle `x`, `y`, `w`, `h` in 0..1, used as the focus of the 4:5 cover crop; the crop must keep at least 720 source pixels across, so a post is never blurred by zoom |
| Straighten | `photos[].rotateDeg` | -10 to 10 degrees in 0.5 steps; the engine crops the corners so no empty edge shows |
| Brightness and contrast | `photos[].brightness`, `photos[].contrast` | -0.3 to 0.3 each (0 is unchanged); applied linearly, no filters or color grading |
| Title band | `title` | The style's overlay text on its panel (band or card): 1 to 40 characters, at most 2 lines, explicit line break allowed; fact-checked |
| Badge | `badge` | Optional; [Badge element](#badge-element) |
| Carousel layout | `carouselLayout` | `standard` (the cover carries the title and badge; later slides carry the frame and logo) or `numbered` (the same, plus a small slide counter such as 2/5 on later slides) |

Out-of-range values are refused (`edit_out_of_range`), not clamped, so the agent learns the range; the `image_review` suggestions are always in range.

### Badge element

A new design element with its own rules, also written into [design-styles.md](design-styles.md#photo-edits-and-badge) (H2):

| Rule | Value |
| --- | --- |
| Kinds | `discount` (text such as `-15%`), `price` (such as `₪29.90`), and fixed-word stickers `new` (חדש), `sale` (מבצע), `holiday` (חג שמח) per language (A6) |
| Fact check | A `discount` badge must equal a recorded `discount_percent` fact used by the post; a `price` badge a recorded `price` fact or a profile price. Stickers carry no number and no date. `sale` needs a recorded `promotion` or `discount_percent` fact in the post. `holiday` is allowed only when the post's week (Sunday to Saturday, `business.timezone`) holds a holiday that `jewish-calendar.ts` knows, so "חג שמח" never goes out in an ordinary week |
| Text | At most 8 characters, one line, digits in Latin numerals, the % sign after the number in every language |
| Shape per style | Clean: a square-cornered accent tag; Warm: a round stamp in the accent color with the card's paper tone; Dynamic: a circle in the secondary color rotated by -8 degrees with the shadow offset edge |
| Size and place | A 220 px circle or equivalent box, on the cover only, in the top corner opposite the logo, inside the 64 px safe area; never over the title panel or the logo |
| Contrast | Badge text 4.5:1 against the badge; the badge 3:1 against what it sits on, by the existing graphic-contrast rule |
| Text area | The title panel and the badge together stay within the 20% text-to-image rule |
| One per post | At most one badge |

## Persona and tone

The agent writes in the business's language and the profile's tone for posts, and in Postly's own voice for the conversation: short, warm, one question at a time, and never more than two messages a turn. The persona is "Postly" ("פוסטלי" in Hebrew) unless a business has its own `persona.agentName` (A1), and she speaks in the feminine in Hebrew everywhere (A2). The name appears in the intro, in the weekly reminder template and in greetings; it never appears in a post, and posts keep the business's own voice and tone. The persona's wording is part of the agent prompts (H7) and its fixed lines are copy (H6).

## Time proposals

Times stay code-only and come only after approval (WP-34). The proposal message labels each time by where it came from: "at your usual time" when it comes from the profile's `schedule.hours` and `schedule.days`, and "at a good default time" when the profile has none. Postly has no performance data in Phase 1, so no message says or implies "when your followers are most active"; that is WP-72, which needs metrics first. The agent does not propose or discuss times; an owner who asks the agent about times gets the code's proposal after approval.

## Prompts (H7)

Every agent prompt is a customer-facing prompt: it shapes what the owner reads and what is published. Each is a versioned row in `prompt_template` and is queued for the human before it is active in any environment with real owners:

| Task | Prompt covers |
| --- | --- |
| `agent_onboarding` | The persona, the fields and why each matters, how to follow up on vague answers, one question at a time, when to record a decline, when to hand off |
| `agent_weekly` | Turning an update into verbatim-quoted facts, which details are worth one question (an end date, a price), asking for a photo when none came, planning the week |
| `agent_drafts` | Caption and hashtag craft per network, the title and badge rules, choosing edits from the photo notes, applying fixes and saving them as rules, never inventing details |
| `image_review` (version 2) | The added `description`, `rotateDeg`, `brightness` and `contrast` suggestions |

Prompt rules that code also enforces: no detail without a source (the fact check), one question per turn, no approval language ("approved", "it's live") in agent text (a code word list refuses it with `forbidden_content`), and the business's languages only.

## Testing without paying for a model

The human's rule: no test pays for an LLM.

- **Every unit, db and e2e test** runs the agents on the **scripted agent**: a mode of the model simulator in which each `agent_*` task returns the next `AgentStep` from a deterministic script that the test supplies (a list of steps per turn, keyed by agent and turn number). A script that runs out, or a call to a task with no script, fails the test. The tests assert on the tool results, the state machine events, what the owner saw and what reached the networks. Refusals are tested by scripting bad tool calls (a quote that is not in the message, a badge that does not match a fact, an out-of-range crop, a third question).
  - **How a script is read (WP-91).** A call whose `AgentContext.toolResults` is empty starts the agent's next scripted turn; any later step continues it (`toolResults` holds every result of the turn so far, while the runtime rebuilds the rest of the context before each step). A scripted invalid output or provider failure is followed by a retry with the same input, which takes the next entry of the same turn. A turn that ends with steps left over, a script that runs out, a context that is not an `AgentContext`, or a call to an agent with no script (once the test scripted any agent) is a violation: the simulator throws `ScriptedAgentError`, and the e2e harness fails the test at teardown even if the model layer's retry or console fallback swallowed the error. A model simulator with no agent script keeps the hand-off default, so an unscripted agent never acts.
  - **The report.** Each scripted step (agent, turn, step, tool calls, confidence) is recorded with the results the runtime passed back in the next step's `toolResults`; the runtime's optional `onTurnEnd` hook (`AgentDeps.onTurnEnd`, once per turn after its `agent_turn` row is final; a `null` result is a call that never ran) adds the last step's results and the stop reason. The e2e report shows them in an "Agent steps" section.
  - **Strict agents.** `new ModelSimulator({ strictAgents: true })` makes every agent call without a script a violation from the start, even when the test scripts no agent; the agent e2e tests use it.
  - **No real model behind the harness.** The e2e harness refuses a model provider named like a real adapter (`google`), and a static test checks that no test file builds the Vertex adapter's real transport and that no CI workflow, `package.json` script, test config or compose file sets a deployed `POSTLY_ENV` (`dev`, `stage` or `prod`, which always run on Vertex AI). The runtime guard on `NODE_ENV`/`CI` is the model layer's (WP-90).
- **The model layer refuses a real provider in tests.** The provider factory throws when `NODE_ENV` is `test` or `CI` is `true` and the provider is not a simulator, so no Vitest run and no other CI job (the image build, the compose job) can reach a real model; a unit test proves both. `npm run check` and CI never set a real model.
- **The playground and local runs** keep a word-rule stand-in (`src/simulators/conversational/`) extended with a simple rule agent, so the human can play the agent flows without a model. Every deployed environment runs on real Gemini instead ([Running on dev](#running-on-dev)). The local playground still composes the one-shot flows (`oneShotFlows`, A9), because its end-to-end test drives them. The rule agent is a pure function of the `AgentContext`, reading what the turn already did from `toolResults`: onboarding fills the asked fields from the owner's whole answer (quoting it verbatim) and asks for the next missing group, then asks "anything else?" once; brand assets ask for the logo and the business photos and record a decline when text comes instead of an image; the weekly agent records the update as one fact and plans the week from it; the drafts agent drafts each planned post from its plan (asking for a photo when there is none) and applies an owner's change to the first open draft. It is not product logic.
- **The manual eval** (`npm run eval:agent`) is a separate script, outside Vitest and outside `npm run check`, that runs the example set's conversations against real Gemini. It refuses to start unless `POSTLY_AGENT_EVAL=1` is set, prints the expected cost before the first call, stops at a spend cap (`POSTLY_AGENT_EVAL_MAX_USD`, default 2), and writes a report: the conversations, the tool calls, the refusals, the drafts and their renders, and the cost. CI never runs it; a check fails if any CI workflow or `npm run check` references it.

## Running on dev

The owner uses the agents on the deployed dev through the sandbox ([deployment.md](deployment.md#real-gemini-and-the-agents-on-dev)). Dev is the only deployed environment where this runs until the vendor adapters land (WP-41).

- **The composition.** Dev runs in simulated mode with one exception: the model is real. Every deployed environment (`POSTLY_ENV` `dev`, `stage` or `prod`) puts the model layer on the Vertex AI adapter, with no switch (decided 2026-11-06; there is no `POSTLY_MODELS`); `local` and `test` run on the model simulator. The adapter is (`VertexModelProvider`, registered as `google`), calling Gemini as the web or worker service account with Application Default Credentials (no key), at `VERTEX_LOCATION` in `VERTEX_PROJECT`. WhatsApp, publishing and payments stay on the simulators, so nothing reaches a real channel or a real payment. Photos and voice notes the model reads are taken from the simulator store directly, not over HTTP.
- **The model.** Chosen per task by `model_task_config`, as everywhere: every task, the three agent tasks and the one-shot tasks, runs on Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`, A8, `drizzle/0023_gemini_3_5_flash_lite.sql`). Vertex retired `gemini-2.5-flash` and `gemini-2.5-flash-lite` on 2026-10-20 and suggests 3.5 Flash-Lite as their replacement; it was released 2026-07-21 and retires no earlier than 2027-07-21 ([model versions](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/model-versions)). Switching a model is a configuration change, not a code change; the adapter knows each model's price, and a model with no price is refused. `gemini-3.8-flash` is a possible later upgrade for `caption_writing` only, if the captions prove too weak; it is not adopted.
- **The endpoint.** 3.5 Flash-Lite is served on the `global` endpoint and the `us` and `eu` multi-regions, not from single regions such as `europe-west4` ([model page](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/3-5-flash-lite), [locations](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations)). Dev uses the EU multi-region (`VERTEX_LOCATION=eu`, host `aiplatform.eu.rep.googleapis.com`, path `/v1/projects/<project>/locations/eu/publishers/google/models/<model>:generateContent`), so processing stays in the EU; Google's global endpoint gives no control over where a request is processed. Google notes that an endpoint alone does not guarantee data residency.
- **The price.** USD per 1M tokens on Vertex's standard pay-as-you-go: 0.30 input and 2.50 output on `global`, 0.33 and 2.75 on non-global endpoints such as `eu` (in effect for Gemini 3 and later since 2026-07-01). The output price covers the response and the model's reasoning, so the adapter counts the thinking tokens Vertex reports (`usageMetadata.thoughtsTokenCount`) as output tokens. Source: [Vertex AI pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing), read 2026-11-06.
- **The request.** 3.5 Flash-Lite ignores custom temperature, top-P and top-K (its defaults are 1.0, 0.95 and 64), so `model_task_config.temperature` has no effect on it; the adapter still sends it, so a model that honors it would. It refuses a custom frequency or presence penalty and a request whose last `contents` turn has the role `model`; the adapter sends neither penalty, and every request is one `user` turn (the agent's history travels inside the `AgentContext` input), which a unit test pins. Thinking defaults to `MINIMAL`, which Google warns can stop multi-step tool use early, so the adapter sends `generationConfig.thinkingConfig.thinkingLevel = "MEDIUM"` for the `agent_*` tasks and leaves the one-shot tasks on the default.
- **The guard stays.** A deployed `POSTLY_ENV` refuses to start when `NODE_ENV` is `test` or `CI` is `true`, and the adapter's real transport (`adcTransport`) refuses the same environments on its own, so no test and no CI job can reach Gemini even with a wrong setting. Tests of the vertex composition inject a fake transport.
- **The agents always run.** Onboarding, weekly and drafts run on the agents for every business in every deployed environment (decided 2026-11-06): there is no `POSTLY_AGENT_FLOWS`, no Terraform `agent_flows` and no `agent_flows` column (`drizzle/0024_drop_agent_flows.sql`). The one-shot flows survive only as a composition option, `oneShotFlows` on `createApp` and `createSimulatedApp`, which defaults to `true` so the existing end-to-end and H5 tests and the local playground keep driving them unchanged. `main.ts`, the only deployed entry point, always passes `false`, and no env variable, config field or Terraform value reaches the option; `src/agents-always-on.test.ts` pins both. That one-shot code is dead in every deployed environment and goes with A9's cleanup.
- **Cost.** The agent limits ([Limits](#limits)) bound each turn, each business per day and all businesses per day (USD 50). On top, Terraform can add a monthly Cloud Billing budget on Vertex AI for the dev project, with emails at 50%, 90% and 100% ([deployment.md](deployment.md#real-gemini-and-the-agents-on-dev)); it warns and never stops spending.
- **The prompts are live on dev.** Every agent prompt (H7) answers a real owner-like conversation on dev from then on. Dev has no real customers, so the prompts stay provisional and queued for the human ([human-review-queue.md](human-review-queue.md)) before any environment with real owners.

## Data

New and changed rows ([database-schema.md](database-schema.md), H4 for the migration):

- `agent_turn`: one row per turn: `business_id`, `agent`, `trigger` (`burst` with the message ids, or a code event), `status` (`running`, `done`, `waiting`, `handed_off`, `failed`), `stop_reason`, `steps` (jsonb: each step's tool calls and results, without chain-of-thought), `cost_usd`, `duration_ms`, `started_at`, `ended_at`. Business-owned, RLS, cascade on delete.
- `model_run.agent_turn_id`: the turn a model call belonged to (null outside turns).
- `post_version.design_spec`: the `DesignSpec` the version was rendered from (immutable, like the rest of the version). The content hash is unchanged: it already covers the rendered media, so a different design gives a different hash.
- `agent_config`: a system table, one row per agent, with the limits above.
- `system_control.agent_flows` and `business.agent_flows`: added by 0018 as the flow switch, dropped by `0024_drop_agent_flows` (2026-11-06) when the agents became always on.
- `system_control.agent_name`: the global persona name per language (A1; default `{"en": "Postly", "he": "פוסטלי"}`).
