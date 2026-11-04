-- Hand-written (T11, security.md D5 and D6): database-schema.md, "Least privilege".
-- 1. The console login bypasses RLS, so on business-owned tables it may update every column except
--    id and business_id: no console write can move a row to another business or re-key it.
REVOKE UPDATE ON "business", "channel_connection", "conversation_state", "post", "publication", "console_item" FROM app_sys_console;--> statement-breakpoint
GRANT UPDATE ("status", "name", "profile", "style", "approver_phone", "timezone", "cancelled_at", "data_delete_after", "created_at", "updated_at") ON "business" TO app_sys_console;--> statement-breakpoint
GRANT UPDATE ("network", "provider", "provider_account_id", "status", "verified_at", "last_health_check_at", "created_at", "updated_at") ON "channel_connection" TO app_sys_console;--> statement-breakpoint
GRANT UPDATE ("step", "open_question", "handoff_at", "last_inbound_at", "created_at", "updated_at") ON "conversation_state" TO app_sys_console;--> statement-breakpoint
GRANT UPDATE ("weekly_update_id", "position", "status", "format", "plan", "current_version_id", "created_at", "updated_at") ON "post" TO app_sys_console;--> statement-breakpoint
GRANT UPDATE ("post_id", "approval_id", "approved_version_hash", "channel_connection_id", "network", "scheduled_for", "status", "provider_post_id", "attempts", "last_error", "published_at", "created_at", "updated_at") ON "publication" TO app_sys_console;--> statement-breakpoint
GRANT UPDATE ("kind", "status", "reference_id", "details", "resolved_at", "created_at", "updated_at") ON "console_item" TO app_sys_console;--> statement-breakpoint
-- 2. CREATE ROLE ... IF NOT EXISTS keeps the attributes of a role that already existed; set them
--    again. BYPASSRLS only for the system logins. SUPERUSER and REPLICATION need a real superuser to
--    change, which the Cloud SQL admin is not, and it cannot grant them either.
ALTER ROLE app_messaging LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_workflow LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_content LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_design LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_approval LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_publishing LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_model LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_billing LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_business_data LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_deletion LOGIN NOINHERIT NOCREATEROLE NOCREATEDB NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE app_sys_phone_lookup LOGIN NOINHERIT NOCREATEROLE NOCREATEDB BYPASSRLS;--> statement-breakpoint
ALTER ROLE app_sys_scheduler LOGIN NOINHERIT NOCREATEROLE NOCREATEDB BYPASSRLS;--> statement-breakpoint
ALTER ROLE app_sys_console LOGIN NOINHERIT NOCREATEROLE NOCREATEDB BYPASSRLS;--> statement-breakpoint
ALTER ROLE app_sys_example_set LOGIN NOINHERIT NOCREATEROLE NOCREATEDB BYPASSRLS;
