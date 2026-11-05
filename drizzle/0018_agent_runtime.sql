-- Hand-written (WP-90): the agent runtime's tables and settings (database-schema.md, agent_turn,
-- Other changes with the agent, System tables; agent.md, Runtime and Limits). No new login: the
-- agent module runs as app_workflow.
CREATE TYPE "public"."agent_name" AS ENUM('onboarding', 'weekly', 'drafts');--> statement-breakpoint
CREATE TYPE "public"."agent_turn_status" AS ENUM('running', 'done', 'waiting', 'handed_off', 'failed');--> statement-breakpoint
CREATE TYPE "public"."agent_turn_stop_reason" AS ENUM('done', 'waiting_for_owner', 'end_turn', 'handed_off', 'max_steps', 'max_tool_calls', 'turn_budget', 'daily_budget', 'global_budget', 'timeout', 'stuck', 'low_confidence', 'refusals', 'invalid_output');--> statement-breakpoint
-- Not used by any statement below, so ADD VALUE is safe inside the migration transaction.
ALTER TYPE "public"."console_item_kind" ADD VALUE 'agent_limit';--> statement-breakpoint
CREATE TABLE "agent_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"agent" "agent_name" NOT NULL,
	"status" "agent_turn_status" DEFAULT 'running' NOT NULL,
	"stop_reason" "agent_turn_stop_reason",
	"trigger" jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "agent_turn" ADD CONSTRAINT "agent_turn_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_turn_business_started_idx" ON "agent_turn" USING btree ("business_id","started_at");--> statement-breakpoint
ALTER TABLE "agent_turn" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_turn" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_turn" AS PERMISSIVE FOR ALL TO public USING ("agent_turn"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("agent_turn"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE TABLE "agent_config" (
	"agent" "agent_name" PRIMARY KEY NOT NULL,
	"max_steps" integer NOT NULL,
	"max_tool_calls" integer NOT NULL,
	"max_turn_cost_usd" numeric(10, 6) NOT NULL,
	"max_business_daily_cost_usd" numeric(10, 6) NOT NULL,
	"timeout_ms" integer NOT NULL,
	"min_confidence" real NOT NULL,
	"max_refusals" integer NOT NULL,
	"max_repeated_questions" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- The limits decided on 2026-11-05 (agent.md, A4): configuration, not code.
INSERT INTO "agent_config" ("agent", "max_steps", "max_tool_calls", "max_turn_cost_usd", "max_business_daily_cost_usd", "timeout_ms", "min_confidence", "max_refusals", "max_repeated_questions") VALUES
('onboarding', 12, 24, 0.06, 1.00, 90000, 0.4, 3, 3),
('weekly', 12, 24, 0.06, 1.00, 90000, 0.4, 3, 3),
('drafts', 12, 24, 0.06, 1.00, 90000, 0.4, 3, 3);--> statement-breakpoint
ALTER TABLE "model_run" ADD COLUMN "agent_turn_id" uuid;--> statement-breakpoint
ALTER TABLE "post_version" ADD COLUMN "design_spec" jsonb;--> statement-breakpoint
ALTER TABLE "business" ADD COLUMN "agent_flows" jsonb;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "agent_flows" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "agent_daily_cost_cap_usd" numeric(10, 6) DEFAULT '50' NOT NULL;--> statement-breakpoint
ALTER TABLE "system_control" ADD COLUMN "agent_name" jsonb DEFAULT '{"he": "פוסטלי", "en": "Postly", "ar": "Postly", "ru": "Postly"}'::jsonb NOT NULL;--> statement-breakpoint
-- Grants (database-schema.md, grant matrix): the agent module runs as app_workflow.
GRANT SELECT, INSERT, UPDATE ON "agent_turn" TO app_workflow;--> statement-breakpoint
GRANT SELECT ON "agent_turn" TO app_sys_console;--> statement-breakpoint
GRANT SELECT ON "agent_config" TO app_workflow;--> statement-breakpoint
GRANT SELECT, UPDATE ON "agent_config" TO app_sys_console;--> statement-breakpoint
GRANT SELECT ON "system_control" TO app_workflow;--> statement-breakpoint
-- The global daily cap sums every business's spend (agent.md, Limits).
GRANT SELECT ON "model_run" TO app_sys_scheduler;
--> statement-breakpoint
-- The console updates every business column except id (0013 lists them); the new column joins the list.
GRANT UPDATE ("agent_flows") ON "business" TO app_sys_console;
