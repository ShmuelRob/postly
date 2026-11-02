# Human Review Queue

Items the human reviews at their own pace, under the [operating mode](implementation-plan.md#operating-mode). The work has already merged unless the item says it waits. The reviewer session adds items; the human marks them `ok` or writes a finding, and the manager turns each finding into a fix package.

Status values: `open` (not reviewed yet), `ok` (reviewed, no change), `finding` (needs a fix package), `waits` (blocked on the human: money or deployment).

| # | Added | Package / PR | Gate | What to review | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-11-02 | WP-01 / [#4](https://github.com/ShmuelRob/postly/pull/4) | Tenant isolation (guardrail) | The import rules that keep DB access behind the business-context helper: `db-driver-outside-db` and `db-internals` in `.dependency-cruiser.mjs` (drivers only in `src/db/`; elsewhere only `src/db/index.ts` and `src/db/schema.ts`). Check the driver list is complete and that allowing `schema.ts` everywhere is acceptable. RLS itself comes in WP-20. | open |
| 2 | 2026-11-02 | WP-02 / [#7](https://github.com/ShmuelRob/postly/pull/7) | End-to-end test (new) | The e2e harness (`test/e2e/harness/`) and the sample test `test/e2e/sample.e2e.test.ts`, which uses a stub app (it is not the real approval flow). Open the HTML report (`npm run test:e2e`, then `reports/e2e/index.html`, or the `e2e-report` CI artifact) and check that the transcript, renders, and publishing log are what you want to see for every later flow. | open |
| 3 | 2026-11-02 | WP-10 / [#6](https://github.com/ShmuelRob/postly/pull/6) | H3 (provisional Hebrew example set) | Agent-drafted Hebrew content in `fixtures/example-set/*/`: six profiles, weekly updates, expected facts, and overlay texts, all `provisional: true`. Also: the "expected outcomes" format (`fact_extraction` output plus cover `overlayTexts`) was defined by the developer; the manager is documenting it in design-styles.md. The contact phones are fictional but look like real numbers (for example landlines `+97297000001`, `+97248000002`, `+97289000005`, and mobiles `+97250000010x`); consider switching to clearly reserved numbers. | open |
