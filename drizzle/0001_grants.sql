-- Hand-written (WP-20): table privileges for the roles in database-schema.md, "Tenant isolation".
-- RLS decides which rows app_user sees; these grants decide which tables it may touch at all.
GRANT USAGE ON SCHEMA public TO app_user, app_system;--> statement-breakpoint
-- app_user: business-owned tables (and business), every row filtered by the tenant_isolation policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "business", "channel_connection", "conversation_state", "message", "media_asset", "preference_rule",
  "weekly_update", "post", "post_version", "approval", "publication", "subscription", "model_run",
  "console_item"
TO app_user;--> statement-breakpoint
-- app_user: system tables, read-only, for the model layer and the publishing job.
GRANT SELECT ON "model_task_config", "prompt_template", "system_control" TO app_user;--> statement-breakpoint
-- app_system: bypasses RLS; phone lookup, scheduler fan-out, console, example-set runner.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_system;
