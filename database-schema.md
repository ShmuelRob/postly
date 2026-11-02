# Postly Database Schema

Status: approved contract (2026-11-02). Migrations generated from it require human review.

Postgres with row-level security, accessed through Drizzle. The code in `src/db/schema.ts` implements this document one to one. State columns use the enums defined in [state-machines.md](state-machines.md).

## Conventions

- Primary keys are `uuid` with a database default (`gen_random_uuid()`).
- Times are `timestamptz`. Business-local logic (publishing days, Shabbat and holidays) uses `business.timezone`, default `Asia/Jerusalem`.
- Phone numbers are stored in E.164 format.
- `jsonb` columns are validated by the named Zod schema from [contracts.md](contracts.md) on every write. The database does not trust their shape.
- Every table has `created_at`; mutable tables also have `updated_at`.

## Tenant isolation

- A table is **business-owned** when it has a `business_id` column. Every business-owned table, and `business` itself, has RLS enabled with a `tenant_isolation` policy for the `app_user` role: a row is visible and writable only when its business matches `current_setting('app.business_id')`.
- The application sets `app.business_id` with `set_config(..., true)` at the start of each transaction. A query without a business context sees no rows.
- The `app_system` role bypasses RLS. It is used only for: resolving an inbound phone number to a business, the scheduler that fans jobs out per business, the console, and the example-set runner. Every other code path uses `app_user`.
- Rows with a null `business_id` (messages from unknown numbers, example-set model runs) are visible only to `app_system`.
- Tables without `business_id` are system tables and are not readable by `app_user` beyond what the model layer and publishing job need (`model_task_config`, `prompt_template`, `system_control`).
- Both roles are separate logins created by the first migration, each with its own connection pool; their passwords are set outside migrations. Neither is a member of the other or owns any table, so no statement inside a transaction can switch to a stronger role. A separate migration role owns the tables, and every business-owned table has `FORCE ROW LEVEL SECURITY`, so the owner is filtered too.
- `app_user` may read, insert, update, and delete business-owned tables, with two exceptions that enforce immutability: it may only insert `post_version`, and on `approval` it may only insert and update `invalidated_at`. It may only read the system tables. `app_system` may do all four on every table.
- Every new table needs explicit grants and, if business-owned, `FORCE ROW LEVEL SECURITY` in its migration. There are no default privileges, so a table without grants fails closed.
- In code, `withBusiness(businessId, fn)` from `src/db/index.ts` opens an `app_user` transaction with `app.business_id` set, and `withSystem(purpose, fn)` an `app_system` one, where `purpose` names one of the four uses above. No other way to query leaves `src/db/`.
- **Accepted risk:** Postgres cannot stop a role from changing its own custom settings, so SQL run through the transaction handle could call `set_config('app.business_id', ...)` with another business. The CI guard `src/db/raw-sql-guard.test.ts` therefore fails on `set role`, `set local`, `set session`, `set app.*`, `reset`, `set_config`, and `discard` anywhere outside `src/db/`.

## Enums

| Enum | Values |
| --- | --- |
| `business_status` | Business machine states |
| `conversation_step` | Onboarding steps followed by conversation steps, as one enum |
| `weekly_update_status` | Weekly update machine states |
| `post_status` | Post machine states |
| `publication_status` | Publication machine states |
| `channel_connection_status` | Channel connection machine states |
| `subscription_status` | Subscription machine states |
| `network` | `instagram`, `facebook` |
| `visual_style` | `clean`, `warm`, `dynamic` |
| `post_format` | `single`, `carousel` |
| `media_kind` | `logo`, `photo`, `voice`, `rendered` |
| `media_source` | `owner`, `library`, `render` |
| `message_direction` | `inbound`, `outbound` |
| `message_kind` | `text`, `voice`, `image`, `button_reply`, `buttons`, `template` |
| `preference_scope` | `caption`, `design`, `schedule`, `general` |
| `model_task` | Model task names from [contracts.md](contracts.md) |
| `console_item_kind` | `model_validation_failed`, `extraction_failed`, `draft_failed`, `publication_failed`, `channel_disconnected`, `unknown_number`, `handoff` |
| `console_item_status` | `open`, `resolved` |

## Tables

### `business`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid | Primary key; RLS compares this column instead of `business_id` |
| `status` | `business_status` | Default `onboarding` |
| `name` | text | |
| `profile` | jsonb | `BusinessProfile` while active; `BusinessProfileDraft` during onboarding |
| `style` | `visual_style` | Null until chosen |
| `approver_phone` | text | Unique; the only number whose approvals count |
| `timezone` | text | Default `Asia/Jerusalem` |
| `cancelled_at` | timestamptz | Null unless cancelled |
| `data_delete_after` | timestamptz | Set on cancellation |

### `channel_connection`

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | References `business` |
| `network` | `network` | Unique together with `business_id` |
| `provider` | text | Publishing provider name, such as `zernio` |
| `provider_account_id` | text | Null until connected |
| `status` | `channel_connection_status` | Default `pending` |
| `verified_at` | timestamptz | |
| `last_health_check_at` | timestamptz | |

### `conversation_state`

One row per business; `business_id` is the primary key.

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | Primary key, references `business` |
| `step` | `conversation_step` | Default `intro` |
| `open_question` | jsonb | `OpenQuestion` or null |
| `handoff_at` | timestamptz | Set while a person handles the conversation |
| `last_inbound_at` | timestamptz | Start of the WhatsApp 24-hour window |

