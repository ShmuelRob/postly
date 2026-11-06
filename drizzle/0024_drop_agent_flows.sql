-- Hand-written (2026-11-06): the agents always run (agent.md, Running on dev). The onboarding, weekly
-- and drafts flows are no longer switched per business or globally, so the switch columns that 0018
-- added go. Dropping business.agent_flows also drops its column grant (UPDATE to app_sys_console, 0018).
-- Nothing else reads them; the one-shot flows remain only in test compositions until A9's cleanup.
ALTER TABLE "business" DROP COLUMN "agent_flows";--> statement-breakpoint
ALTER TABLE "system_control" DROP COLUMN "agent_flows";
