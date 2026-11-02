# Human Review Queue

Items the human reviews at their own pace, under the [operating mode](implementation-plan.md#operating-mode). The work has already merged unless the item says it waits. The reviewer session adds items; the human marks them `ok` or writes a finding, and the manager turns each finding into a fix package.

Status values: `open` (not reviewed yet), `ok` (reviewed, no change), `finding` (needs a fix package), `waits` (blocked on the human: money or deployment).

| # | Added | Package / PR | Gate | What to review | Status |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-11-02 | WP-01 / [#4](https://github.com/ShmuelRob/postly/pull/4) | Tenant isolation (guardrail) | The import rules that keep DB access behind the business-context helper: `db-driver-outside-db` and `db-internals` in `.dependency-cruiser.mjs` (drivers only in `src/db/`; elsewhere only `src/db/index.ts` and `src/db/schema.ts`). Check the driver list is complete and that allowing `schema.ts` everywhere is acceptable. RLS itself comes in WP-20. | open |
