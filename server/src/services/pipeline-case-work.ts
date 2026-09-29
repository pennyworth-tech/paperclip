import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issues, pipelineCases, pipelineCaseEvents, pipelineCaseIssueLinks,
  pipelineCaseWork, pipelineCaseWorkTurns, pipelineCaseWorkResults } from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { lockEvidenceCase } from "./pipeline-stage-evidence.js";
import type { PluginCaseWorkExecution } from "@paperclipai/plugin-sdk";
import { activeCaseWorkRuns, caseWorkExecution, hasActiveCaseWorkRun, terminalCaseWorkRuns } from "./pipeline-case-work-execution.js";
import { assertCaseSourceWriteAvailable } from "./workspace-source-write-guard.js";

type Tx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Producer = { pluginId: string; pluginKey: string };
const activeRuns = new Set(activeCaseWorkRuns);
const roleSchema = z.enum(["author", "editor", "reviewer", "human", "waiting"]);
const handoffSchema = z.object({ expectedTurn: z.number().int().min(0), expectedAgentId: z.string().uuid().nullable(),
  expectedVersion: z.number().int().positive().optional(), expectedSourceRevisionId: z.string().min(1).max(200).nullable().optional(),
  requestKey: z.string().min(1).max(200), role: roleSchema, agentId: z.string().uuid().nullable(),
  revisionId: z.string().min(1).max(200).nullable(), priorResultId: z.string().uuid().optional(), recoveryRunId: z.string().uuid().optional(),
  reason: z.string().min(1).max(2000) }).strict();
const resultSchema = z.object({ expectedTurn: z.number().int().positive(), agentId: z.string().uuid(), runId: z.string().uuid(),
  revisionId: z.string().min(1).max(200), contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.record(z.string(), z.unknown()) }).strict();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const digest = (input: unknown) => createHash("sha256").update(canonical(input)).digest("hex");
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw unprocessable("Invalid case work operation", { code: "validation", issues: result.error.issues });
  return result.data;
}
async function binding(tx: Tx, companyId: string, caseId: string, producer?: Producer) {
  const [row] = await tx.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.companyId, companyId),
    eq(pipelineCaseWork.caseId, caseId))).for("update");
  if (!row) throw notFound("Case preparation task not bound");
  if (producer && (row.producerPluginId !== producer.pluginId || row.producerPluginKey !== producer.pluginKey)) {
    throw forbidden("Case preparation task belongs to another plugin");
  }
  return row;
}
async function lockedIssue(tx: Tx, companyId: string, issueId: string) {
  const [row] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
  if (!row) throw notFound("Preparation issue not found");
  return row;
}
export async function requireReleased(tx: Tx, row: typeof issues.$inferSelect) {
  if (row.checkoutRunId) throw conflict("Previous task checkout must be released", { code: "checkout_held" });
  if (row.executionRunId) {
    const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, row.companyId), eq(heartbeatRuns.id, row.executionRunId)));
    if (run && activeRuns.has(run.status)) throw conflict("Previous task run is still active", { code: "run_active" });
    if (!run || !terminalCaseWorkRuns.has(run.status)) throw conflict("Previous task run state is unknown", { code: "execution_unknown" });
  }
  if (await hasActiveCaseWorkRun(tx, row.companyId, row.id)) throw conflict("A preparation run is still active", { code: "run_active" });
}

