-- Hand-written (T16, 2026-11-05): database-schema.md, `subscription`. The billing hold's state: the
-- grace period's start, the reminders sent in it, and when billing paused the business. No grant
-- changes: app_billing already reads, inserts and updates `subscription`.
ALTER TABLE "subscription" ADD COLUMN "grace_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "reminders_sent" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "held_at" timestamp with time zone;
