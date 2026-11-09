-- Hand-written (WP-101, 2026-11-07): cancellation never deletes data (the human's "Keep, archive it").
-- database-schema.md, business, erasure_request and Least privilege; state-machines.md, Business.
-- H4: a migration with a new enum value, a renamed column, a new table with RLS and new grants.
--
-- 1. business_status gets 'archived' (the ARCHIVE transition from cancelled). Nothing in this
--    migration uses the new value, so adding it inside the migration transaction is safe.
-- 2. data_delete_after becomes archive_after; the column keeps its grants (app_sys_console's
--    column UPDATE from 0013). archived_at is new, and the console gets UPDATE on it, keeping the
--    "every column except id" rule on business.
-- 3. erasure_request: one row per erasure on the owner's request. business_id has no foreign key, so
--    the record stays after the business row and its cascade are gone. FORCE RLS with the same
--    tenant_isolation policy; append-only: app_deletion inserts, app_sys_console reads, nobody updates
--    or deletes.
ALTER TYPE "public"."business_status" ADD VALUE 'archived';--> statement-breakpoint
ALTER TABLE "business" RENAME COLUMN "data_delete_after" TO "archive_after";--> statement-breakpoint
ALTER TABLE "business" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
GRANT UPDATE ("archived_at") ON "business" TO app_sys_console;--> statement-breakpoint
CREATE TABLE "erasure_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"channel" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "erasure_request" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "erasure_request" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "erasure_request" AS PERMISSIVE FOR ALL TO public USING ("erasure_request"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("erasure_request"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
GRANT INSERT ON "erasure_request" TO app_deletion;--> statement-breakpoint
GRANT SELECT ON "erasure_request" TO app_sys_console;
