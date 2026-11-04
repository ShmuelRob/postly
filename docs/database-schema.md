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

- A table is **business-owned** when it has a `business_id` column. Every business-owned table, and `business` itself, has RLS enabled and forced (`FORCE ROW LEVEL SECURITY`) with a `tenant_isolation` policy for `public`: a row is visible and writable only when its business matches `current_setting('app.business_id')`. Only the system roles below bypass it.
- The application sets `app.business_id` with `set_config(..., true)` at the start of each transaction. A query without a business context sees no rows and cannot write any.
- Rows with a null `business_id` (messages from unknown numbers, example-set model runs, console items about unknown numbers) are visible only to system roles.
- Tables without `business_id` are system tables (`model_task_config`, `prompt_template`, `system_control`, `plan_price`).

### Least privilege

Every kind of operation has its own database role (decided 2026-11-03, built in WP-24). Each role is its own login with its own password and its own connection pool. No role is a member of another or owns any table, so no statement inside a transaction can switch to a different role. A separate migration role owns the tables. A role reaches only the tables and verbs in the matrix below; everything else is `permission denied`. There are no default privileges, so a new table is closed to every role until its migration grants it, and every new business-owned table also needs `FORCE ROW LEVEL SECURITY`.

**Business roles** (subject to RLS; opened with `withBusiness(role, businessId, fn)`):

| Role | Login | Module | Used for |
| --- | --- | --- | --- |
| `messaging` | `app_messaging` | Messaging | Storing inbound and outbound messages and their media, the 24-hour window |
| `workflow` | `app_workflow` | Workflow | Creating a business, onboarding and conversation steps, weekly updates, post states, handoffs |
| `content` | `app_content` | Content | Weekly planning results, captions, and new post versions |
| `design` | `app_design` | Design | Reading post versions and storing rendered media |
| `approval` | `app_approval` | Workflow (approval path) | Recording approvals and invalidating them |
| `publishing` | `app_publishing` | Publishing | Channel connections, publications, and the publishing job |
| `model` | `app_model` | Model layer | Model settings, prompt versions, `model_run` records, console routing |
| `billing` | `app_billing` | Billing | Subscriptions |
| `business_data` | `app_business_data` | Business data | Profile edits, preference rules, the media library, post history |
| `deletion` | `app_deletion` | Business data (data deletion) | Deleting a cancelled business past `data_delete_after` (WP-43): reads its media paths and deletes its `business` row; the cascade removes the rest |

**System roles** (bypass RLS; opened with `withSystem(purpose, fn)`, one per purpose):

