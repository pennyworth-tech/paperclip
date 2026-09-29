import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns, issues, pipelineCaseWork } from "@paperclipai/db";
import type { PluginCaseWorkExecution } from "@paperclipai/plugin-sdk";
import { conflict } from "../errors.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Work = { companyId: string; caseId: string; issueId: string; turn: number; agentId: string | null; producerPluginId: string };
export const activeCaseWorkRuns = ["queued", "running", "scheduled_retry"];
export const terminalCaseWorkRuns = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
type Request = { id: string; runId: string | null; status: string };
type Run = { id: string; status: string; wakeupRequestId: string | null };

/** Unknown and pending receipts are not evidence that a run ended. */
export function summarizeCaseWorkExecution(requests: Request[], runs: Run[]): PluginCaseWorkExecution {
  const requested = requests.filter((request) => request.status !== "skipped");
  const runIds = runs.map((run) => run.id);
  const base = { requestIds: requested.map((request) => request.id), runIds,
    runs: runs.map((run) => ({ id: run.id, status: run.status })) };
  if (runs.some((run) => activeCaseWorkRuns.includes(run.status))) return { ...base, state: "active" };
  if (runs.some((run) => !terminalCaseWorkRuns.has(run.status))) return { ...base, state: "unknown" };
  const unresolved = requested.filter((request) => !runs.some((run) => run.id === request.runId || run.wakeupRequestId === request.id));
  if (unresolved.length) return { ...base, state: unresolved.every((request) => ["queued", "claimed", "deferred_issue_execution"].includes(request.status)) ? "pending" : "unknown" };
  return { ...base, state: runs.length ? "terminal" : "not_requested" };
}

/** Native wake/run rows are the durable execution receipt, including continuations. */
export async function caseWorkExecution(tx: Tx, work: Work): Promise<PluginCaseWorkExecution> {
  if (!work.agentId) return { state: "not_requested", requestIds: [], runIds: [], runs: [] };
  const requests = await tx.select({ id: agentWakeupRequests.id, runId: agentWakeupRequests.runId, status: agentWakeupRequests.status })
    .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, work.companyId),
      eq(agentWakeupRequests.agentId, work.agentId), eq(agentWakeupRequests.requestedByActorId, work.producerPluginId),
      eq(agentWakeupRequests.idempotencyKey, `case-work:${work.caseId}:${work.turn}`)))
    .orderBy(agentWakeupRequests.createdAt).limit(101);
  const requestIds = requests.map((request) => request.id), knownRuns = requests.flatMap((request) => request.runId ? [request.runId] : []);
  const runs = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, wakeupRequestId: heartbeatRuns.wakeupRequestId })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, work.companyId), eq(heartbeatRuns.agentId, work.agentId), or(
      requestIds.length ? inArray(heartbeatRuns.wakeupRequestId, requestIds) : undefined,
      knownRuns.length ? inArray(heartbeatRuns.id, knownRuns) : undefined,
      and(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${work.issueId}`,
        sql`${heartbeatRuns.contextSnapshot} ->> 'pluginId' = ${work.producerPluginId}`,
        sql`${heartbeatRuns.contextSnapshot} -> 'caseWorkTurn' ->> 'caseId' = ${work.caseId}`,
        sql`${heartbeatRuns.contextSnapshot} -> 'caseWorkTurn' ->> 'turn' = ${String(work.turn)}`),
    ))).orderBy(heartbeatRuns.createdAt).limit(101);
  const result = summarizeCaseWorkExecution(requests, runs);
  return requests.length > 100 || runs.length > 100 ? { ...result, state: "unknown" } : result;
}

/** The issue lock may have been cleared before a run actually ended. */
export async function hasActiveCaseWorkRun(tx: Tx, companyId: string, issueId: string) {
  const [run] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, activeCaseWorkRuns),
    or(eq(heartbeatRuns.nativeIssueId, issueId), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issueId}`),
  )).limit(1);
  return Boolean(run);
}

/** Apply again in the claim UPDATE: a queued continuation can outlive its turn. */
export function caseWorkRunClaimCondition(companyId: string, issueId: string, agentId: string, context: Record<string, unknown>) {
  const pin = context.caseWorkTurn as { caseId?: unknown; turn?: unknown; agentId?: unknown } | null | undefined;
  const valid = pin && typeof pin.caseId === "string" && Number.isSafeInteger(pin.turn) && Number(pin.turn) > 0
    && pin.agentId === agentId && typeof context.pluginId === "string";
  const match = valid ? sql`and ${pipelineCaseWork.caseId}::text = ${pin.caseId as string}
    and ${pipelineCaseWork.turn} = ${pin.turn as number} and ${pipelineCaseWork.agentId}::text = ${agentId}
    and ${pipelineCaseWork.sourceWriteId} is null
    and ${pipelineCaseWork.producerPluginId}::text = ${context.pluginId as string}` : sql`and false`;
  return sql`(not exists (select 1 from ${pipelineCaseWork} where ${pipelineCaseWork.companyId} = ${companyId}
      and ${pipelineCaseWork.issueId} = ${issueId})
    or exists (select 1 from ${pipelineCaseWork} where ${pipelineCaseWork.companyId} = ${companyId}
      and ${pipelineCaseWork.issueId} = ${issueId} ${match}))`;
}

export async function isCaseWorkRunCurrent(tx: Tx, companyId: string, issueId: string, agentId: string, context: Record<string, unknown>) {
  const [row] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId),
    caseWorkRunClaimCondition(companyId, issueId, agentId, context))).limit(1);
  return Boolean(row);
}

/** The caller holds the workspace fence and work row lock for the entire native checkout. */
export async function assertCaseWorkCheckout(tx: Tx, companyId: string, issueId: string, agentId: string, runId: string | null) {
  const [work] = await tx.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.companyId, companyId), eq(pipelineCaseWork.issueId, issueId)));
  if (!work) return;
  const [run] = runId ? await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.id, runId), eq(heartbeatRuns.agentId, agentId))) : [];
  if (work.sourceWriteId || !run || !["queued", "running"].includes(run.status)
    || !await isCaseWorkRunCurrent(tx, companyId, issueId, agentId, run.contextSnapshot ?? {})) {
    throw conflict("Checkout requires the current preparation turn and no pending source edit", { code: "stale_turn" });
  }
}
