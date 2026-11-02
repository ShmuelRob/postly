# Agentic Development Guide

Postly is built with coding agents, on a TypeScript modular monolith. Humans own the contracts and the high-risk code; agents implement within enforced boundaries.

## Language and documentation rules

- Everything related to code is written in English: code, comments, commits, pull requests, agent instructions, specs, PRDs, and technical documentation.
- Every document produced gets a separate companion with its key points and a summary in Hebrew. The product spec is the exception: it is kept at full length in both Hebrew and English.
- User-facing product content stays in the language the business chose, such as Hebrew WhatsApp messages and post captions.

## Stack

TypeScript in strict mode, Fastify, Postgres with row-level security, Drizzle, pg-boss, Zod, Playwright, and React for the internal console. Everything is one monolith hosted on Google Cloud, with Google models for now behind a replaceable layer. Move to Temporal only if long-running workflows outgrow pg-boss.

## Prepare before agents write code

1. Turn the spec into contracts: the state machine, database schema, Zod schemas, and the WhatsApp, publishing, and model interfaces. A human writes and approves these.
2. Add a repository instruction file: module structure, test commands, and prohibitions, such as calling a vendor outside its layer or querying without a business context.
3. Enforce boundaries automatically: strict TypeScript, import rules between modules, and CI that blocks merges on failure.
4. Replace external services with simulators: WhatsApp, the publishing provider, and the models. Agents can then run a full flow without sending a real message or publishing a real post.

## How work is divided

| Area | Working mode |
| --- | --- |
| Independent modules after contracts are set: design engine, vendor adapters, console | Parallel agents, each in its own worktree |
| Core: state machine, data model, main flow | One agent at a time, no parallel work |
| Review of agent-written code | A separate agent that did not write it, fanned out by area: security, tenant isolation, failure cases |
| Hebrew content quality: captions and templates | Human judgment, with an example set agents run against |

## Human review required

A human reviews every change that touches:

- The code that approves and publishes posts, including the check that only an approved version goes live.
- Row-level security and isolation between businesses.
- Tokens, secrets, and customer media.
- Database migrations.
- Prompts that run against customers.

The human writes the tests for the approval and publishing code, or approves them before an agent writes the implementation. Tests written by the same agent after the code tend to confirm what it already did. While the human has not written them, a separate agent that does not implement writes them first, under the operating mode in [implementation-plan.md](implementation-plan.md#operating-mode), and the human reviews them from the review queue.

## Testing

End-to-end tests are the most trusted tests. They run a full flow through the real code, from an inbound WhatsApp message to a published post, with only the external services replaced by simulators. Unit and contract tests are still written first, but a feature is done only when an end-to-end test covers its flow.

- Every user-facing flow has an end-to-end test: onboarding, the weekly update, drafts and changes, approval, scheduling, publishing, and each failure case in the technical design.
- End-to-end tests assert on what the owner and the networks would see: the WhatsApp messages sent, the rendered images, and what reached the publishing simulator. They do not assert on internal state alone.
- A human sees every end-to-end test. When an agent adds or changes one, it shows the human the test and a run of it: the conversation as sent and received, screenshots of rendered posts, and the pass or fail result. Runs produce a report a human can open and read without running the code.
- An end-to-end test that fails is not skipped, weakened, or deleted to make a change pass. The agent reports the failure to the human instead.

## Environment safety

In development, agents work only with test accounts and test keys. They have no access to real customer channels or data.

## First milestone

Start with the design engine and a Hebrew example set, without WhatsApp or publishing. The output is easy to verify through screenshots, and it is the fastest test of whether the product is good enough.