export function pipelineCaseWorkService(db: Db, producer: Producer) {
  return {
    async get(companyId: string, caseId: string) {
      const [row] = await db.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.companyId, companyId),
        eq(pipelineCaseWork.caseId, caseId)));
      if (!row) return null;
      const turns = await db.select().from(pipelineCaseWorkTurns).where(eq(pipelineCaseWorkTurns.caseId, caseId))
        .orderBy(pipelineCaseWorkTurns.turn);
      const results = await db.select().from(pipelineCaseWorkResults).where(eq(pipelineCaseWorkResults.caseId, caseId))
        .orderBy(pipelineCaseWorkResults.turn);
      return { ...row, turns, results, execution: await caseWorkExecution(db, row) };
    },
    async bind(companyId: string, caseId: string, issueId: string) {
      return db.transaction(async (tx) => {
        await lockEvidenceCase(tx, companyId, caseId);
        const [existing] = await tx.select().from(pipelineCaseWork).where(eq(pipelineCaseWork.caseId, caseId));
        if (existing) {
          if (existing.issueId !== issueId || existing.producerPluginId !== producer.pluginId) {
            throw conflict("Case already has a different preparation task", { code: "work_binding_conflict" });
          }
          return existing;
        }
        const issue = await lockedIssue(tx, companyId, issueId);
        await requireReleased(tx, issue);
        if (issue.assigneeAgentId || issue.assigneeUserId || ["done", "cancelled"].includes(issue.status)) {
          throw conflict("Bind an open, unassigned preparation task", { code: "task_not_available" });
        }
        const [otherBinding] = await tx.select().from(pipelineCaseWork).where(eq(pipelineCaseWork.issueId, issueId));
        if (otherBinding) throw conflict("Task already belongs to another case", { code: "work_binding_conflict" });
        const [row] = await tx.insert(pipelineCaseWork).values({ companyId, caseId, issueId,
          producerPluginId: producer.pluginId, producerPluginKey: producer.pluginKey }).returning();
        await tx.insert(pipelineCaseIssueLinks).values({ companyId, caseId, issueId, role: "work" })
          .onConflictDoUpdate({ target: [pipelineCaseIssueLinks.caseId, pipelineCaseIssueLinks.issueId],
            set: { role: "work", retiredAt: null, updatedAt: new Date() } });
        await tx.insert(pipelineCaseEvents).values({ companyId, caseId, type: "issue_linked", actorType: "system",
          payload: { issueId, role: "work", pluginKey: producer.pluginKey, preparation: true } });
        await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: producer.pluginKey,
          action: "pipeline.preparation_bound", entityType: "issue", entityId: issueId, details: { caseId } });
        return row!;
      });
    },
    async recordResult(companyId: string, caseId: string, raw: z.infer<typeof resultSchema>) {
      const input = parse(resultSchema, raw);
      if (Buffer.byteLength(JSON.stringify(input.result)) > 100_000) throw unprocessable("Turn result exceeds size limit");
      return db.transaction(async (tx) => {
        await lockEvidenceCase(tx, companyId, caseId);
        const work = await binding(tx, companyId, caseId, producer);
        const resultDigest = digest(input);
        const [prior] = await tx.select().from(pipelineCaseWorkResults).where(and(eq(pipelineCaseWorkResults.caseId, caseId),
          eq(pipelineCaseWorkResults.turn, input.expectedTurn)));
        if (prior) {
          if (prior.resultDigest !== resultDigest) throw conflict("Turn already has a different result", { code: "result_conflict" });
          return prior;
        }
        const issue = await lockedIssue(tx, companyId, work.issueId);
        const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.companyId, companyId)));
        if (work.turn !== input.expectedTurn || work.agentId !== input.agentId || issue.assigneeAgentId !== input.agentId
          || issue.checkoutRunId !== input.runId || !run || run.status !== "running") {
          throw conflict("Result is not from the current checked-out turn", { code: "stale_turn" });
        }
        if (work.role !== "author" && work.revisionId !== input.revisionId) {
          throw conflict("Editor and reviewer must use the assigned revision", { code: "revision_conflict" });
        }
        const [result] = await tx.insert(pipelineCaseWorkResults).values({ companyId, caseId, turn: work.turn,
          role: work.role, agentId: input.agentId, runId: input.runId, revisionId: input.revisionId,
          contentDigest: input.contentDigest, result: input.result, resultDigest }).returning();
        await tx.insert(pipelineCaseEvents).values({ companyId, caseId, type: "updated", actorType: "agent",
          actorAgentId: input.agentId, runId: input.runId,
          payload: { workResultId: result!.id, turn: work.turn, role: work.role, revisionId: input.revisionId } });
        await tx.insert(activityLog).values({ companyId, actorType: "agent", actorId: input.agentId, agentId: input.agentId,
          runId: input.runId, action: "pipeline.preparation_result", entityType: "issue", entityId: work.issueId,
          details: { caseId, turn: work.turn, resultId: result!.id, revisionId: input.revisionId } });
        return result!;
      });
    },
    async handoff(companyId: string, caseId: string, raw: z.infer<typeof handoffSchema>) {
      const input = parse(handoffSchema, raw);
      if ((["author", "editor", "reviewer"].includes(input.role)) !== Boolean(input.agentId)) {
        throw unprocessable("Agent roles require an agent; waiting and human turns must be unassigned");
      }
      return db.transaction(async (tx) => {
        await lockWorkDispatch(tx, companyId, caseId);
        const currentCase = await lockEvidenceCase(tx, companyId, caseId);
        const work = await binding(tx, companyId, caseId, producer);
        const requestDigest = digest(input);
        const [prior] = await tx.select().from(pipelineCaseWorkTurns).where(and(eq(pipelineCaseWorkTurns.caseId, caseId),
          eq(pipelineCaseWorkTurns.requestKey, input.requestKey)));
        if (prior) {
          if (prior.requestDigest !== requestDigest) throw conflict("Handoff key has different content", { code: "request_conflict" });
          return prior;
        }
        await assertCaseSourceWriteAvailable(tx, companyId, caseId);
        if (input.expectedVersion !== undefined && currentCase.version !== input.expectedVersion) {
          throw conflict("Case changed before the scoped handoff", { code: "case_version_conflict", caseVersion: currentCase.version });
        }
        if (input.expectedSourceRevisionId !== undefined && work.sourceRevisionId !== input.expectedSourceRevisionId) {
          throw conflict("Source changed before the scoped handoff", { code: "revision_conflict", revisionId: work.sourceRevisionId });
        }
        if (currentCase.terminalKind) throw conflict("Reopen the case before starting another turn", { code: "case_terminal" });
        if (work.turn !== input.expectedTurn || work.agentId !== input.expectedAgentId) {
          throw conflict("Task turn changed", { code: "stale_turn", turn: work.turn });
        }
        const issue = await lockedIssue(tx, companyId, work.issueId);
        if (issue.assigneeAgentId !== input.expectedAgentId || issue.assigneeUserId) {
          throw conflict("Task assignee changed", { code: "assignee_conflict" });
        }
        await requireReleased(tx, issue);
        const execution = await caseWorkExecution(tx, work);
        if (["active", "pending", "unknown"].includes(execution.state)) {
          throw conflict("Preparation execution has not conclusively ended", { code: execution.state === "active" ? "run_active" : "wake_pending" });
        }
        let recovering = false;
        if (input.recoveryRunId) {
          const [result] = await tx.select({ id: pipelineCaseWorkResults.id }).from(pipelineCaseWorkResults)
            .where(and(eq(pipelineCaseWorkResults.caseId, caseId), eq(pipelineCaseWorkResults.turn, work.turn)));
          if (result || input.priorResultId || execution.state !== "terminal" || !execution.runIds.includes(input.recoveryRunId)
            || !work.agentId || !["author", "editor", "reviewer"].includes(work.role)
            || (input.role !== "waiting" && (input.role !== work.role || input.agentId !== work.agentId
              || (input.role !== "author" && (input.revisionId !== work.revisionId || input.revisionId !== work.sourceRevisionId))))) {
            throw conflict("Recovery must retry or park the ended current turn without a result", { code: "recovery_conflict" });
          }
          recovering = true;
        }
        if (input.priorResultId) {
          const [result] = await tx.select().from(pipelineCaseWorkResults).where(and(eq(pipelineCaseWorkResults.id, input.priorResultId),
            eq(pipelineCaseWorkResults.companyId, companyId), eq(pipelineCaseWorkResults.caseId, caseId)));
          // An explicit re-review can start from a parked human/waiting turn,
          // which has no agent result of its own. It must refer to an accepted
          // editor/reviewer result for the still-current published source.
          const parkedReReview = !work.agentId && ["human", "waiting"].includes(work.role)
            && input.role === "reviewer" && result && ["editor", "reviewer"].includes(result.role)
            && result.turn < work.turn && input.revisionId === work.sourceRevisionId
            && result.revisionId === work.sourceRevisionId && result.contentDigest === work.sourceContentDigest;
          if (!result || (result.turn !== work.turn && !parkedReReview)) {
            throw conflict("Prior result does not belong to this turn or the published re-review candidate", { code: "result_conflict" });
          }
          const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, result.runId));
          if (run && activeRuns.has(run.status)) throw conflict("Previous result's run is still active", { code: "run_active" });
          if (!run || !terminalCaseWorkRuns.has(run.status)) throw conflict("Previous result's run state is unknown", { code: "execution_unknown" });
          if (["editor", "reviewer", "human"].includes(input.role) && result.revisionId !== input.revisionId) {
            throw conflict("Handoff must retain the prior result's revision", { code: "revision_conflict" });
          }
          if (["editor", "reviewer", "human"].includes(input.role) && work.sourceRevisionId
            && (result.revisionId !== work.sourceRevisionId || result.contentDigest !== work.sourceContentDigest)) {
            throw conflict("Published source advanced before the handoff", { code: "revision_conflict" });
          }
        } else if (["editor", "reviewer", "human"].includes(input.role) && !recovering) {
          throw conflict("The next review turn requires an accepted result", { code: "result_required" });
        }
        if (input.agentId) {
          const [agent] = await tx.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, companyId)));
          if (!agent || ["terminated", "pending_approval"].includes(agent.status)) throw unprocessable("Agent is not available");
          if (input.role === "reviewer") {
            const [selfReview] = await tx.select({ id: pipelineCaseWorkResults.id }).from(pipelineCaseWorkResults)
              .where(and(eq(pipelineCaseWorkResults.caseId, caseId), eq(pipelineCaseWorkResults.agentId, input.agentId),
                eq(pipelineCaseWorkResults.revisionId, input.revisionId ?? ""), inArray(pipelineCaseWorkResults.role, ["author", "editor"])));
            if (selfReview) throw forbidden("The reviewer must be independent of this revision's author and editor");
          }
        }
        const turn = work.turn + 1;
        const [receipt] = await tx.insert(pipelineCaseWorkTurns).values({ companyId, caseId, issueId: issue.id, turn,
          requestKey: input.requestKey, requestDigest, role: input.role, agentId: input.agentId,
          revisionId: input.revisionId, priorResultId: input.priorResultId ?? null }).returning();
        await tx.update(pipelineCaseWork).set({ turn, role: input.role, agentId: input.agentId,
          revisionId: input.revisionId, updatedAt: new Date() }).where(eq(pipelineCaseWork.id, work.id));
        await tx.update(issues).set({ assigneeAgentId: input.agentId, assigneeUserId: null,
          status: input.agentId ? "todo" : "in_review", checkoutRunId: null, executionRunId: null,
          executionAgentNameKey: null, executionLockedAt: null, completedAt: null, cancelledAt: null,
          updatedAt: new Date() }).where(eq(issues.id, issue.id));
        await tx.update(pipelineCaseIssueLinks).set({ role: input.role === "reviewer" ? "review" : "work", updatedAt: new Date() })
          .where(and(eq(pipelineCaseIssueLinks.caseId, caseId), eq(pipelineCaseIssueLinks.issueId, issue.id)));
        await tx.insert(pipelineCaseEvents).values({ companyId, caseId, type: "updated", actorType: "system",
          payload: { workTurnId: receipt!.id, issueId: issue.id, turn, role: input.role, agentId: input.agentId,
            previousAgentId: work.agentId, reason: input.reason, pluginKey: producer.pluginKey,
            ...(input.recoveryRunId ? { recoveryRunId: input.recoveryRunId, recoveredTurn: work.turn } : {}) } });
        await tx.insert(activityLog).values({ companyId, actorType: "system", actorId: producer.pluginKey,
          action: "pipeline.preparation_handoff", entityType: "issue", entityId: issue.id,
          details: { caseId, turn, role: input.role, agentId: input.agentId, previousAgentId: work.agentId,
            ...(input.recoveryRunId ? { recoveryRunId: input.recoveryRunId } : {}) } });
        return receipt!;
      });
    },
  };
}

