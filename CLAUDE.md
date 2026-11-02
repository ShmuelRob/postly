# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Postly is an AI agent that manages Instagram and Facebook for small business owners through WhatsApp. So far the repository holds the specs, the contracts (state machines, the Drizzle schema, and Zod schemas), and empty module folders with their boundary rules. No server, module logic, or migrations exist yet.

## Commands

Requires Node 26 LTS (`.node-version`), with TypeScript 7 and Vitest 5.

```bash
npm run check                                   # typecheck + module boundaries + all tests; run before finishing any change
npm run lint:boundaries                         # dependency-cruiser import rules only
npm test                                        # vitest run
npx vitest run src/db/schema.test.ts            # one file
npx vitest run -t "approval invariant"          # tests whose name matches
npm run db:generate                             # drizzle-kit migration from src/db/schema.ts (migrations need human review)
```

Code layout: `src/shared/state-machine.ts` is the generic transition-table engine; `src/contracts/` holds the machine definitions, the business profile, the model task schemas, and the provider interfaces; `src/db/schema.ts` is the Drizzle schema; `src/modules/<name>/index.ts` is each module's only public surface, with vendor SDKs only in that module's `adapters/` (rules in [src/modules/README.md](src/modules/README.md), config in `.dependency-cruiser.mjs`). CI (`.github/workflows/ci.yml`) runs `npm run check` on every PR and on main. Tests sit next to the code as `*.test.ts`. The contract tests copy their expected tables from the docs, so a doc change and its test change go together.

## Source-of-truth docs: read every session

Before any task, read all three:

- [PRD.md](PRD.md): product behavior, onboarding, business profile fields and defaults, approval rules, Phase 1 scope.
- [technical-design.md](technical-design.md): stack, modules, data model, internal interfaces, failure handling.
- [agentic-development.md](agentic-development.md): language rules, work division, human-review areas.

The contract docs refine the technical design and are equally binding. Read the one that covers your change: [state-machines.md](state-machines.md) (states, events, guards), [database-schema.md](database-schema.md) (tables, RLS), [contracts.md](contracts.md) (Zod schemas for the profile, model tasks, and provider interfaces), and [design-styles.md](design-styles.md) (style rules and output sizes for the design engine; provisional). Code in `src/contracts/` and `src/db/schema.ts` mirrors them one to one.

[implementation-plan.md](implementation-plan.md) lists the work packages, their lanes and human gates, and the session-manager loop. A work session reads its own package there; only the manager session edits package status.

## Workflow: docs first, tests first, code last

1. **Check against the docs.** Before writing any code, confirm the change matches the three docs above. If the request, existing code, or a needed decision conflicts with or is missing from the docs, stop and resolve it in the docs first (ask the user when the right answer is not clear), then write code that follows the updated docs. Never let code drift ahead of the docs.
2. **TDD.** Write failing tests before the implementation, then write the code to make them pass.
3. **End-to-end tests are the most trusted.** A feature is done only when an end-to-end test covers its flow, running the real code against simulators and asserting on what the owner and the networks would see. Show the user every end-to-end test you add or change, together with a run of it: the WhatsApp conversation, screenshots of rendered posts, and the result (send screenshots and reports with SendUserFile). Never skip, weaken, or delete a failing end-to-end test to make a change pass; report it instead.
4. **Human-owned tests.** For the approval and publishing code paths (including the check that only an approved version hash goes live), the human writes the tests or approves them before any implementation is written. Under the current operating mode in [implementation-plan.md](implementation-plan.md#operating-mode), a separate test-author session writes them, they merge before implementation, and they are queued for the human in [human-review-queue.md](human-review-queue.md).

When a doc changes, update its Hebrew companion in `docs/`: [docs/product-spec.he.md](docs/product-spec.he.md) is the full Hebrew mirror of the PRD; the other docs have short `*.summary.he.md` companions. Every new document needs a Hebrew summary companion.

## Architecture (from the docs)

- One TypeScript (strict) monolith, one deployable image running as a **web** process (Fastify) and a **worker** process (pg-boss), on Cloud Run / Cloud SQL / Cloud Storage. Postgres with row-level security, Drizzle, Zod, Playwright + sharp for rendering, React for the internal console.
- **Code owns the workflow; models run only bounded tasks.** Deterministic state machines drive onboarding, conversation, and posts. Approval, rendering, scheduling, and publishing are code-only paths with no model involved.
- **Every vendor sits behind an internal interface** and only that layer knows the vendor: `MessagingProvider` (Twilio/360dialog), `PublishingProvider` (Zernio/Ayrshare), `ModelProvider` (Google for now), `PaymentProvider` (placeholder), `TemplateRenderer`. Never call a vendor SDK outside its layer.
- **Every model call goes through the model layer**: versioned prompt per task, config-table model selection, Zod-validated output, and a `model_run` record (input, prompt version, output, cost, duration). Failed validation retries within a limit, then routes to the console.
- **Tenant isolation**: every business-owned table has RLS; never query without a business context; each model call gets only that business's context.
- **Approval invariant**: an approval is tied to an exact `post_version` content hash, any change invalidates it, free text never counts as approval, and only the business's single approver number is accepted. The publishing job accepts only a publication tied to an approved version hash.
- **Factual safeguards**: prices, discounts, dates, times, addresses, and phones in a draft must match their source (owner message or profile), checked in code; mismatches block sending.
- Design is rule-based from fixed templates for three styles (Clean, Warm, Dynamic), not free generation.

Modules: Messaging, Workflow, Model layer, Content, Design, Publishing, Business data, Billing, Console. Core data entities are listed in technical-design.md.

## Rules

- All code, comments, commits, PRs, and technical docs are in English. User-facing product content (WhatsApp messages, captions) is in the business's chosen language, Hebrew by default.
- Local and test environments use simulators for WhatsApp, publishing, models, and payments. Use only test accounts and test keys; never touch real customer channels or data.
- Core (state machine, data model, main flow) is worked on by one agent at a time. Independent modules (design engine, vendor adapters, console) may be parallelized in separate worktrees once contracts exist.
- Flag for human review (an entry in [human-review-queue.md](human-review-queue.md)) any change touching: approval/publishing code, RLS and tenant isolation, tokens/secrets/customer media, database migrations, or customer-facing prompts.
- Contracts (state machine, DB schema, Zod schemas, provider interfaces) are human-written and approved before agents implement against them.
- First milestone: the design engine and a Hebrew example set, without WhatsApp or publishing.
