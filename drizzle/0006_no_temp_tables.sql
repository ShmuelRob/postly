-- Hand-written (WP-24 review): database-schema.md, "Least privilege", "No temporary tables". A temp
-- table outlives the transaction on a pooled connection and shadows the real table (pg_temp comes
-- first in the search path), so one business's writes could land where another business reads.
DO $$
DECLARE
  login text;
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  FOREACH login IN ARRAY ARRAY[
    'app_messaging', 'app_workflow', 'app_content', 'app_design', 'app_approval', 'app_publishing',
    'app_model', 'app_billing', 'app_business_data',
    'app_sys_phone_lookup', 'app_sys_scheduler', 'app_sys_console', 'app_sys_example_set'
  ] LOOP
    EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), login);
  END LOOP;
END
$$;--> statement-breakpoint
-- The approval role changes only a post's status (database-schema.md, grant matrix).
REVOKE UPDATE ON "post" FROM app_approval;--> statement-breakpoint
GRANT UPDATE ("status", "updated_at") ON "post" TO app_approval;
