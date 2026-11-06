-- Hand-written (console redesign): the console's own log of the writes that change configuration or a
-- profile (database-schema.md, console_action; technical-design.md, Console (Phase 1)). H4: a database
-- migration with RLS and a new grant, queued for the human.
--
-- 1. console_action: one row per profile, agent cost cap, agent config or model task config write,
--    inserted by the console in the same transaction as the write, with the changed fields before and
--    after. business_id is null for system settings and references business with on delete cascade, so
--    a deleted business takes its profile history with it.
-- 2. FORCE RLS with the same tenant_isolation policy as every business table; the console bypasses it.
-- 3. Grants: append-only. Only app_sys_console may select and insert; no role may update or delete.
CREATE TABLE "console_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "console_action" ADD CONSTRAINT "console_action_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "console_action_created_idx" ON "console_action" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "console_action_business_created_idx" ON "console_action" USING btree ("business_id","created_at");--> statement-breakpoint
ALTER TABLE "console_action" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "console_action" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "console_action" AS PERMISSIVE FOR ALL TO public USING ("console_action"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("console_action"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT ON "console_action" TO app_sys_console;
