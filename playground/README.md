# Local playground (WP-45)

A local-only way to try Postly before any real WhatsApp, Instagram or Facebook connection exists. You play the business owner in a WhatsApp-style chat, and see what reached the networks in a mock feed. Everything runs on the in-memory simulators ([src/simulators/](../src/simulators/README.md)) and a local Postgres. Hebrew summary: [README.summary.he.md](README.summary.he.md).

```bash
npm run playground
```

Then open http://127.0.0.1:5175. Docker must be running: the playground starts `postgres:17-alpine` with Testcontainers and applies the migrations, the same way the test projects do (`test/db/start-database.ts`). To use an existing empty database instead, set `TEST_DATABASE_URL` to a superuser connection string. Every start creates a fresh business in `onboarding` and frees the playground number from earlier runs.

## What is on the page

- **Chat** (right): you are the approver number. Send text, photos (📷, any image file), voice notes (🎤, any audio file), and tap reply buttons. Messages go through the simulator's signed webhook, the real webhook route, deduplication and burst merge (1.5 seconds of quiet), then to the workflow.
- **Feed** (middle): what reached the publishing simulator, per network, with the images, next to two scripted demo posts on a separate demo account.
- **State** (left): the business status, the conversation step and handoff flag, the channel connections, the posts, and the review queue (console items), read from the database.

## Flows

The playground runs the product's composition root, `createApp` (`src/app.ts`), on the simulators: messaging hands each burst to the workflow, which runs onboarding (WP-30) for the new business. Onboarding is playable end to end: write first, answer the profile questions by text or voice note, send a logo, write `סיימתי` to get the three style samples (rendered by the design engine), pick a style, approve the summary with `מאשר`, then press **חיבור הרשתות בסימולטור** in the state panel (it completes the connection link on the publishing simulator) and write `חיברתי`. The business turns `active`.

Two stand-ins replace the model, so free Hebrew works without a real model: `server/extraction.ts` fills the asked profile fields from each answer with simple rules (playground only, not product logic), and voice notes transcribe to the model simulator's fixed text. Once active, write a weekly update (`server/weekly.ts` stands in for the model's planning, so the drafts pass the fact check), tap **אישור** under every draft, answer `כן` to the proposed times, then press **קפיצה בזמן ופרסום המתוזמנים** in the state panel: it moves the playground clock past the next scheduled time and runs the publishing job, and the posts appear in the feed with the confirmation template in the chat (WP-34). The panel shows the playground clock.

## Boundaries

- Local only, never deployed: React, Vite and the plugin are dev dependencies, and the entry point is `playground/vite.config.ts`, separate from the web and worker processes.
- Product code never imports the playground: the `no-playground` rule in `.dependency-cruiser.mjs`.
- The playground may import product code and the test helpers (`test/db/`, `test/e2e/harness/png.ts`).

## Layout

| Path | What |
| --- | --- |
| `server/playground.ts` | Builds the app in-process (`createApp`, the webhook server, the design engine, in-memory storage, simulators) and serves `/api/*` |
| `server/extraction.ts` | The rule-based stand-in for profile extraction on the model simulator |
| `server/seed.ts` | Scripted feed posts |
| `server/start.ts` | Starts Postgres and the playground for `npm run playground` |
| `vite-plugin.ts`, `vite.config.ts`, `ui-server.ts` | Mounts the API on the Vite dev server; `ui-server.ts` serves an already-built playground for the e2e test |
| `web/` | The React UI |

The end-to-end test `test/e2e/playground.e2e.test.ts` plays onboarding through the UI with Playwright and saves screenshots to `reports/playground/`.
