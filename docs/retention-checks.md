# Data Retention: Open Checks

Status: open list, decided by the human on 2026-11-04 (review queue item 29). The current design stays for now: after cancellation, a business's data is deleted 30 days later ([technical-design.md](technical-design.md), Operational defaults; WP-43). This document lists what must be researched before that design is final. Each check ends in a decision recorded in the PRD and the technical design, with a work package if code changes.

The human's direction so far: keep invoices and logs, and delete only what the law requires us to delete.

## Known gap

- **Billing rows are deleted by the cascade.** The `deletion` role deletes the `business` row, and `on delete cascade` removes every business-owned row with it ([database-schema.md](database-schema.md)), including subscription and payment records. If the law or the tax rules require keeping them, these tables must leave the cascade (or be copied or anonymised first). Until a check below settles it, this is a known gap, not a decision.
- **The workflow audit trail survives deletion (WP-46, 2026-11-05).** `workflow_event` keeps `business_id` as a plain value with no foreign key, so deleting a business leaves its audit rows, and nothing deletes them for now (the human's "keep everything"). The rows hold no customer content: ids, machine, state and event names, reason codes, and the actor kind. Their message ids point at messages that the cascade has deleted. Checks 3 and 4 decide how long they stay; a later package deletes or anonymises them past that period.

## To check

| # | Question | Why it matters | Likely outcome to confirm |
| --- | --- | --- | --- |
| 1 | Which Israeli tax and bookkeeping rules require keeping invoices, receipts and payment records, and for how long? | Billing rows are deleted with the business today | Keep billing records for the legal period (commonly 7 years), outside the cascade |
| 2 | Does the Privacy Protection Law (including Amendment 13) and its data security regulations require deleting a customer's personal data on request or after the service ends, and within what time? | Sets the real deletion duty and its deadline | Delete personal data and media; keep only what another law requires |
| 3 | What must be kept for disputes, fraud and security investigations: audit trail, approvals, publication records, model runs? | Approvals prove the owner approved each post | Keep a minimal audit record for a set period, anonymised where possible |
| 4 | What can be anonymised instead of deleted (for example phone numbers hashed, names and captions removed, counts kept)? | Keeps metrics and audit value without personal data | A per-table rule: delete, anonymise or keep |
| 5 | Should billing rows leave (the audit trail already has, WP-46) the business `on delete cascade`? | Follows from 1 and 3 | Probably yes, with the business id kept as a plain value |
| 6 | What may logs contain, and how long are they kept per environment? | Logs leave the database and the deletion job; see WP-47 | No customer content, phone numbers or secrets in logs; retention per [deployment.md](deployment.md) |
| 7 | Media: how long are owner photos and renders kept after publishing and after cancellation, and do the bucket lifecycle ages match? | `media.retain_until` and the bucket lifecycle are still provisional | Lifecycle ages longer than the retention period (T4) |
| 8 | Meta, WhatsApp and payment provider terms: what do they require us to delete or keep (for example data received through their APIs)? | Vendor terms can add duties | Note each duty next to the table it touches |
| 9 | Backups: how long do Cloud SQL backups keep deleted data, and is that acceptable under check 2? | Deleted rows live on in backups | State the backup retention in the privacy notice |
| 10 | What do we tell the owner (privacy notice, cancellation message) about what is kept and for how long? | Customer-facing copy (H6) | A short, accurate sentence in the cancellation flow |

## Owner

The human decides each row; the manager turns each decision into doc changes and, when code changes, a package. A lawyer or accountant should confirm rows 1, 2 and 8.
