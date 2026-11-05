-- Hand-written (WP-46): database-schema.md, "workflow_event". The audit trail is append-only and keeps
-- business_id as a plain value (no foreign key), so its rows survive business deletion
-- (retention-checks.md). The roles that apply workflow events may only insert; console only reads.
CREATE TABLE "workflow_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"machine" text NOT NULL,
	"row_id" uuid NOT NULL,
	"event" text NOT NULL,
	"source" text NOT NULL,
	"role" text NOT NULL,
	"actor" text NOT NULL,
	"outcome" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"guard" text,
	"reason" text,
	"detail" text,
	"correlation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "workflow_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workflow_event" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "workflow_event" AS PERMISSIVE FOR ALL TO public USING ("workflow_event"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("workflow_event"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
GRANT INSERT ON "workflow_event" TO app_workflow, app_approval, app_publishing, app_billing;--> statement-breakpoint
GRANT SELECT ON "workflow_event" TO app_sys_console;
