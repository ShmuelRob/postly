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
| A8 | **Model per agent** | Gemini **Flash Lite** (`gemini-2.5-flash-lite`) for all three agent tasks, set in `model_task_config` |
| A9 | **Retiring the one-shot tasks** | `profile_extraction`, `fact_extraction`, `weekly_planning`, `caption_writing` and `change_interpretation` stay as the fallback behind the `agent_flows` switch until each agent passes the manual eval on the example set; then a cleanup package removes them |
| A10 | **Conversation history the model sees** | The last 20 messages of the conversation within 14 days, plus the current week's update; older context only through the profile, the preference rules and the post history summary |

**Follow-up (A8, A10).** If Flash Lite proves too weak in the manual eval (WP-96) or in dev use, revisit the history size, the model, or both; the trigger and the comparison to run are in [implementation-plan.md](implementation-plan.md#phase-7-the-agent) (WP-97).

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

1. **Lock.** The turn takes the business's `conversation_state` row (`for update` in a short transaction that marks the turn `running`), so at most one turn runs per business. A second trigger while a turn runs waits for the burst sweep, as an unprocessed burst does today.
2. **Context.** Code builds the agent's input from this business only ([Context](#context)).
3. **Step.** The model layer runs the agent's task. Its output is an `AgentStep`: one to four tool calls and a `confidence` (0 to 1). The output is Zod-validated like every model task; an invalid output retries within `model_task_config.max_retries` and then routes to the console.
4. **Execute.** Code runs the step's tool calls in order. Each call is checked (allowed for this agent and state, input schema, the tool's code checks) and then applied through the module that owns the data, in that module's transaction and role. A refused call stops the step: the later calls in it are skipped, and the refusal reason goes back to the agent.
5. **Decide.** After each step code evaluates the agent's "done" rule and applies the state machine event when it holds. The turn ends when the agent is done, when a call that waits for the owner (`ask_owner` expecting an answer, `request_photo`) was sent, on `end_turn`, on `hand_off_to_console`, or at a limit.
6. **Loop.** Otherwise the tool results are appended to the context and the next step runs.
7. **Record.** The `agent_turn` row gets the stop reason, the steps (tool calls and results), the total cost and duration; every model call of the turn is a `model_run` with the turn's id.

A crash mid-turn leaves the turn `running`; the burst it came from is still unprocessed (its claim is a lease), so the sweep re-runs it. Every tool call is idempotent by `(turnId, stepIndex, callIndex)`: a re-run turn starts a new turn row, and a tool call whose owner message was already sent for the same burst is not sent twice (messaging checks for an outbound message with the same idempotency key).

### Limits

All limits are configuration values (`agent_config`, a system table, one row per agent, and `system_control` for the global cap), decided by the human on 2026-11-05 (A4). Hitting any of them ends the turn and hands off.

| Limit | Default | When hit |
| --- | --- | --- |
| Steps per turn | 12 | Hand off: `agent_limit` console item, reason `max_steps` |
| Tool calls per turn | 24 | Same, reason `max_tool_calls` |
| Cost per turn | USD 0.06 | Same, reason `turn_budget`; the model layer refuses a call whose `max_cost_usd` would pass the remaining turn budget |
| Cost per business per day | USD 1.00 | Same, reason `daily_budget`; summed from `model_run.cost_usd` since local midnight. A business over its daily budget gets no agent turn until the next day; its messages are kept for the console |
| Cost across all businesses per day | USD 50 | Every agent turn hands off (reason `global_budget`) and the team gets an alert; the old one-shot path is not a fallback for cost |
| Turn duration | 90 seconds | The turn stops after the current tool call, reason `timeout` |
| Repeated question | The same `ask_owner.topic` 3 times in a week or an onboarding step | Hand off, reason `stuck` (the existing three-attempt rule) |
| Low confidence | `confidence` below 0.4 on a step | The step's calls are not run; hand off, reason `low_confidence` |
| Refused tool calls | 3 refusals in one turn | Hand off, reason `refusals` |

A hand-off from a limit always sends the owner one fixed code line (H6: a person will continue shortly), sets the handoff flag, and opens one console item with the turn id. The console shows the turn's steps.

### Module direction

The workflow module routes a burst or a code event to the agent module (`agent.runTurn(businessId, trigger)`); the agent module never imports workflow. The state machine events a tool needs (for example `DRAFT_READY` inside `create_draft`) reach the tools as callbacks injected when the app is wired (`createAgent({ events, messaging, content, design, ... })`), the same way flows get their providers today. So the dependency runs workflow → agent only, and dependency-cruiser keeps it that way.

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
| `field` | A `BusinessProfile` path from the allowed list: everything except `approverPhone`, `style` (code reads the style choice), `channels` after onboarding, and `brand.logoAssetId` (code sets it from the image that answers the logo request) |
| `value` | Validated against that field's own schema in `BusinessProfileDraft` |
| `sourceQuote` | Required for `name`, `location.*`, `contact.*`, `schedule.*`, `differentiator`, `mainProducts` and `fixedHashtags`: words of the owner's own messages in the context, verbatim (whitespace runs count as one space). Optional for fields with defaults (`tone`, `contentTypes`, `formats`) when the agent infers them from the owner's answers |

