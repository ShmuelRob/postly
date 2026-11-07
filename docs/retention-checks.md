# Data Retention: Open Checks

Status: open list, decided by the human on 2026-11-04 (review queue item 29). **Changed 2026-11-07, the human's decision "Keep, archive it":** cancellation never deletes data. A cancelled business is read-only and moves to `archived` 30 days later, its data kept; the only deletion is an erasure on the owner's explicit request, from the console, recorded in `erasure_request` ([technical-design.md](technical-design.md#cancellation-archiving-erasure-and-the-monthly-report)). The erasure-on-request rule is provisional until the human confirms it with legal advice (review queue item 75). This document lists what must be researched before the design is final. Each check ends in a decision recorded in the PRD and the technical design, with a work package if code changes.

The human's direction so far: keep invoices and logs, and delete only what the law requires us to delete. Data that grows is never deleted for space either: it moves to cheaper storage that can still be read (Phase 9 in [implementation-plan.md](implementation-plan.md#phase-9-storage-that-grows), WP-99 and WP-100), and an archived business is the natural first candidate. Data that grows is never deleted for space either: it moves to cheaper storage that can still be read (Phase 9 in [implementation-plan.md](implementation-plan.md#phase-9-storage-that-grows), WP-99 and WP-100), and an archived business is the natural first candidate.

## Known gap

- **Billing rows are deleted by the cascade on erasure.** Cancellation and archiving keep every row now. An erasure on request still deletes the `business` row as the `deletion` role, and `on delete cascade` removes every business-owned row with it ([database-schema.md](database-schema.md)), including subscription and payment records. If the law or the tax rules require keeping them, these tables must leave the cascade (or be copied or anonymised first). Until a check below settles it, this is a known gap, not a decision.
- **The workflow audit trail survives deletion (WP-46, 2026-11-05).** `workflow_event` keeps `business_id` as a plain value with no foreign key, so erasing a business leaves its audit rows (and its `erasure_request` row, the record that it was erased), and nothing deletes them for now (the human's "keep everything"). The rows hold no customer content: ids, machine, state and event names, reason codes, and the actor kind. Their message ids point at messages that the cascade has deleted. Checks 3 and 4 decide how long they stay; a later package deletes or anonymises them past that period.

## To check

| # | Question | Why it matters | Likely outcome to confirm |
| --- | --- | --- | --- |
| 1 | Which Israeli tax and bookkeeping rules require keeping invoices, receipts and payment records, and for how long? | Billing rows are deleted with the business today | Keep billing records for the legal period (commonly 7 years), outside the cascade |
| 2 | Does the Privacy Protection Law (including Amendment 13) and its data security regulations require deleting a customer's personal data on request or after the service ends, and within what time? Does the GDPR apply (EU customers), and is keeping an archived business's data without a request lawful? | Sets the real deletion duty and its deadline; the erasure-on-request path (2026-11-07) assumes deletion is needed only on request | Erase personal data and media on request (built); confirm that no deletion is due after the service ends and the deadline for a request (review queue item 75) |
| 3 | What must be kept for disputes, fraud and security investigations: audit trail, approvals, publication records, model runs? | Approvals prove the owner approved each post | Keep a minimal audit record for a set period, anonymised where possible |
| 4 | What can be anonymised instead of deleted (for example phone numbers hashed, names and captions removed, counts kept)? | Keeps metrics and audit value without personal data | A per-table rule: delete, anonymise or keep |
| 5 | Should billing rows leave (the audit trail already has, WP-46) the business `on delete cascade`? | Follows from 1 and 3 | Probably yes, with the business id kept as a plain value |
| 6 | What may logs contain, and how long are they kept per environment? | Logs leave the database and the erasure; see WP-47 | No customer content, phone numbers or secrets in logs; retention per [deployment.md](deployment.md) |
| 7 | Media: how long are owner photos and renders kept after publishing and after cancellation, and do the bucket lifecycle ages match? | `media.retain_until` and the bucket lifecycle are still provisional | Lifecycle ages longer than the retention period (T4) |
| 8 | Meta, WhatsApp and payment provider terms: what do they require us to delete or keep (for example data received through their APIs)? | Vendor terms can add duties | Note each duty next to the table it touches |
| 9 | Backups: how long do Cloud SQL backups keep deleted data, and is that acceptable under check 2? | Deleted rows live on in backups | State the backup retention in the privacy notice |
| 10 | What do we tell the owner (privacy notice, cancellation message) about what is kept and for how long? | Customer-facing copy (H6) | A short, accurate sentence in the cancellation flow: since 2026-11-07 `subscription_cancelled` says the data is kept and that the owner may ask us to delete it (review queue item 76) |

## Owner

The human decides each row; the manager turns each decision into doc changes and, when code changes, a package. A lawyer or accountant should confirm rows 1, 2 and 8.
