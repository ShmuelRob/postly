# Local playground (WP-45)

A local-only way to try Postly before any real WhatsApp, Instagram or Facebook connection exists. You play the business owner in a WhatsApp-style chat, and see what reached the networks in a mock feed. Everything runs on the in-memory simulators ([src/simulators/](../src/simulators/README.md)) and a local Postgres. Hebrew summary: [README.summary.he.md](README.summary.he.md).

```bash
npm run playground
```

Then open http://127.0.0.1:5175. Docker must be running: the playground starts `postgres:17-alpine` with Testcontainers and applies the migrations, the same way the test projects do (`test/db/start-database.ts`). To use an existing empty database instead, set `TEST_DATABASE_URL` to a superuser connection string. Every start creates a fresh business in `onboarding` and frees the playground number from earlier runs.

## What is on the page

- **Chat** (right): you are the approver number. Send text, photos (📷, any image file), voice notes (🎤, any audio file), and tap reply buttons. Messages go through the simulator's signed webhook, the real webhook route, deduplication and burst merge (1.5 seconds of quiet), then to the playground's flow.
- **Feed** (middle): what reached the publishing simulator, per network, with the images. Until the publishing flow (WP-34) lands, it holds two scripted demo posts.
- **State** (left): the business status, the conversation step and handoff flag, the posts, and the review queue (console items), read from the database.

## Flows

`server/flows.ts` decides what handles each inbound burst. No product flow exists yet, so everything goes to an echo with placeholder copy: it repeats the text, acknowledges photos and voice notes, and sends two buttons when you write `כפתורים`. Button payloads are demo values and never reach the approval path. When onboarding (WP-30) and the weekly flows (WP-31 to WP-34) export their handlers, route bursts to them there.

## Boundaries

- Local only, never deployed: React, Vite and the plugin are dev dependencies, and the entry point is `playground/vite.config.ts`, separate from the web and worker processes.
- Product code never imports the playground: the `no-playground` rule in `.dependency-cruiser.mjs`.
- The playground may import product code and the test helpers (`test/db/`, `test/e2e/harness/png.ts`).

## Layout

| Path | What |
| --- | --- |
| `server/playground.ts` | Builds the app in-process (database, messaging module, webhook server, workflow, simulators) and serves `/api/*` |
| `server/flows.ts` | The inbound handler: today the echo |
| `server/seed.ts` | Scripted feed posts |
| `server/start.ts` | Starts Postgres and the playground for `npm run playground` |
| `vite-plugin.ts`, `vite.config.ts`, `ui-server.ts` | Mounts the API on the Vite dev server; `ui-server.ts` serves an already-built playground for the e2e test |
| `web/` | The React UI |

The end-to-end test `test/e2e/playground.e2e.test.ts` drives the UI with Playwright and saves a screenshot to `reports/playground/`.
