import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const dbDescribe = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

dbDescribe("issue redaction run lookup indexes", () => {
  it("indexes both JSON reference branches without scanning unrelated contexts", async () => {
    const database = await startEmbeddedPostgresTestDatabase("nested-issue-index-");
    cleanups.push(() => database.cleanup());
    const sql = postgres(database.connectionString, { max: 1 });
    cleanups.push(async () => { await sql.end(); });

    // Allow an operator to prebuild concurrently before the transactional
    // migration: replaying it against an existing index must remain safe.
    await sql.unsafe(await readFile(new URL(
      "./migrations/0237_heartbeat_nested_issue_index.sql", import.meta.url,
    ), "utf8"));

    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    await sql`INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Index test', 'IDX'), (${otherCompanyId}, 'Other company', 'OTH')`;
    await sql`INSERT INTO agents (id, company_id, name, role, adapter_type, adapter_config)
      VALUES (${agentId}, ${companyId}, 'Agent', 'engineer', 'process', '{}'::jsonb),
        (${otherAgentId}, ${otherCompanyId}, 'Other agent', 'engineer', 'process', '{}'::jsonb)`;

    // Enough unrelated, wide contexts to model the JSONB decompression cost
    // that makes a missing index expensive. Leave the planner at its defaults.
    await sql`INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      SELECT ${companyId}, ${agentId}, 'succeeded',
        jsonb_build_object('issueId', gen_random_uuid()::text, 'padding', repeat(md5(n::text), 256))
      FROM generate_series(1, 3000) AS n`;
    await sql`INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      VALUES
        (${companyId}, ${agentId}, 'succeeded', jsonb_build_object('issueId', ${issueId}::text)),
        (${companyId}, ${agentId}, 'succeeded', jsonb_build_object('paperclipIssue', jsonb_build_object('id', ${issueId}::text))),
        (${companyId}, ${agentId}, 'succeeded', jsonb_build_object('issueId', ${issueId}::text, 'paperclipIssue', jsonb_build_object('id', ${issueId}::text))),
        (${otherCompanyId}, ${otherAgentId}, 'succeeded', jsonb_build_object('paperclipIssue', jsonb_build_object('id', ${issueId}::text)))`;
    await sql.unsafe("ANALYZE heartbeat_runs");

    // Match valuesForIssue(), including the OR and full context projection.
    const lookup = `SELECT context_snapshot FROM heartbeat_runs
      WHERE company_id = $1 AND
        (context_snapshot ->> 'issueId' = $2 OR context_snapshot -> 'paperclipIssue' ->> 'id' = $2)`;
    const rows = await sql.unsafe(lookup, [companyId, issueId]);
    expect(rows).toHaveLength(3); // Both forms, no duplicate OR match or cross-company row.
    const plans = await sql.unsafe("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + lookup, [companyId, issueId]);
    const planText = JSON.stringify(plans[0]["QUERY PLAN"]);
    expect(planText).toContain("heartbeat_runs_company_ctx_issue_created_idx");
    expect(planText).toContain("heartbeat_runs_company_ctx_nested_issue_idx");
    expect(planText).not.toContain('"Node Type":"Seq Scan"');

    const missingPlans = await sql.unsafe("EXPLAIN (FORMAT JSON) " + lookup, [companyId, randomUUID()]);
    expect(JSON.stringify(missingPlans[0]["QUERY PLAN"])).not.toContain('"Node Type":"Seq Scan"');
  }, 240_000);
});
