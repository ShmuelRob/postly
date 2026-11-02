# Human Review Queue

Items the human reviews at their own pace, under the [operating mode](implementation-plan.md#operating-mode). The work has already merged unless the item says it waits. The reviewer session adds items; the human marks them `ok` or writes a finding, and the manager turns each finding into a fix package.

Status values: `open` (not reviewed yet), `ok` (reviewed, no change), `finding` (needs a fix package), `waits` (blocked on the human: money or deployment).

| # | Added | Package / PR | Gate | What to review | Status |
| --- | --- | --- | --- | --- | --- |
