-- Hand-written (WP-89): the three agent model tasks (contracts.md, Agent; agent.md, A8).
--
-- drizzle applies all pending migrations in one transaction, and a value added with
-- ALTER TYPE ... ADD VALUE cannot be used before that transaction commits. So the enum is
-- recreated with the new values instead (a type created in the transaction can be used at once),
-- and the three columns are moved to it. The old values keep their names and order.
ALTER TYPE "public"."model_task" RENAME TO "model_task_before_agent";--> statement-breakpoint
CREATE TYPE "public"."model_task" AS ENUM('intent_detection', 'transcription', 'profile_extraction', 'fact_extraction', 'weekly_planning', 'caption_writing', 'change_interpretation', 'image_review', 'fact_check', 'agent_onboarding', 'agent_weekly', 'agent_drafts');--> statement-breakpoint
ALTER TABLE "model_run" ALTER COLUMN "task" TYPE "public"."model_task" USING "task"::text::"public"."model_task";--> statement-breakpoint
ALTER TABLE "model_task_config" ALTER COLUMN "task" TYPE "public"."model_task" USING "task"::text::"public"."model_task";--> statement-breakpoint
ALTER TABLE "prompt_template" ALTER COLUMN "task" TYPE "public"."model_task" USING "task"::text::"public"."model_task";--> statement-breakpoint
DROP TYPE "public"."model_task_before_agent";--> statement-breakpoint
-- PLACEHOLDER prompts, version 1. They are not the agents' prompts: each agent package (WP-92 to
-- WP-94) adds its real prompt as version 2 and makes it active, queued under H7. Until then no flow
-- calls these tasks (agent_flows is off), and if one did, the placeholder only hands off.
INSERT INTO "prompt_template" ("task", "version", "template") VALUES
('agent_onboarding', 1, $p$Placeholder (WP-89): the onboarding agent's prompt is not written yet. Return exactly one step: one call to hand_off_to_console with reason "unclear" and the note "agent prompt not written yet", and confidence 1. Do nothing else.$p$),
('agent_weekly', 1, $p$Placeholder (WP-89): the weekly-update agent's prompt is not written yet. Return exactly one step: one call to hand_off_to_console with reason "unclear" and the note "agent prompt not written yet", and confidence 1. Do nothing else.$p$),
('agent_drafts', 1, $p$Placeholder (WP-89): the drafts agent's prompt is not written yet. Return exactly one step: one call to hand_off_to_console with reason "unclear" and the note "agent prompt not written yet", and confidence 1. Do nothing else.$p$);--> statement-breakpoint
-- Gemini Flash Lite for all three agents (agent.md, A8, decided 2026-11-05). A step's cost cap stays
-- under the turn budget (USD 0.06, A4); 2 retries means 3 attempts in total, like every task.
INSERT INTO "model_task_config" ("task", "provider", "model", "temperature", "max_cost_usd", "max_retries", "active_prompt_version") VALUES
('agent_onboarding', 'google', 'gemini-2.5-flash-lite', 0.2, 0.02, 2, 1),
('agent_weekly', 'google', 'gemini-2.5-flash-lite', 0.2, 0.02, 2, 1),
('agent_drafts', 'google', 'gemini-2.5-flash-lite', 0.2, 0.02, 2, 1);
