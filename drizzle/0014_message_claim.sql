-- Hand-written (T2): durable inbound bursts (technical-design.md, Onboarding flow; database-schema.md,
-- `message`). Messaging claims a sender's unprocessed messages before handing them over, so several
-- web instances, the inbound-burst job and the sweep never hand a message over twice. No grant change:
-- app_messaging already has UPDATE on "message".
ALTER TABLE "message" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
-- Arrival order: provider timestamps tie (WhatsApp's have second resolution). Existing rows are numbered too.
ALTER TABLE "message" ADD COLUMN "seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL;--> statement-breakpoint
CREATE INDEX "message_unprocessed_inbound_idx" ON "message" USING btree ("business_id","from_phone","created_at") WHERE "message"."direction" = 'inbound' and "message"."processed_at" is null;