### `message`

Every inbound and outbound WhatsApp message, for deduplication, the 24-hour window, and the console.

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | Null for unknown numbers |
| `direction` | `message_direction` | |
| `kind` | `message_kind` | |
| `provider` | text | Messaging provider name |
| `provider_message_id` | text | Unique together with `provider`; duplicates are dropped |
| `from_phone` | text | |
| `to_phone` | text | |
| `body` | text | Text, transcript, or template name |
| `payload` | jsonb | Button payload or template variables |
| `media_asset_ids` | uuid[] | |
| `processed_at` | timestamptz | Null until the workflow consumed it |

### `media_asset`

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | |
| `kind` | `media_kind` | |
| `source` | `media_source` | |
| `storage_path` | text | Cloud Storage object path; stable until publishing |
| `mime_type` | text | |
| `width`, `height` | integer | Null for voice |
| `sha256` | text | |
| `retain_until` | timestamptz | Per the media retention policy |

### `preference_rule`

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | |
| `scope` | `preference_scope` | |
| `rule` | text | The rule as applied in prompts |
| `source_message_id` | uuid | The correction it came from |
| `source_post_version_id` | uuid | Null if not tied to a draft |
| `active` | boolean | Default true |

### `weekly_update`

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | |
| `week_start` | date | Unique together with `business_id` |
| `status` | `weekly_update_status` | Default `awaiting` |
| `original_text` | text | Merged text of the update messages |
| `transcript` | text | From voice messages |
| `media_asset_ids` | uuid[] | |
| `extracted_facts` | jsonb | `FactExtractionOutput` |
| `reminder_sent_at` | timestamptz | |
| `received_at` | timestamptz | |

### `post`

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | |
| `weekly_update_id` | uuid | References `weekly_update` |
| `position` | integer | Order within the week |
| `status` | `post_status` | Default `planned` |
| `format` | `post_format` | |
| `plan` | jsonb | `PlannedPost` |
| `current_version_id` | uuid | Latest `post_version`; null until drafted |

### `post_version`

Immutable once written. A change creates a new version.

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | |
| `post_id` | uuid | References `post` |
| `version_number` | integer | Unique together with `post_id` |
| `captions` | jsonb | `ChannelCaptions` |
| `rendered_media` | jsonb | `RenderedMedia`: asset ids per network |
| `fact_sources` | jsonb | `FactSource[]`: each factual detail and where it came from |
| `fact_check_passed` | boolean | Drafts are sent only when true |
| `content_hash` | text | SHA-256 over captions, rendered media, and format |

### `approval`

Immutable except for `invalidated_at`.

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | |
| `post_id` | uuid | |
| `post_version_id` | uuid | |
| `approved_version_hash` | text | Must equal the version's `content_hash` |
| `approver_phone` | text | Must equal `business.approver_phone` at approval time |
| `message_id` | uuid | The button reply; unique, so a tap is never counted twice |
| `approved_at` | timestamptz | |
| `invalidated_at` | timestamptz | Set when a newer version or a change request supersedes it |

### `publication`

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | |
| `post_id` | uuid | |
| `approval_id` | uuid | Not null; unique together with `network` |
| `approved_version_hash` | text | Copied from the approval; checked again by the publishing job |
| `channel_connection_id` | uuid | |
| `network` | `network` | |
| `scheduled_for` | timestamptz | |
| `status` | `publication_status` | Default `scheduled` |
| `provider_post_id` | text | |
| `attempts` | integer | Default 0 |
| `last_error` | text | |
| `published_at` | timestamptz | |

### `subscription`

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | Unique |
| `plan` | text | |
| `status` | `subscription_status` | Default `trialing` |
| `provider` | text | `placeholder` in Phase 1 |
| `provider_customer_id` | text | |
| `provider_subscription_id` | text | |
| `trial_ends_at` | timestamptz | |
| `current_period_end` | timestamptz | |

Payment card details are never stored.

### `model_run`

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | Null for example-set runs |
| `task` | `model_task` | |
| `prompt_version` | integer | |
| `provider` | text | |
| `model` | text | |
| `attempt` | integer | Retry number, starting at 1 |
| `input` | jsonb | Task input |
| `output` | jsonb | Raw output |
| `valid` | boolean | Whether output passed the task schema |
| `error` | text | |
| `input_tokens`, `output_tokens` | integer | |
| `cost_usd` | numeric(10, 6) | |
| `duration_ms` | integer | |

### `console_item`

Work routed to a person: failed validation, failed publishing, unknown numbers, and handoffs.

| Column | Type | Notes |
| --- | --- | --- |
| `business_id` | uuid | Null for unknown numbers |
| `kind` | `console_item_kind` | |
| `status` | `console_item_status` | Default `open` |
| `reference_id` | uuid | Row the item is about |
| `details` | jsonb | |
| `resolved_at` | timestamptz | |

### System tables

`model_task_config`: one row per `model_task`, with `provider`, `model`, `fallback_provider`, `fallback_model`, `temperature`, `max_cost_usd`, `max_retries`, and `active_prompt_version`.

`prompt_template`: `task`, `version`, and `template`, unique on `task` and `version`. Versions are immutable.

`system_control`: a single row (`id` is always 1) with `publishing_paused`, `paused_reason`, `paused_at`, and `paused_by`. This is the global pause.