| Purpose | Login | Used for |
| --- | --- | --- |
| `phone_lookup` | `app_sys_phone_lookup` | Resolving an inbound number to a business; storing messages and console items from unknown numbers; finding inbound messages never processed (the messaging sweep, WP-30) |
| `scheduler` | `app_sys_scheduler` | Finding the businesses and rows due for a job, then fanning jobs out per business |
| `console` | `app_sys_console` | The team console: reading everything, resolving items, handoffs, retries and manual scheduling (a publication still publishes only when the publishing job's hash check passes), pauses, model settings. The human-owned H5 tests use it to force states |
| `example_set` | `app_sys_example_set` | Example-set runs, whose `model_run` rows have no business |

**Grant matrix.** `S` select, `I` insert, `U` update, `D` delete; `U(col, ...)` is an update of those columns only. `U(-col, ...)` is an update of every column except those. A blank cell is no access. The contract test `src/db/least-privilege.db.test.ts` copies this table.

| Table | messaging | workflow | content | design | approval | publishing | model | billing | business_data | deletion | phone_lookup | scheduler | console | example_set |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `business` | S | SIU | S | S | S | S |  | S | SU | SD | S | S | S U(-id) |  |
| `channel_connection` |  | S |  |  |  | SIU |  |  | S |  |  | S | S U(-id, -business_id) |  |
| `conversation_state` | SU | SIU |  |  |  |  |  |  |  |  |  |  | SI U(-business_id) |  |
| `message` | SIU | S | S |  | S |  |  |  |  |  | SI |  | S |  |
| `media_asset` | SI |  | S | SI |  | S |  |  | SIUD | S |  |  | S |  |
| `preference_rule` |  |  | S |  |  |  |  |  | SIUD |  |  |  | S |  |
| `weekly_update` |  | SIU | SU |  |  |  |  |  |  |  |  | S | S |  |
| `post` |  | SIU | SU | S | S U(status, updated_at) | SU |  |  | S |  |  | S | S U(-id, -business_id) |  |
| `post_version` |  |  | SI | S | S | S |  |  | S |  |  |  | S |  |
| `approval` |  |  |  |  | SI U(invalidated_at) | S |  |  |  |  |  |  | S |  |
| `publication` |  |  |  |  |  | SIU |  |  | S |  |  | S | SI U(-id, -business_id) |  |
| `subscription` |  |  |  |  |  |  |  | SIU |  |  |  | S | S |  |
| `model_run` |  |  |  |  |  |  | SI |  |  |  |  |  | S | SI |
| `console_item` |  | SI |  |  |  | SI | SI |  |  |  | SI |  | SI U(-id, -business_id) |  |
| `model_task_config` |  |  |  |  |  |  | S |  |  |  |  |  | SU | S |
| `prompt_template` |  |  |  |  |  |  | S |  |  |  |  |  | SI | S |
| `system_control` |  |  |  |  |  | S |  |  |  |  |  | S | SIU |  |
| `plan_price` |  |  |  |  |  |  |  | S |  |  |  |  | SI |  |

- **No temporary tables:** `TEMPORARY` on the database is revoked from `PUBLIC` and from every login. A temporary table outlives its transaction on a pooled connection and shadows the real table of the same name (`pg_temp` comes first in the search path), so one business's later writes could land in a table another business reads. No role can create one.
- **Immutability:** no role may update or delete `post_version`, and the only update on `approval` is `invalidated_at`, by the `approval` role. The `approval` role may change only a post's `status` and `updated_at`.
- **Console updates by column:** the `console` login bypasses RLS, so on business-owned tables it gets `UPDATE` on every column except `id` and `business_id` (on `business`, except `id`). A console write, a bug or a crafted call cannot move a row to another business or re-key it; Postgres refuses the statement (T11, security.md D5). `model_task_config` and `system_control` hold no business data and keep a table-wide `UPDATE`. A new column on these tables needs its own console grant in the migration that adds it.
- **Role attributes:** each migration that creates a login with `CREATE ROLE ... IF NOT EXISTS` is followed by an `ALTER ROLE` that sets its attributes again: `LOGIN NOINHERIT NOCREATEROLE NOCREATEDB`, plus `BYPASSRLS` for the system logins and `NOBYPASSRLS` for the rest. A login that already existed (made by hand or by an older migration) cannot keep stronger attributes (T11, security.md D6). `SUPERUSER` and `REPLICATION` are not named: only a real superuser may set them, which the Cloud SQL admin is not, and that admin cannot grant them either.
- **Deletes:** `business_data` deletes only preference rules and media. The `deletion` role deletes only `business` rows, and its code deletes only a `cancelled` business past `data_delete_after` (the condition is in the `delete` itself). Every business-owned table references `business` with `on delete cascade`, and the cascade runs with the table owner's rights, so it also removes `post_version` and `approval` rows, which no role may delete directly (WP-43).
- **Creating a business:** `workflow` inserts the `business` row inside `withBusiness('workflow', newId, ...)`, so RLS checks the new row against the new id. No system role inserts businesses.
- A module that needs a table or verb its role lacks changes this matrix first (docs first), then a new migration.

### In code

`createDatabase(urls)` in `src/db/index.ts` takes one connection string per login, `urls.business[role]` and `urls.system[purpose]`, and opens each pool on first use. `withBusiness(role, businessId, fn)` runs `fn` in one transaction on that role's login with `app.business_id` set. `withSystem(purpose, fn)` runs it on that purpose's system login. An unknown role or purpose is rejected before any connection is made. `createDatabase` refuses to start unless every role and purpose has a URL whose user name is `loginFor(role)`, so a missing URL never falls back to the `PG*` environment variables or to another login. Each pool holds at most 3 connections by default. No other way to query leaves `src/db/`. `loginFor(roleOrPurpose)` gives the login name, for deployment and test setup.

### Same-business references

Every foreign key from a business-owned table to another business-owned table is composite, `(business_id, <ref>_id)` referencing `(business_id, id)` (decided 2026-11-03, built in WP-24 before WP-33), so a row can only reference a parent of its own business. Postgres checks foreign keys without RLS, so with single-column keys a business could point its own approval at another business's post version, and probe whether an id exists. The composite key refuses both. Each referenced table has a `unique (business_id, id)` constraint for this.

| From | Columns | To |
| --- | --- | --- |
| `post` | `business_id, weekly_update_id` | `weekly_update` |
| `post` | `business_id, current_version_id` | `post_version` |
| `post_version` | `business_id, post_id` | `post` (on delete cascade) |
| `preference_rule` | `business_id, source_message_id` | `message` |
| `preference_rule` | `business_id, source_post_version_id` | `post_version` |
| `approval` | `business_id, post_id` | `post` |
| `approval` | `business_id, post_version_id` | `post_version` |
| `approval` | `business_id, message_id` | `message` |
| `publication` | `business_id, post_id` | `post` |
| `publication` | `business_id, approval_id` | `approval` |
| `publication` | `business_id, channel_connection_id` | `channel_connection` |

Nullable reference columns use the default `MATCH SIMPLE`: a null reference is not checked, and a set one must belong to the same business. `message.business_id` is nullable, but every table that references `message` has a non-null `business_id`, so a reference to an unknown-number message is refused. Uuid arrays (`media_asset_ids`) and `console_item.reference_id` are not foreign keys; code reads them through RLS.

### Accepted risk

Postgres cannot stop a role from changing its own custom settings, so SQL run through the transaction handle could call `set_config('app.business_id', ...)` with another business. The CI guard `src/db/raw-sql-guard.test.ts` therefore fails on `set role`, `set local`, `set session`, `set app.*`, `reset`, `set_config`, `discard`, and `create temp`/`create temporary` anywhere outside `src/db/`. Switching role is impossible regardless, since no login is a member of another role.

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
| `data_delete_after` | timestamptz | Set on cancellation: `cancelled_at` plus the retention period (30 days by default); the data deletion job deletes the business after it |

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
| `content_hash` | text | SHA-256 over captions, rendered media, and format: the canonical JSON (keys sorted) of `{ format, captions, renderedMedia }` (WP-32) |

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
| `status` | `subscription_status` | Default `pending` (link sent, not paid) |
| `provider` | text | `placeholder` in Phase 1 |
| `provider_customer_id` | text | |
| `provider_subscription_id` | text | |
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

`plan_price`: the monthly price of each plan, append-only, so the rows are the history of changes (T1, 2026-11-04). Columns: `id` (identity), `plan` (text), `amount_agorot` (integer, greater than 0), `currency` (text, `ILS`), `changed_by` (text), `reason` (text, nullable), `created_at`. The current price of a plan is its row with the highest `id`. The migration seeds `basic` at 30000 agorot (ILS 300) by `seed`. The console inserts a new row to change the price; no role may update or delete a row. Billing reads the current price when it creates a payment link. Migration `0011_no_trial_plan_price` also renames the `subscription_status` value `trialing` to `pending` and drops `subscription.trial_ends_at` (no row was ever stored in a deployed database).