export async function lockWorkDispatch(tx: Tx, companyId: string, caseId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"case-work:" + companyId + ":" + caseId}, 0))`);
}

/** Serialize queueing with reassignment without holding rows the heartbeat must update. */
export async function withCaseWorkWake<T>(db: Db, input: { companyId: string; issueId: string; pluginId: string;
  expected?: { caseId: string; turn: number; agentId: string } }, wake: () => Promise<T>, replay?: (execution: PluginCaseWorkExecution) => T) {
  const [bound] = await db.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.companyId, input.companyId),
    eq(pipelineCaseWork.issueId, input.issueId)));
  if (!bound) {
    if (input.expected) throw conflict("Preparation task binding changed", { code: "stale_turn" });
    return wake();
  }
  if (!input.expected || bound.producerPluginId !== input.pluginId || bound.caseId !== input.expected.caseId) {
    throw forbidden("Preparation wakes require their owning plugin and exact turn");
  }
  return db.transaction(async (tx) => {
    await lockWorkDispatch(tx, input.companyId, bound.caseId);
    const [current] = await tx.select().from(pipelineCaseWork).where(eq(pipelineCaseWork.id, bound.id));
    if (!current || current.turn !== input.expected!.turn || current.agentId !== input.expected!.agentId) {
      throw conflict("Preparation turn changed before wakeup", { code: "stale_turn" });
    }
    await assertCaseSourceWriteAvailable(tx, input.companyId, bound.caseId);
    const execution = await caseWorkExecution(tx, current);
    if (execution.state !== "not_requested") {
      if (replay) return replay(execution);
      throw conflict("This turn already has a durable wake receipt", { code: "wake_recorded" });
    }
    return wake();
  });
}

/** Called before the issue row lock, in every native issue update transaction. */
export async function assertCaseWorkIssuePatch(tx: Tx, companyId: string, issueId: string,
  patch: Partial<typeof issues.$inferInsert>) {
  const [work] = await tx.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.companyId, companyId), eq(pipelineCaseWork.issueId, issueId)));
  if (!work) return;
  await lockEvidenceCase(tx, companyId, work.caseId);
  const current = await binding(tx, companyId, work.caseId);
  await assertCaseSourceWriteAvailable(tx, companyId, work.caseId);
  if ((patch.assigneeAgentId !== undefined && patch.assigneeAgentId !== current.agentId)
    || (patch.assigneeUserId !== undefined && patch.assigneeUserId !== null)) {
    throw conflict("Reassign the preparation task through its case turn", { code: "case_handoff_required" });
  }
  if (patch.status === "done" || patch.status === "cancelled") {
    throw conflict("Preparation completes through the guarded case outcome", { code: "case_outcome_required" });
  }
  if (!current.agentId && patch.status === "in_progress") throw conflict("Preparation is waiting for human input");
}

/** Part of the case transition transaction. Approval/reopen keeps the same issue ID. */
export async function syncCaseWorkOutcome(tx: Tx, currentCase: typeof pipelineCases.$inferSelect) {
  const [work] = await tx.select().from(pipelineCaseWork).where(eq(pipelineCaseWork.caseId, currentCase.id)).for("update");
  if (!work) return;
  const issue = await lockedIssue(tx, currentCase.companyId, work.issueId);
  if (!currentCase.terminalKind) {
    if (["done", "cancelled"].includes(issue.status)) await tx.update(issues).set({ status: "in_review", completedAt: null,
      cancelledAt: null, updatedAt: new Date() }).where(eq(issues.id, issue.id));
    return;
  }
  await requireReleased(tx, issue);
  if (currentCase.terminalKind === "done" && work.role !== "human") {
    throw conflict("Park the preparation task for human review before approving", { code: "human_turn_required" });
  }
  await tx.update(issues).set({ status: currentCase.terminalKind, assigneeAgentId: null, assigneeUserId: null,
    checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
    completedAt: currentCase.terminalKind === "done" ? new Date() : null,
    cancelledAt: currentCase.terminalKind === "cancelled" ? new Date() : null, updatedAt: new Date() }).where(eq(issues.id, issue.id));
  await tx.update(pipelineCaseWork).set({ agentId: null, updatedAt: new Date() }).where(eq(pipelineCaseWork.id, work.id));
  await tx.insert(activityLog).values({ companyId: currentCase.companyId, actorType: "system", actorId: work.producerPluginKey,
    action: "pipeline.preparation_completed", entityType: "issue", entityId: issue.id,
    details: { caseId: currentCase.id, status: currentCase.terminalKind, caseVersion: currentCase.version } });
}

/** Linked-reviewer authorization cannot change historical authorship. */
export async function assertCaseWorkReviewer(tx: Tx, companyId: string, caseId: string, agentId: string, runId: string) {
  const [work] = await tx.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.companyId, companyId), eq(pipelineCaseWork.caseId, caseId)));
  if (!work) return;
  const issue = await lockedIssue(tx, companyId, work.issueId);
  if (work.role !== "reviewer" || work.agentId !== agentId || issue.assigneeAgentId !== agentId || issue.checkoutRunId !== runId) {
    throw forbidden("Review requires the current checked-out reviewer turn");
  }
  const [authored] = await tx.select({ id: pipelineCaseWorkResults.id }).from(pipelineCaseWorkResults).where(and(
    eq(pipelineCaseWorkResults.caseId, caseId), eq(pipelineCaseWorkResults.agentId, agentId),
    eq(pipelineCaseWorkResults.revisionId, work.revisionId ?? ""), inArray(pipelineCaseWorkResults.role, ["author", "editor"])));
  if (authored) throw forbidden("Review must be independent of this revision's author and editor");
}

/** Associate every bound agent verdict (including an adverse one) with its
 * immutable turn result. The event is the recovery receipt if the caller loses
 * the response after the native transaction commits. */
export async function caseWorkReviewResult(tx: Tx, companyId: string, caseId: string, agentId: string, runId: string) {
  const [work] = await tx.select().from(pipelineCaseWork).where(and(eq(pipelineCaseWork.companyId, companyId), eq(pipelineCaseWork.caseId, caseId)));
  if (!work) return null;
  await assertCaseWorkReviewer(tx, companyId, caseId, agentId, runId);
  const [result] = await tx.select().from(pipelineCaseWorkResults).where(and(
    eq(pipelineCaseWorkResults.companyId, companyId), eq(pipelineCaseWorkResults.caseId, caseId),
    eq(pipelineCaseWorkResults.turn, work.turn), eq(pipelineCaseWorkResults.agentId, agentId), eq(pipelineCaseWorkResults.runId, runId)));
  const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId), eq(heartbeatRuns.agentId, agentId)));
  if (!result || run?.status !== "running") {
    throw conflict("Record the current reviewer's result before deciding, while its run is active", { code: "review_result_required" });
  }
  if (result.revisionId !== work.revisionId || (work.sourceRevisionId
    && (result.revisionId !== work.sourceRevisionId || result.contentDigest !== work.sourceContentDigest))) {
    throw conflict("Reviewer result no longer describes the published source", { code: "revision_conflict" });
  }
  return { preparationResultId: result.id, preparationTurn: result.turn,
    preparationRevisionId: result.revisionId, preparationContentDigest: result.contentDigest };
}
