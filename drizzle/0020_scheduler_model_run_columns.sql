-- The global daily cap (agent.md, Limits) sums model_run.cost_usd since 00:00 UTC across businesses.
-- The scheduler needs exactly those two columns, not every business's model inputs and outputs
-- (database-schema.md, grant matrix: S(cost_usd, created_at); review of #119, H4).
REVOKE SELECT ON "model_run" FROM app_sys_scheduler;--> statement-breakpoint
GRANT SELECT ("cost_usd", "created_at") ON "model_run" TO app_sys_scheduler;
