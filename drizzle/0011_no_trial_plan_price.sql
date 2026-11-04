-- Hand-written (T1, 2026-11-04): database-schema.md, `subscription` and `plan_price`. No trial: the
-- subscription starts `pending` (a payment link sent, nothing paid). No deployed database ever stored
-- a subscription row, so renaming the enum value moves no data.
ALTER TYPE "public"."subscription_status" RENAME VALUE 'trialing' TO 'pending';--> statement-breakpoint
ALTER TABLE "subscription" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
-- A payment link that fails to send after activation opens a console item.
ALTER TYPE "public"."console_item_kind" ADD VALUE 'payment_link_failed';--> statement-breakpoint
ALTER TABLE "subscription" DROP COLUMN "trial_ends_at";--> statement-breakpoint
-- The monthly price, append-only: the rows are the history of changes and the newest row is the price.
CREATE TABLE "plan_price" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"plan" text NOT NULL,
	"amount_agorot" integer NOT NULL,
	"currency" text DEFAULT 'ILS' NOT NULL,
	"changed_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_price_positive" CHECK ("plan_price"."amount_agorot" > 0),
	CONSTRAINT "plan_price_currency" CHECK ("plan_price"."currency" = 'ILS')
);--> statement-breakpoint
CREATE INDEX "plan_price_plan_idx" ON "plan_price" USING btree ("plan","id");--> statement-breakpoint
INSERT INTO "plan_price" ("plan", "amount_agorot", "currency", "changed_by", "reason") VALUES ('basic', 30000, 'ILS', 'seed', 'T1: no trial, ILS 300 a month');--> statement-breakpoint
-- Grant matrix: billing reads the price, the console adds a row; no role updates or deletes one.
GRANT SELECT ON "plan_price" TO app_billing;--> statement-breakpoint
GRANT SELECT, INSERT ON "plan_price" TO app_sys_console;
