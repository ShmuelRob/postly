# Simulators

In-memory implementations of the provider interfaces in `src/contracts/providers/`, used in local and test environments instead of WhatsApp, the publishing provider, the models, and payments. Each simulator validates requests with the contract's Zod schemas, records what it received, and has methods to script the outside world. They hold no real credentials and reach no network.

| Simulator | Records | Scripting |
| --- | --- | --- |
| `MessagingSimulator` | `sent`, `sentTo(phone)`: every text, template, and button message, in order | `inboundText/Voice/Image/ButtonTap(...)` build inbound messages; `webhook(...messages)` signs them into a `WebhookRequest` (HMAC-SHA256 over url and body, header `x-simulator-signature`); `addMedia()` stores owner media; `failNextSend(error)`; `enforceWindow: true` makes text and buttons throw `WindowClosedError` 24 hours after the number's last inbound message |
| `PublishingSimulator` | `posts`, `postsOn(network)`, `publishedOn(network)`, `connectionLinks` | `connect()` / `disconnect()` accounts; posts are `scheduled` until the injected clock passes `scheduledFor`; `failNextPublish({ mode: 'reject' \| 'reject_after_create' \| 'fail_status' })`; `failPost()`; `setMetrics()` |
| `ModelSimulator` | `calls`, `callsFor(task)`: task, request, and result of every call | `script(task, ...outputs or input => output)` (checked against the task schema); `scriptInvalid(task, ...raw)` for retry tests; `failNext(task, error)`; `setDefault(task, fixture)`; `setTranscript(audioUrl, ...)` and `scriptTranscription(...)`; `{ defaults: false }` makes unscripted calls throw |
| `PaymentSimulator` | `links` | `completePayment(customerId)` returns a subscription id; `setStatus(id, state)`; `webhook(id)` builds the signed status callback |

Every simulator takes an optional `now: () => Date` so tests control time.

## Model task identification

`ModelProvider` requests name their `task`. `ModelSimulator` serves that task and rejects a request whose `outputJsonSchema` is not `taskOutputJsonSchema(task)`, which is `z.toJSONSchema(modelTasks[task].output)`. Unscripted calls get input-aware defaults from `model-fixtures.ts` that pass the code checks in contracts.md (verbatim source quotes, post count equal to `postsPerWeek`, allowed formats, the requested networks).

## Contract suites

`contract-suites/` holds one reusable suite per interface (`describeMessagingProviderContract(label, makeContext)` and so on). The `*.test.ts` files here run each suite against its simulator; a real adapter (WP-41) runs the same suite with a context built from the vendor's test account.