Code checks the quote (`quote_not_found`) and that the value's numbers (hours, phone digits, house number) appear in the quote. On an active business, code sends the owner a fixed confirmation naming the field and its new value (H6). It can't touch: the approver, the business status, channels, the subscription, posts.

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
| `purpose` | `logo`, `business` (onboarding), or `post` (with `postId`) |
| `text` | As `ask_owner.text` |

Code sends the request (window rules as `ask_owner`) and stores the open question `photo_request` with the purpose; the next image from the owner answers it (for `logo`, code sets `brand.logoAssetId`). At most two photo requests per post. It can't touch: the media library beyond linking the answering photo.

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

## How it fits the state machines

The machines do not get new states. What changes is who produces the events' inputs:

- **Onboarding.** `profile_questions` and `brand_assets` become "the onboarding agent gathers until done". After each step of a turn code evaluates the guard of `PROFILE_FIELDS_COMPLETE` and `BRAND_ASSETS_DONE` ([Agents](#agents)) and applies the event; the next code-driven step (the style samples) follows in the same handler, as today. A correction in `profile_review` runs the onboarding agent with `set_profile_field`; code resends the summary (`PROFILE_CORRECTED`).
- **Weekly update.** `UPDATE_RECEIVED` is applied by code as today; the weekly agent then gathers. `QUESTION_ASKED` and `ANSWER_RECEIVED` move the conversation between `processing_update` and `awaiting_answer` while the agent asks about details. The week moves to `planned` (`FACTS_EXTRACTED`) when `plan_posts` passes; `EXTRACTION_FAILED` (`needs_review`) when the weekly agent hands off or hits a limit before a plan.
- **Drafts.** `create_draft` drives `DRAFT_STARTED` and `DRAFT_READY`; a question about a post (several photos, a missing photo) drives `DETAIL_MISSING`, and the owner's answer `DETAIL_PROVIDED`; a hand-off or limit on a post drives `DRAFT_FAILED`. Code applies `DRAFTS_SENT` when every post is resolved. `apply_change` drives the post's `CHANGE_REQUESTED` and a new `DRAFT_READY`.
- **Fixes.** When `intent_detection` routes an owner text in `reviewing_drafts` (or `confirming_schedule`) as a change, code applies the conversation's `CHANGE_REQUESTED` first (to `processing_update`), as today; the drafts agent then runs in `processing_update`. A `clarify_change` question there is an ordinary `QUESTION_ASKED`, and code applies `DRAFTS_SENT` to return the conversation to `reviewing_drafts` once every post is resolved again.
- **Approval and after.** Unchanged and agent-free: `APPROVED` comes only from a button tap; `ALL_DRAFTS_RESOLVED`, the time proposal, `SCHEDULE_CONFIRMED` and publishing are code.

Free text in `reviewing_drafts` that is not a change (such as "looks good") is still not an event: the drafts agent is not called for it; code resends the open drafts with their buttons, as today. Routing between "a change" and "not a change" stays with `intent_detection`.

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
- **The model layer refuses a real provider in tests.** The provider factory throws when `NODE_ENV` is `test` or `CI` is `true` and the provider is not a simulator, so no Vitest run and no other CI job (the image build, the compose job) can reach a real model; a unit test proves both. `npm run check` and CI never set a real model.
- **The playground and the dev sandbox** keep a word-rule stand-in (`src/simulators/conversational/`) extended with a simple rule agent, so the human can play the agent flows without a model.
- **The manual eval** (`npm run eval:agent`) is a separate script, outside Vitest and outside `npm run check`, that runs the example set's conversations against real Gemini. It refuses to start unless `POSTLY_AGENT_EVAL=1` is set, prints the expected cost before the first call, stops at a spend cap (`POSTLY_AGENT_EVAL_MAX_USD`, default 2), and writes a report: the conversations, the tool calls, the refusals, the drafts and their renders, and the cost. CI never runs it; a check fails if any CI workflow or `npm run check` references it.

## Data

New and changed rows ([database-schema.md](database-schema.md), H4 for the migration):

- `agent_turn`: one row per turn: `business_id`, `agent`, `trigger` (`burst` with the message ids, or a code event), `status` (`running`, `done`, `waiting`, `handed_off`, `failed`), `stop_reason`, `steps` (jsonb: each step's tool calls and results, without chain-of-thought), `cost_usd`, `duration_ms`, `started_at`, `ended_at`. Business-owned, RLS, cascade on delete.
- `model_run.agent_turn_id`: the turn a model call belonged to (null outside turns).
- `post_version.design_spec`: the `DesignSpec` the version was rendered from (immutable, like the rest of the version). The content hash is unchanged: it already covers the rendered media, so a different design gives a different hash.
- `agent_config`: a system table, one row per agent, with the limits above.
- `system_control.agent_flows` and `business.agent_flows`: which flows run on the agent (`onboarding`, `weekly`, `drafts`), globally and as a per-business override for a pilot; off means the one-shot path (A9).
- `system_control.agent_name`: the global persona name per language (A1; default `{"en": "Postly", "he": "פוסטלי"}`).
