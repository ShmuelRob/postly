-- Hand-written (WP-43): database-schema.md, "Least privilege". The deletion role deletes a cancelled
-- business past data_delete_after; every business-owned table references business with on delete
-- cascade, and the cascade runs with the table owner's rights, so the role needs only these grants.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_deletion') THEN
    CREATE ROLE app_deletion LOGIN NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM app_deletion', current_database());
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_deletion;--> statement-breakpoint
GRANT SELECT, DELETE ON "business" TO app_deletion;--> statement-breakpoint
GRANT SELECT ON "media_asset" TO app_deletion;
