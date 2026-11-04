# Postly Implementation Plan

Status: active. Contracts approved on 2026-11-02; styles and example set are provisional.

This plan splits Phase 1 into work packages that coding-agent sessions build one package at a time. A manager session runs the loop described in [Session manager](#session-manager): it starts a session for each package that is ready, verifies the result, brings human gates to the human, and repeats until every package is done. The plan follows [PRD.md](../PRD.md), [technical-design.md](technical-design.md), and [agentic-development.md](agentic-development.md). When it conflicts with them, they win and this plan is fixed.

## Rules every session follows

- Read CLAUDE.md, the three source-of-truth docs, and the contract doc that covers the package before writing code.
- Docs first: a package that needs a decision missing from the docs stops, reports the gap to the manager, and writes no code around it.
- TDD: failing tests first, then code. A package is done only when its end-to-end test passes and its report is shown to the human.
- Stay inside the package's files. Any change outside them is reported, not made.
- Never skip, weaken, or delete a failing end-to-end test.
- One branch and one pull request per package, named `wp/<id>-<slug>`. Sessions never merge; the manager merges after the gates pass.

## Lanes

| Lane | Meaning | Concurrency |
| --- | --- | --- |
| Core | State machines, data model, workflow runtime, main flows | One session at a time, across all core packages; from 2026-11-03 the human allows several when their files are disjoint (for example `src/db/` vs one module) and each rebases on the others' merges |
| Parallel | Independent modules behind a set contract: design engine, adapters, console | Up to three sessions at once, each in its own worktree, never two on the same files |
| Human | Decisions and approvals only the human can give | Blocks every package that depends on it |

## Operating mode

Set by the human on 2026-11-02. It overrides the waiting steps in the gates, the loop, and the brief below until the human changes it.

- **Gates no longer block, with two exceptions.** A gate that spends real money (a paid vendor plan, a real payment) or deploys to any cloud environment (WP-44, anything that creates cloud resources) still waits for the human. Every other gate becomes a queued review: the work goes ahead, and the item is added to [human-review-queue.md](human-review-queue.md) with the PR, what to look at, and the gate it stands in for. The human reviews the queue at their own pace; a finding becomes a fix package.
- **Human-owned tests (H5).** Until the human writes them, a test-author session that does not implement writes the approval and publishing tests on their own branch, the reviewer checks them against the docs, and they merge before the implementing session starts. The implementing session may not change them; a test it believes is wrong is reported, not edited. The tests are queued for the human.
- **Human-authored content (H2, H3, H6, H7).** Sessions draft the Hebrew copy, templates, prompts, styles, and example set from the docs, mark them provisional, and queue them for the human.
- **Reviewer session.** One long-running reviewer session, separate from every developer session, takes over loop steps 4 to 6: it verifies each pull request, reviews it by area, queues human-review items, approves, and squash-merges it into main. It never writes product code beyond trivial fixes it states in the PR.
- **Vendor accounts.** Packages that need vendor test accounts or keys (WP-41) stay blocked until the human provides them, since agents do not create accounts.

## Human gates

| Gate | What the human provides or approves | Blocks | State |
| --- | --- | --- | --- |
| H1 | Approve state-machines.md, database-schema.md, and contracts.md, and drop their "draft" status | Every core package | Passed 2026-11-02 |
| H2 | Style rule spec for Clean, Warm, and Dynamic, licensed Hebrew fonts, and output sizes per network | WP-11 to WP-13 | Accepted for now on 2026-11-03; WP-14 makes the styles professional |
| H3 | The real Hebrew example set: businesses, photos, weekly updates, and expected outcomes | WP-12, WP-13, WP-21 prompt evaluation | Accepted on 2026-11-03: the provisional set is the working set until the human brings a better one |
| H4 | Review of the generated migration and the RLS policies | WP-20 merge | Open |
| H5 | Writes or approves the approval and publishing tests before implementation | WP-33, WP-34 | Accepted on 2026-11-03: a test-author session writes the tests, under the operating mode |
| H6 | Conversation copy, WhatsApp template text, and channel connection guidance in Hebrew | WP-30, WP-31, WP-34 | Accepted for the demo on 2026-11-03; drafts are queued |
| H7 | Review of every customer-facing prompt | WP-21 merge and every package that adds a prompt | Open |
| H8 | Review of tokens, secrets, and customer media handling | WP-41, WP-44 | Open |

## Decisions

The tooling choices and operational defaults are recorded in [technical-design.md](technical-design.md) (Stack and Operational defaults), and the output sizes and fonts in [design-styles.md](design-styles.md). Human decisions on 2026-11-03 (review queue items 1 to 7): H2 styles accepted for now, to be made professional later (WP-14); H3 the provisional set is the working set until the human brings a better one; H5 the test-author approach is accepted; H6 drafted copy is fine for the demo.

An update that arrives after the week cutoff counts as next week's update (decided by WP-31 on 2026-11-03 and queued for the human as review queue item 20; see [technical-design.md](technical-design.md#weekly-update-flow)).

Contract gaps found while building the simulators (WP-03). Each is a contract change that the named package proposes in the docs, and queues for the human, before its implementation:

- `ModelProvider` requests carry no task name; the simulator matches the task by its output JSON Schema (`z.toJSONSchema` of the task's output). WP-21 either keeps that derivation in one shared helper or adds a task field. Settled by WP-21: both request types carry a `task` field (contracts.md, `ModelProvider`).
- `PaymentProvider` has no way to learn a `providerSubscriptionId` after payment (no webhook verification or lookup). WP-42 adds one. Settled by WP-42: `verifyWebhook` returns a `PaymentEvent` (contracts.md, `PaymentProvider`), on the sibling `PaymentWebhooks` interface.
- There is no typed error for sending outside the 24-hour WhatsApp window. WP-22 adds one, and WP-35 tests it.

## Work packages

Status values: `todo`, `blocked`, `in_progress`, `review`, `done`. Only the manager edits the status column.

### Phase 0: foundations

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-01 | Guardrails: module folders under `src/modules/<name>/` with a public `index.ts`, import rules (vendors only in adapters, no cross-module internals, no DB access without a business context helper), CI workflow | Core | none | CI fails on a seeded boundary violation and passes on main | done |
| WP-02 | End-to-end harness: Vitest `e2e` project, the in-process app wiring with simulators, and the HTML report writer | Core | WP-01 | A sample test produces a report the human can open | done |
| WP-03 | Simulators for `MessagingProvider`, `PublishingProvider`, `ModelProvider` (scripted fixtures per task), and `PaymentProvider`, plus shared contract tests that later run against real adapters | Parallel | WP-01 | Contract tests pass against every simulator | done |

### Milestone 1: design engine and Hebrew example set

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-10 | Example-set format and the provisional set: fixture layout, loader, Zod schema for entries, six fictional businesses, code-generated placeholder photos | Parallel | WP-01 | Loader validates every provisional entry | done |
| WP-11 | Design engine core: `TemplateRenderer` with Playwright and sharp, RTL layout, crop, logo and caption placement, per-network output | Parallel | WP-01, H2 (provisional) | Renders a test fixture in every style and network, checked by snapshot | done |
| WP-12 | The three style templates (one session per style once WP-11 is merged) | Parallel | WP-11, H2 | Each style renders the example set within its rules | done |
| WP-13 | Example-set runner: renders every example in every style into a screenshot gallery report | Parallel | WP-10, WP-12 | The human reviews the gallery on the provisional set; milestone 1 closes once it passes on the final styles and the real set | done |
| WP-14 | Design research and style upgrade: research what makes social posts effective (look first for existing skills and published rules), write the findings into design-styles.md, then update the three styles; also the style review items moved from WP-15 (shared `pre-line`, shared style-test helpers, snapshot renames) | Parallel | WP-12 | design-styles.md carries the researched rules and the styles render the example set within them | done |
| WP-15 | Cleanup from reviews: fixture phones to 0501234567 / +972501234567, versioned gitignored e2e reports per run, the link-checker fixture test; the style items (shared `pre-line`, test helpers, snapshot names) go to WP-14 and the flaky boundaries test to its own fix | Parallel | WP-12 | `npm run check` passes and the listed items are closed | done |

### Phase 2: core platform

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-20 | Database: migration from `schema.ts`, RLS policies, roles, `withBusiness()` transaction helper, test database setup | Core | H1, WP-02 | Tenant isolation tests prove one business cannot read or write another's rows; H4 passed | done |
| WP-21 | Model layer: task registry, versioned prompts, config table, Zod validation with retries, `model_run` records, console routing | Core | WP-20, WP-03 | Invalid simulator output retries and lands in `console_item`; H7 passed for any prompt | done |
| WP-22 | Messaging module: Fastify webhook, verification, deduplication, burst merge, sending, 24-hour window, unknown numbers to the console | Core | WP-20, WP-03 | End-to-end: duplicate and unknown-number messages behave as specified | done |
| WP-23 | Workflow runtime: apply an event with its guards inside one transaction, pg-boss worker wiring, handoff flag, pause flags | Core | WP-20 | Invalid transitions are rejected and logged; handoff stops automatic replies | done |
| WP-24 | Database hardening: a role per operation (least privilege) and composite `(business_id, id)` foreign keys, per database-schema.md | Core | WP-20 | Tests prove each role can reach only its tables and verbs, and a cross-business reference is rejected; before WP-33 | done |

### Phase 3: product flows

Each flow ends with an end-to-end test from an inbound WhatsApp message to what the owner and the networks see.

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-30 | Onboarding: intro, profile questions with extraction, brand assets, style samples, profile review, channel connection and test, business activation | Core | WP-21, WP-22, WP-23, WP-12, H6 | End-to-end onboarding in Hebrew, including voice answers | done |
| WP-31 | Weekly update: week rows, reminder template, transcription, fact extraction with verbatim quote check, weekly planning | Core | WP-30, H6 | End-to-end: update in, plan stored; no update leads to reminder then a skipped week | done |
| WP-32 | Drafts: caption writing, code fact check, `post_version` with content hash, rendering, sending with buttons, change requests, preference rules, the several-photos choice (carousel, one photo, a post per photo) | Core | WP-31 | End-to-end: a mismatched price blocks sending; a change creates a new version and a saved rule | done |
| WP-33 | Approval: button-only approval, approver number check, hash match, invalidation on any new version | Core | WP-32, WP-24, H5 | Human-owned approval tests pass | done |
| WP-34 | Scheduling and publishing: time proposals per profile and holidays, publications per channel, publishing job with the publishing guard and pause checks, retries with a provider status check, confirmation templates | Core | WP-33, H5, H6 | Human-owned publishing tests pass; end-to-end shows posts reaching the publishing simulator only after approval | todo |
| WP-35 | Failure cases from the technical design: closed 24-hour window, no response, late approval, one channel failing, channel disconnect with daily health check, unknown number, failed model validation | Core | WP-34 | One end-to-end test per case | todo |

### Phase 4: periphery

| ID | Package | Lane | Depends on | Done when | Status |
| --- | --- | --- | --- | --- | --- |
| WP-40 | Console (React): conversations, drafts, console items, handoff, retries, business and global pause | Parallel | WP-23 | Each console action is covered by a test through the console API | done |
| WP-41 | Real adapters: Twilio, Zernio, Google models; one session each | Parallel | WP-03, vendor decisions, H8 | Shared contract tests pass against the vendor's test account | todo |
| WP-42 | Billing: placeholder `PaymentProvider`, payment link in WhatsApp, subscription machine | Parallel | WP-22, WP-23 | End-to-end: payment link sent, status changes applied | done |
| WP-43 | Cancellation and data deletion schedule, monthly report | Core | WP-34 | End-to-end: cancellation disconnects channels immediately | todo |
| WP-44 | Deployment: one image, web and worker on Cloud Run, Cloud SQL, Cloud Storage, secret manager, monitoring | Parallel | WP-22, WP-23, H8 | Staging runs the end-to-end suite with test accounts | in_progress |
| WP-45 | Local playground (React, local only, never deployed and kept out of the production image): a WhatsApp-style chat where the human plays the owner through the messaging simulator (text, voice notes as audio files, photos, reply buttons), a mock Instagram and Facebook feed showing what reached the publishing simulator, and a state panel (business, conversation and post states, the review queue). Starts with scripted simulator data; each flow becomes playable as WP-30 to WP-34 land | Parallel | WP-02, WP-03, WP-22, WP-23 (WP-30 to close) | The human can run `npm run playground` and play onboarding end to end on simulators, covered by an end-to-end test that drives the UI | done |

## Session manager

The manager is one long-running Claude session that owns this plan. It does not write product code.

### Loop

1. **Pick.** List packages whose dependencies are `done` and whose gates have passed. Take at most one core package if no core session is running, and fill free parallel slots (up to three) with parallel packages that touch disjoint files.
2. **Start.** Start one session per package in its own worktree with the brief below. Set the package to `in_progress`.
3. **Wait.** Do nothing until a session reports. Never poll.
4. **Verify.** (Reviewer session under the [operating mode](#operating-mode).) On a report: run `npm run check` on the branch, open the end-to-end report, and start a separate review agent that did not write the code, split by area (security, tenant isolation, failure cases) where the package touches them.
5. **Gate.** If the package touches a human-review area, or adds or changes an end-to-end test, show the human the diff summary, the test, and its report. Under the operating mode, add an entry to the review queue instead of waiting, unless the gate spends money or deploys. Set the package to `review`.
6. **Merge.** After approval (the reviewer's, under the operating mode), squash-merge the pull request into main. The manager then sets the package to `done` and commits the status change.
7. **Repeat** from step 1. When nothing is ready and nothing is running, list the open human gates and decisions to the human and stop.

A session that reports a doc gap or a failing end-to-end test is not retried blindly: the manager brings it to the human, updates the docs and their Hebrew companions once decided, and then restarts the package.

### Session brief template

```text
Package: <id> <name> (lane: <core|parallel>)
Read first: CLAUDE.md, PRD.md, technical-design.md, agentic-development.md, <contract doc>, implementation-plan.md (<id>).
Scope: <files and folders this package may change>. Anything else: report, do not change.
Steps: confirm the docs cover the work; write failing tests; implement; add or update the end-to-end test; run npm run check.
Done when: <done criterion from the table>.
Human gates: <gates>. Under the operating mode, queue them; stop only for money or deployment, or if the human-owned tests are not yet merged.
Deliver: branch wp/<id>-<slug>, a pull request, the end-to-end report sent with SendUserFile, and a short report of anything left open.
```

## Recommended start

Waves are what can run together. The core lane and the parallel lane run side by side.

1. WP-01 alone, since every package builds on its folders and rules.
2. Core lane: WP-02, then WP-20, WP-21, WP-22, WP-23. Parallel lane, at the same time: WP-03, WP-10, and WP-11.
3. Parallel lane: the three style sessions of WP-12, then WP-13. This produces the first gallery for review.
4. Phase 3 in order on the core lane, with WP-45, WP-40, and WP-41 on the parallel lane alongside it. WP-45 comes first, so the human can test each flow locally as it lands.
