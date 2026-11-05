-- Hand-written (WP-24): least privilege from database-schema.md, "Least privilege". One login per
-- role; no login owns a table or is a member of another role, so no transaction can switch roles.
-- Only the system roles bypass RLS. Passwords are set outside migrations. The grants below are the
-- grant matrix in that doc, generated from it; src/db/least-privilege.db.test.ts checks every cell.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_messaging') THEN
    CREATE ROLE app_messaging LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_workflow') THEN
    CREATE ROLE app_workflow LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_content') THEN
    CREATE ROLE app_content LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_design') THEN
    CREATE ROLE app_design LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_approval') THEN
    CREATE ROLE app_approval LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_publishing') THEN
    CREATE ROLE app_publishing LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_model') THEN
    CREATE ROLE app_model LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_billing') THEN
    CREATE ROLE app_billing LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_business_data') THEN
    CREATE ROLE app_business_data LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_sys_phone_lookup') THEN
    CREATE ROLE app_sys_phone_lookup LOGIN BYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_sys_scheduler') THEN
    CREATE ROLE app_sys_scheduler LOGIN BYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_sys_console') THEN
    CREATE ROLE app_sys_console LOGIN BYPASSRLS NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_sys_example_set') THEN
    CREATE ROLE app_sys_example_set LOGIN BYPASSRLS NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_messaging, app_workflow, app_content, app_design, app_approval, app_publishing, app_model, app_billing, app_business_data, app_sys_phone_lookup, app_sys_scheduler, app_sys_console, app_sys_example_set;
--> statement-breakpoint
GRANT SELECT ON "business" TO app_messaging;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "business" TO app_workflow;
--> statement-breakpoint
GRANT SELECT ON "business" TO app_content;
--> statement-breakpoint
GRANT SELECT ON "business" TO app_design;
--> statement-breakpoint
GRANT SELECT ON "business" TO app_approval;
--> statement-breakpoint
GRANT SELECT ON "business" TO app_publishing;
--> statement-breakpoint
GRANT SELECT ON "business" TO app_billing;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "business" TO app_business_data;
--> statement-breakpoint
GRANT SELECT ON "business" TO app_sys_phone_lookup;
--> statement-breakpoint
GRANT SELECT ON "business" TO app_sys_scheduler;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "business" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT ON "channel_connection" TO app_workflow;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "channel_connection" TO app_publishing;
--> statement-breakpoint
GRANT SELECT ON "channel_connection" TO app_business_data;
--> statement-breakpoint
GRANT SELECT ON "channel_connection" TO app_sys_scheduler;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "channel_connection" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "conversation_state" TO app_messaging;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "conversation_state" TO app_workflow;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "conversation_state" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "message" TO app_messaging;
--> statement-breakpoint
GRANT SELECT ON "message" TO app_workflow;
--> statement-breakpoint
GRANT SELECT ON "message" TO app_content;
--> statement-breakpoint
GRANT SELECT ON "message" TO app_approval;
--> statement-breakpoint
GRANT SELECT, INSERT ON "message" TO app_sys_phone_lookup;
--> statement-breakpoint
GRANT SELECT ON "message" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT ON "media_asset" TO app_messaging;
--> statement-breakpoint
GRANT SELECT ON "media_asset" TO app_content;
--> statement-breakpoint
GRANT SELECT, INSERT ON "media_asset" TO app_design;
--> statement-breakpoint
GRANT SELECT ON "media_asset" TO app_publishing;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "media_asset" TO app_business_data;
--> statement-breakpoint
GRANT SELECT ON "media_asset" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT ON "preference_rule" TO app_content;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "preference_rule" TO app_business_data;
--> statement-breakpoint
GRANT SELECT ON "preference_rule" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "weekly_update" TO app_workflow;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "weekly_update" TO app_content;
--> statement-breakpoint
GRANT SELECT ON "weekly_update" TO app_sys_scheduler;
--> statement-breakpoint
GRANT SELECT ON "weekly_update" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "post" TO app_workflow;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "post" TO app_content;
--> statement-breakpoint
GRANT SELECT ON "post" TO app_design;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "post" TO app_approval;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "post" TO app_publishing;
--> statement-breakpoint
GRANT SELECT ON "post" TO app_business_data;
--> statement-breakpoint
GRANT SELECT ON "post" TO app_sys_scheduler;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "post" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT ON "post_version" TO app_content;
--> statement-breakpoint
GRANT SELECT ON "post_version" TO app_design;
--> statement-breakpoint
GRANT SELECT ON "post_version" TO app_approval;
--> statement-breakpoint
GRANT SELECT ON "post_version" TO app_publishing;
--> statement-breakpoint
GRANT SELECT ON "post_version" TO app_business_data;
--> statement-breakpoint
GRANT SELECT ON "post_version" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT ON "approval" TO app_approval;
--> statement-breakpoint
GRANT UPDATE ("invalidated_at") ON "approval" TO app_approval;
--> statement-breakpoint
GRANT SELECT ON "approval" TO app_publishing;
--> statement-breakpoint
GRANT SELECT ON "approval" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "publication" TO app_publishing;
--> statement-breakpoint
GRANT SELECT ON "publication" TO app_business_data;
--> statement-breakpoint
GRANT SELECT ON "publication" TO app_sys_scheduler;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "publication" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "subscription" TO app_billing;
--> statement-breakpoint
GRANT SELECT ON "subscription" TO app_sys_scheduler;
--> statement-breakpoint
GRANT SELECT ON "subscription" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT ON "model_run" TO app_model;
--> statement-breakpoint
GRANT SELECT ON "model_run" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT, INSERT ON "model_run" TO app_sys_example_set;
--> statement-breakpoint
GRANT SELECT, INSERT ON "console_item" TO app_workflow;
--> statement-breakpoint
GRANT SELECT, INSERT ON "console_item" TO app_publishing;
--> statement-breakpoint
GRANT SELECT, INSERT ON "console_item" TO app_model;
--> statement-breakpoint
GRANT SELECT, INSERT ON "console_item" TO app_sys_phone_lookup;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "console_item" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT ON "model_task_config" TO app_model;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "model_task_config" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT ON "model_task_config" TO app_sys_example_set;
--> statement-breakpoint
GRANT SELECT ON "prompt_template" TO app_model;
--> statement-breakpoint
GRANT SELECT, INSERT ON "prompt_template" TO app_sys_console;
--> statement-breakpoint
GRANT SELECT ON "prompt_template" TO app_sys_example_set;
--> statement-breakpoint
GRANT SELECT ON "system_control" TO app_publishing;
--> statement-breakpoint
GRANT SELECT ON "system_control" TO app_sys_scheduler;
--> statement-breakpoint
GRANT SELECT, UPDATE ON "system_control" TO app_sys_console;
--> statement-breakpoint
-- The WP-20 logins held the old single grant set; their privileges and the logins themselves go.
-- No object is owned by them (the migration role owns every table), so DROP OWNED only revokes.
-- DROP OWNED needs the privileges of the role. On Cloud SQL the admin (`postgres`, cloudsqlsuperuser)
-- is not a superuser, and since Postgres 16 creating a role does not make the creator a member, so
-- the admin takes the two logins first (it holds ADMIN OPTION on roles it created). A real superuser
-- (tests, local) gets the same grant and loses it when the roles are dropped.
GRANT app_user, app_system TO CURRENT_USER;--> statement-breakpoint
DROP OWNED BY app_user, app_system;--> statement-breakpoint
DROP ROLE app_user;--> statement-breakpoint
DROP ROLE app_system;
