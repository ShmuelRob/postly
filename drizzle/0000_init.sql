-- Hand-written (WP-20): roles from database-schema.md, "Tenant isolation". They must exist before
-- the policies below. Each is its own login (passwords are set outside migrations); neither owns
-- the tables or is a member of the other, so a transaction cannot switch roles. The migration
-- role owns the tables, and FORCE ROW LEVEL SECURITY (0002) keeps RLS on even for it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system LOGIN BYPASSRLS NOINHERIT;
  END IF;
END
$$;--> statement-breakpoint
CREATE TYPE "public"."business_status" AS ENUM('onboarding', 'active', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."channel_connection_status" AS ENUM('pending', 'connected', 'verified', 'disconnected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."console_item_kind" AS ENUM('model_validation_failed', 'extraction_failed', 'draft_failed', 'publication_failed', 'channel_disconnected', 'unknown_number', 'handoff');--> statement-breakpoint
CREATE TYPE "public"."console_item_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."conversation_step" AS ENUM('intro', 'profile_questions', 'brand_assets', 'style_selection', 'profile_review', 'channel_connection', 'channel_test', 'completed', 'idle', 'processing_update', 'awaiting_answer', 'reviewing_drafts', 'confirming_schedule');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('logo', 'photo', 'voice', 'rendered');--> statement-breakpoint
CREATE TYPE "public"."media_source" AS ENUM('owner', 'library', 'render');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'voice', 'image', 'button_reply', 'buttons', 'template');--> statement-breakpoint
CREATE TYPE "public"."model_task" AS ENUM('intent_detection', 'transcription', 'profile_extraction', 'fact_extraction', 'weekly_planning', 'caption_writing', 'change_interpretation', 'image_review', 'fact_check');--> statement-breakpoint
CREATE TYPE "public"."network" AS ENUM('instagram', 'facebook');--> statement-breakpoint
CREATE TYPE "public"."post_format" AS ENUM('single', 'carousel');--> statement-breakpoint
CREATE TYPE "public"."post_status" AS ENUM('planned', 'drafting', 'awaiting_clarification', 'awaiting_approval', 'needs_review', 'approved', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."preference_scope" AS ENUM('caption', 'design', 'schedule', 'general');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('scheduled', 'in_progress', 'retry_pending', 'published', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."visual_style" AS ENUM('clean', 'warm', 'dynamic');--> statement-breakpoint
CREATE TYPE "public"."weekly_update_status" AS ENUM('awaiting', 'reminded', 'received', 'needs_review', 'planned', 'skipped');--> statement-breakpoint
CREATE TABLE "approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"post_version_id" uuid NOT NULL,
	"approved_version_hash" text NOT NULL,
	"approver_phone" text NOT NULL,
	"message_id" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
ALTER TABLE "approval" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "business" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "business_status" DEFAULT 'onboarding' NOT NULL,
	"name" text NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"style" "visual_style",
	"approver_phone" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Jerusalem' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"data_delete_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_approver_phone_unique" UNIQUE("approver_phone")
);
--> statement-breakpoint
ALTER TABLE "business" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "channel_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"network" "network" NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text,
	"status" "channel_connection_status" DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_health_check_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_connection_business_id_network_unique" UNIQUE("business_id","network")
);
--> statement-breakpoint
ALTER TABLE "channel_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "console_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"kind" "console_item_kind" NOT NULL,
	"status" "console_item_status" DEFAULT 'open' NOT NULL,
	"reference_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "console_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversation_state" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"step" "conversation_step" DEFAULT 'intro' NOT NULL,
	"open_question" jsonb,
	"handoff_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "media_asset" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" "media_kind" NOT NULL,
	"source" "media_source" NOT NULL,
	"storage_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"retain_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_asset" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text NOT NULL,
	"from_phone" text NOT NULL,
	"to_phone" text NOT NULL,
	"body" text,
	"payload" jsonb,
	"media_asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_provider_provider_message_id_unique" UNIQUE("provider","provider_message_id")
);
--> statement-breakpoint
ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "model_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid,
	"task" "model_task" NOT NULL,
	"prompt_version" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"valid" boolean NOT NULL,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(10, 6),
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_run" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "model_task_config" (
	"task" "model_task" PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"fallback_provider" text,
	"fallback_model" text,
	"temperature" real NOT NULL,
	"max_cost_usd" numeric(10, 6) NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"active_prompt_version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"weekly_update_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" "post_status" DEFAULT 'planned' NOT NULL,
	"format" "post_format" NOT NULL,
	"plan" jsonb NOT NULL,
	"current_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "post_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"captions" jsonb NOT NULL,
	"rendered_media" jsonb NOT NULL,
	"fact_sources" jsonb NOT NULL,
	"fact_check_passed" boolean NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_version_post_id_version_number_unique" UNIQUE("post_id","version_number")
);
--> statement-breakpoint
ALTER TABLE "post_version" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "preference_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"scope" "preference_scope" NOT NULL,
	"rule" text NOT NULL,
	"source_message_id" uuid,
	"source_post_version_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "preference_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "prompt_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" "model_task" NOT NULL,
	"version" integer NOT NULL,
	"template" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_template_task_version_unique" UNIQUE("task","version")
);
--> statement-breakpoint
CREATE TABLE "publication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"approval_id" uuid NOT NULL,
	"approved_version_hash" text NOT NULL,
	"channel_connection_id" uuid NOT NULL,
	"network" "network" NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "publication_status" DEFAULT 'scheduled' NOT NULL,
	"provider_post_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_approval_id_network_unique" UNIQUE("approval_id","network")
);
--> statement-breakpoint
ALTER TABLE "publication" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_business_id_unique" UNIQUE("business_id")
);
--> statement-breakpoint
ALTER TABLE "subscription" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "system_control" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"publishing_paused" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"paused_at" timestamp with time zone,
	"paused_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_control_single_row" CHECK ("system_control"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "weekly_update" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"week_start" date NOT NULL,
	"status" "weekly_update_status" DEFAULT 'awaiting' NOT NULL,
	"original_text" text,
	"transcript" text,
	"media_asset_ids" uuid[] DEFAULT '{}' NOT NULL,
	"extracted_facts" jsonb,
	"reminder_sent_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weekly_update_business_id_week_start_unique" UNIQUE("business_id","week_start")
);
--> statement-breakpoint
ALTER TABLE "weekly_update" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_post_version_id_post_version_id_fk" FOREIGN KEY ("post_version_id") REFERENCES "public"."post_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_connection" ADD CONSTRAINT "channel_connection_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "console_item" ADD CONSTRAINT "console_item_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_state" ADD CONSTRAINT "conversation_state_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_asset" ADD CONSTRAINT "media_asset_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_run" ADD CONSTRAINT "model_run_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_weekly_update_id_weekly_update_id_fk" FOREIGN KEY ("weekly_update_id") REFERENCES "public"."weekly_update"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post" ADD CONSTRAINT "post_current_version_id_post_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."post_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_version" ADD CONSTRAINT "post_version_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_version" ADD CONSTRAINT "post_version_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_rule" ADD CONSTRAINT "preference_rule_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_rule" ADD CONSTRAINT "preference_rule_source_message_id_message_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_rule" ADD CONSTRAINT "preference_rule_source_post_version_id_post_version_id_fk" FOREIGN KEY ("source_post_version_id") REFERENCES "public"."post_version"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_approval_id_approval_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approval"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication" ADD CONSTRAINT "publication_channel_connection_id_channel_connection_id_fk" FOREIGN KEY ("channel_connection_id") REFERENCES "public"."channel_connection"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_update" ADD CONSTRAINT "weekly_update_business_id_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."business"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approval" AS PERMISSIVE FOR ALL TO "app_user" USING ("approval"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("approval"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "business" AS PERMISSIVE FOR ALL TO "app_user" USING ("business"."id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("business"."id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "channel_connection" AS PERMISSIVE FOR ALL TO "app_user" USING ("channel_connection"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("channel_connection"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "console_item" AS PERMISSIVE FOR ALL TO "app_user" USING ("console_item"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("console_item"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversation_state" AS PERMISSIVE FOR ALL TO "app_user" USING ("conversation_state"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("conversation_state"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "media_asset" AS PERMISSIVE FOR ALL TO "app_user" USING ("media_asset"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("media_asset"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "message" AS PERMISSIVE FOR ALL TO "app_user" USING ("message"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("message"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "model_run" AS PERMISSIVE FOR ALL TO "app_user" USING ("model_run"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("model_run"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "post" AS PERMISSIVE FOR ALL TO "app_user" USING ("post"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("post"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "post_version" AS PERMISSIVE FOR ALL TO "app_user" USING ("post_version"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("post_version"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "preference_rule" AS PERMISSIVE FOR ALL TO "app_user" USING ("preference_rule"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("preference_rule"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "publication" AS PERMISSIVE FOR ALL TO "app_user" USING ("publication"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("publication"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "subscription" AS PERMISSIVE FOR ALL TO "app_user" USING ("subscription"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("subscription"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "weekly_update" AS PERMISSIVE FOR ALL TO "app_user" USING ("weekly_update"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid) WITH CHECK ("weekly_update"."business_id" = nullif(current_setting('app.business_id', true), '')::uuid);