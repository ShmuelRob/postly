-- Hand-written (WP-24 review): database-schema.md, grant matrix. The console starts a handoff, sets
-- the global pause and schedules publications by hand; each of these may insert the row. A
-- publication inserted this way still goes live only when the publishing job's hash check passes.
GRANT INSERT ON "conversation_state", "publication", "system_control" TO app_sys_console;
