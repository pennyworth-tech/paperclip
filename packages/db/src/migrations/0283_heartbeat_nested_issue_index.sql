CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_nested_issue_idx" ON "heartbeat_runs" USING btree ("company_id",("context_snapshot" -> 'paperclipIssue' ->> 'id'));
