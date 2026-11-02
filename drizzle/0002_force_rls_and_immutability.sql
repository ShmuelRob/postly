-- Hand-written (WP-20): RLS applies to the table owner too, so only app_system bypasses it.
ALTER TABLE "approval" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_connection" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "console_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversation_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_asset" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_run" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "post_version" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "preference_rule" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publication" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscription" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "weekly_update" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- post_version is immutable, and approval is immutable except for invalidated_at
-- (database-schema.md). app_user may only insert them, and set approval.invalidated_at.
REVOKE UPDATE, DELETE ON "post_version", "approval" FROM app_user;--> statement-breakpoint
GRANT UPDATE ("invalidated_at") ON "approval" TO app_user;
