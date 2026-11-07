# Review Queue Items

Since 2026-11-07, every item the human reviews under the [operating mode](../implementation-plan.md#operating-mode) is its own file here, one per pull request. The older items stay, with their numbers, in [human-review-queue.md](../human-review-queue.md), which no longer grows. The Hebrew summary is [README.summary.he.md](README.summary.he.md).

## Why one file per PR

Every PR that touched a human-review area used to append a row to the same table and a line to its Hebrew summary, so any two open PRs conflicted and the second one renumbered. A file named by the PR number is unique as soon as the PR opens, so no numbers are handed out and two PRs never write the same file.

## Who writes and changes an item

- The PR that touches a human-review area (H1 to H8 in [implementation-plan.md](../implementation-plan.md#human-gates), an end-to-end test added or changed, or a change to CI and merge rules) adds `docs/review-queue/pr-<N>.md` on its own branch, once the PR has its number. The reviewer checks it against the diff; a missing or wrong item blocks the approval.
- A follow-up PR on the same work adds its own file and may link the earlier one; it never edits another PR's file.
- When the human marks an item `ok`, writes a finding or makes a decision, only that item's file changes: its `status`, and the decision under its English text. The manager makes the edit on the human's word, in a batched docs PR.

## Format

```markdown
---
added: 2026-11-07
pr: 143
gates: [H4, H8]
status: open
---

# Short title of what to review

What to review, in English: the files, the decision or risk, and what the human should check.

## עברית

שתיים או שלוש שורות בעברית: מה לבדוק ולמה.
```

- `added`: the date the item was added, `YYYY-MM-DD`.
- `pr`: the PR number; it must match the file name.
- `gates`: one or more of `H1` to `H8`, `e2e` (an end-to-end test added or changed) and `ci` (CI, branch protection or merge rules).
- `status`: `open`, `ok`, `waits` (blocked on the human: money or deployment), `finding` (needs a fix package) or `decided`, each with an optional note in brackets, such as `finding (WP-24)` or `decided (T3)`. The same values as the old table.
- The body has a `# ` title, the English text, then a `## עברית` section with at least one line of Hebrew. The Hebrew section in the same file stands in for a separate companion file ([agentic-development.md](../agentic-development.md#language-and-documentation-rules)).

`npm run lint:review-queue` checks every file here (CI runs it in the `static` job and a unit test runs the same check). Only `README.md`, `README.summary.he.md` and `pr-<N>.md` files may live in this directory.

## Listing the items

- `npm run review-queue` prints the open items (`open` and `waits`, with or without a note) from both places, the old table and this directory, as one Markdown table: number or PR, date, gates, status and title. It is generated on demand and never checked in, so it cannot conflict.
- `npm run review-queue -- --all` prints every item, whatever its status.
- `npm run review-queue -- --json` prints the same items as JSON (`source`, `id`, `pr`, `added`, `gates`, `status`, `title`, `file`), for the manager's work board.
