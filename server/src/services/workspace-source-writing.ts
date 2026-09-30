import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issues, pipelineCases, pipelineCaseEvents, pipelineCaseWork, pipelineCaseWorkTurns, workspaceOperations } from "@paperclipai/db";
import type { PluginWorkspaceEditAbortRequest, PluginWorkspaceEditAbortReceipt, PluginWorkspaceEditReceipt, PluginWorkspaceEditResult } from "@paperclipai/plugin-sdk";
import { conflict, forbidden, unprocessable } from "../errors.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { lockWorkDispatch, requireReleased } from "./pipeline-case-work.js";
import { caseWorkExecution } from "./pipeline-case-work-execution.js";
import { lockEvidenceCase } from "./pipeline-stage-evidence.js";
import { executeWorkspaceRevisionProgram, readWorkspaceRevisionBinding, runLocalWorkspaceProgram } from "./workspace-revision-context.js";
import { workspaceEditAbortSchema, workspaceEditRequestSchema } from "./workspace-source-edit.js";
import { workspaceSourceEditProgram } from "./workspace-source-edit-program.js";
import { workspaceSourceEditAuthEnv } from "./workspace-source-edit-auth.js";
import { runDurableSourceEdit, type SourceEditCheckpoint, type SourceEditProgramInput } from "./workspace-source-edit-recovery.js";
import { assertWorkspaceSourceWriteAvailable, lockSourceWorkspace, SOURCE_WRITE_PHASE, type SourceWriteDb } from "./workspace-source-write-guard.js";

export interface SourceWriteMetadata extends Record<string, unknown>, SourceEditCheckpoint {
  protocol: "openspec-source-write/v1";
  pluginId: string; pluginKey: string; caseId: string; requestDigest: string;
  request: PluginWorkspaceEditAbortRequest; reservedTurn: number; reservedVersion: number;
  leaseToken: string | null; leaseUntil: string | null;
  recoveryProtocol?: "openspec-source-candidate/v1";
  result?: PluginWorkspaceEditReceipt;
  failure?: { code: string; detail?: string };
}
type Producer = { pluginId: string; pluginKey: string; requireHumanMember(companyId: string, userId: string): Promise<void> };
const requestDigest = (workspaceId: string, input: PluginWorkspaceEditAbortRequest) => createHash("sha256")
  .update(JSON.stringify({ workspaceId, input })).digest("hex");

function parseResponse(execution: { stdout: string; exitCode: number | null }, input: PluginWorkspaceEditAbortRequest, abort = false) {
  let value: { ok?: boolean; code?: string; detail?: string; result?: PluginWorkspaceEditResult & { aborted?: boolean } };
  try { value = JSON.parse(execution.stdout); } catch { throw unprocessable("Invalid source-edit receipt", { code: "source_edit_failed" }); }
  if (execution.exitCode !== 0 || !value.ok || !value.result) throw unprocessable("Source editing did not complete", {
    code: /^[a-z][a-z0-9_]*$/.test(value.code ?? "") ? value.code : "source_edit_failed",
    ...(typeof value.detail === "string" ? { detail: value.detail.slice(0, 8000) } : {}), operationId: input.operationId,
  });
  const result = value.result;
  if (result.operationId !== input.operationId || (abort ? result.aborted !== true : result.baseCommitSha !== input.commitSha
    || !/^[a-f0-9]{40}$/.test(result.commitSha) || !/^[a-f0-9]{40}$/.test(result.inputCommitSha)
    || !/^[a-f0-9]{64}$/.test(result.sourceDigest) || typeof result.deckHtml !== "string" || Buffer.byteLength(result.deckHtml) > 5_000_000
    || typeof result.validation?.passed !== "boolean" || !Array.isArray(result.changedFiles)
    || (result.source ? !/^[a-f0-9]{64}$/.test(result.inspectionDigest ?? "")
      || result.validation.passed !== (result.source.cli.readiness?.state === "ready")
      || result.validation.cliVersion !== result.source.cli.version : result.validation.passed !== true))) {
    throw unprocessable("Source-edit receipt does not match its request", { code: "source_edit_receipt_mismatch" });
  }
  return result;
}

/** Native reservation stays pending across process loss. Time limits release an
 * execution attempt only; they never release the approval/workspace guard. */
export function workspaceSourceWritingService(db: Db, producer: Producer, runtime: EnvironmentRuntimeService) {
  async function operation(tx: SourceWriteDb, companyId: string, workspaceId: string, input: PluginWorkspaceEditAbortRequest) {
    const [row] = await tx.select().from(workspaceOperations).where(eq(workspaceOperations.id, input.operationId)).for("update");
    if (!row) return null;
    const metadata = row.metadata as SourceWriteMetadata | null;
    if (row.companyId !== companyId || row.executionWorkspaceId !== workspaceId || row.phase !== SOURCE_WRITE_PHASE
      || metadata?.protocol !== "openspec-source-write/v1" || metadata.pluginId !== producer.pluginId || metadata.pluginKey !== producer.pluginKey
      || metadata.caseId !== input.caseId) throw forbidden("Source operation belongs to a different case, workspace, or plugin");
    if (metadata.requestDigest !== requestDigest(workspaceId, input)) throw conflict("Source operation has different inputs", { code: "edit_request_conflict" });
    return { row, metadata };
  }

  async function reserve(companyId: string, workspaceId: string, input: PluginWorkspaceEditAbortRequest, abort: boolean) {
    return db.transaction(async (tx) => {
      await lockWorkDispatch(tx, companyId, input.caseId);
      await lockSourceWorkspace(tx, workspaceId);
      const current = await lockEvidenceCase(tx, companyId, input.caseId);
      const prior = await operation(tx, companyId, workspaceId, input);
      if (prior?.row.status === "succeeded" && prior.metadata.result) {
        if (abort) throw conflict("This edit is already published", { code: "edit_already_published" });
        return { cached: prior.metadata.result };
      }
      if (prior?.row.status === "cancelled") {
        if (!abort) throw conflict("This source edit was abandoned", { code: "edit_aborted" });
        return { abandoned: { operationId: input.operationId, aborted: true as const, caseVersion: current.version, workTurn: prior.metadata.reservedTurn } };
      }
      if (abort && !prior) {
        const [work] = await tx.select().from(pipelineCaseWork).where(eq(pipelineCaseWork.caseId, input.caseId));
        const binding = await readWorkspaceRevisionBinding(tx, producer, workspaceId, companyId,
          { ...input, expectedTurn: work?.turn ?? input.expectedTurn }, { ignoreVersion: true, forUpdate: true });
        const metadata: SourceWriteMetadata = { protocol: "openspec-source-write/v1", pluginId: producer.pluginId,
          pluginKey: producer.pluginKey, caseId: input.caseId, requestDigest: requestDigest(workspaceId, input), request: input,
          reservedTurn: binding.work.turn, reservedVersion: current.version, leaseToken: null, leaseUntil: null };
        // A durable cancellation, rather than absence, prevents a delayed Apply
        // RPC from starting after the caller abandons an unreserved request.
        await tx.insert(workspaceOperations).values({ id: input.operationId, companyId, executionWorkspaceId: workspaceId,
          issueId: binding.issue.id, phase: SOURCE_WRITE_PHASE, status: "cancelled", metadata, finishedAt: new Date() });
        await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: input.actorUserId,
          action: "pipeline.source_edit_abandoned", entityType: "pipeline_case", entityId: input.caseId,
          details: { operationId: input.operationId, beforeReservation: true } });
        return { abandoned: { operationId: input.operationId, aborted: true as const, caseVersion: current.version, workTurn: binding.work.turn } };
      }
      await assertWorkspaceSourceWriteAvailable(tx, companyId, workspaceId, input.operationId);
      const binding = await readWorkspaceRevisionBinding(tx, producer, workspaceId, companyId,
        { ...input, expectedTurn: prior?.metadata.reservedTurn ?? input.expectedTurn }, { ignoreVersion: Boolean(prior), forUpdate: true });
      if (binding.work.sourceRevisionId !== input.commitSha || (prior ? binding.work.sourceWriteId !== input.operationId : Boolean(binding.work.sourceWriteId))) {
        throw conflict("The published source or writer changed", { code: "edit_base_conflict" });
      }
      if (prior?.metadata.leaseUntil && new Date(prior.metadata.leaseUntil) > new Date()) {
        throw conflict("The source edit is already executing", { code: "operation_active", operationId: input.operationId });
      }
      if (!abort && prior?.metadata.result) {
        if (prior.metadata.result.caseVersion !== current.version || prior.metadata.result.workTurn !== binding.work.turn) {
          throw conflict("Case changed after the Git receipt; reconcile the reserved publication", { code: "source_edit_receipt_stale" });
        }
        return { cached: prior.metadata.result };
      }
      if (!prior) {
        // Every issue using this workspace participates in the same claim fence.
        const linked = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.executionWorkspaceId, workspaceId)))
          .orderBy(issues.id).limit(1001).for("update");
        if (linked.length > 1000) throw conflict("Workspace issue inventory requires reconciliation", { code: "workspace_scope_limit" });
        for (const issue of linked) await requireReleased(tx, issue);
        const execution = await caseWorkExecution(tx, binding.work);
        if (["active", "pending", "unknown"].includes(execution.state)) throw conflict("Preparation execution must conclusively end before editing", { code: "wake_pending" });
      }
      const leaseToken = randomUUID(), now = new Date();
      let metadata: SourceWriteMetadata;
      if (prior) metadata = { ...prior.metadata, leaseToken, leaseUntil: new Date(now.getTime() + 240_000).toISOString() };
      else {
        metadata = { protocol: "openspec-source-write/v1", pluginId: producer.pluginId, pluginKey: producer.pluginKey,
          caseId: input.caseId, requestDigest: requestDigest(workspaceId, input), request: input,
          reservedTurn: binding.work.turn + 1, reservedVersion: current.version + 1,
          leaseToken, leaseUntil: new Date(now.getTime() + 240_000).toISOString(), recoveryProtocol: "openspec-source-candidate/v1" };
        await tx.insert(workspaceOperations).values({ id: input.operationId, companyId, executionWorkspaceId: workspaceId,
          issueId: binding.issue.id, phase: SOURCE_WRITE_PHASE, status: "running", metadata });
        const [turn] = await tx.insert(pipelineCaseWorkTurns).values({ companyId, caseId: input.caseId, issueId: binding.issue.id,
          turn: metadata.reservedTurn, requestKey: "source-edit:" + input.operationId, requestDigest: metadata.requestDigest,
          role: "waiting", agentId: null, revisionId: input.commitSha }).returning();
        await tx.update(pipelineCaseWork).set({ sourceWriteId: input.operationId, role: "waiting", agentId: null,
          revisionId: input.commitSha, turn: metadata.reservedTurn, updatedAt: now }).where(eq(pipelineCaseWork.id, binding.work.id));
        await tx.update(issues).set({ status: "in_review", assigneeAgentId: null, assigneeUserId: null, checkoutRunId: null,
          executionRunId: null, executionAgentNameKey: null, executionLockedAt: null, completedAt: null, cancelledAt: null, updatedAt: now })
          .where(eq(issues.id, binding.issue.id));
        await tx.update(pipelineCases).set({ stageEvidenceId: null, version: metadata.reservedVersion, updatedAt: now })
          .where(eq(pipelineCases.id, input.caseId));
        await tx.insert(pipelineCaseEvents).values({ companyId, caseId: input.caseId, type: "updated", actorType: "user", actorUserId: input.actorUserId,
          payload: { sourceWriteId: input.operationId, workTurnId: turn!.id, turn: metadata.reservedTurn, issueId: binding.issue.id,
            sourceWriteState: "reserved", reason: input.reason, previousVersion: current.version, version: metadata.reservedVersion } });
        await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: input.actorUserId,
          action: "pipeline.source_edit_reserved", entityType: "pipeline_case", entityId: input.caseId,
          details: { pluginId: producer.pluginId, workspaceId, operationId: input.operationId, baseCommitSha: input.commitSha, turn: metadata.reservedTurn } });
      }
      if (prior) await tx.update(workspaceOperations).set({ metadata, updatedAt: now }).where(eq(workspaceOperations.id, input.operationId));
      return { binding, metadata, leaseToken };
    });
  }

  async function mutate(companyId: string, workspaceId: string, input: PluginWorkspaceEditAbortRequest, abort: boolean) {
    const reservation = await reserve(companyId, workspaceId, input, abort);
    if (reservation.cached) return reservation.cached;
    if (reservation.abandoned) return reservation.abandoned;
    const { metadata, leaseToken, binding } = reservation;
    try {
      const deadline = Date.now() + 180_000;
      const execute = (request: SourceEditProgramInput) => {
        const env = request.mode === "apply" ? workspaceSourceEditAuthEnv(db, companyId, input.repositorySsh, async () => {
          const current = await readWorkspaceRevisionBinding(db, producer, workspaceId, companyId,
            { ...input, expectedTurn: metadata!.reservedTurn }, { ignoreVersion: true });
          if (current.work.sourceWriteId !== input.operationId || current.work.sourceRevisionId !== input.commitSha
            || current.issue.id !== binding!.issue.id || current.issue.checkoutRunId !== binding!.issue.checkoutRunId) {
            throw conflict("The source writer changed during preflight", { code: "operation_lease_lost" });
          }
          return { issueId: current.issue.id, heartbeatRunId: current.issue.checkoutRunId, responsibleUserId: input.actorUserId };
        }) : undefined;
        return executeWorkspaceRevisionProgram(db, runtime, binding!, workspaceSourceEditProgram, request, { deadline, env });
      };
      // Previously started operations retain their workspace journal protocol;
      // absence of a new checkpoint must not be mistaken for proof of no push.
      const execution = metadata!.recoveryProtocol === "openspec-source-candidate/v1"
        ? await runDurableSourceEdit(input, abort, metadata!, {
          execute,
          restore: async (request, cwd) => {
            if (cwd !== binding!.workspace.cwd) throw conflict("The canonical copy directory changed", { code: "workspace_mismatch" });
            return runLocalWorkspaceProgram(cwd, workspaceSourceEditProgram, request, deadline - Date.now());
          },
          save: async (checkpoint) => {
            if (Date.now() >= deadline) throw conflict("Source edit execution deadline expired", { code: "operation_lease_lost" });
            // Merge into the current row, under the attempt token. A stale
            // prepare result cannot replace a recovered candidate or publish.
            const [saved] = await db.update(workspaceOperations).set({
              metadata: sql`${workspaceOperations.metadata} || ${JSON.stringify(checkpoint)}::jsonb`, updatedAt: new Date(),
            }).where(and(eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.id, input.operationId),
              eq(workspaceOperations.status, "running"), sql`${workspaceOperations.metadata}->>'leaseToken' = ${leaseToken!}`,
              sql`(${workspaceOperations.metadata}->>'leaseUntil')::timestamptz > now()`)).returning({ id: workspaceOperations.id });
            if (!saved) throw conflict("Source edit execution lease changed", { code: "operation_lease_lost" });
          },
        }) : await execute({ ...input, mode: abort ? "abort" : "apply" });
      const result = parseResponse(execution, input, abort);
      if (!abort && result.published !== true) throw unprocessable("Source was not published", { code: "source_edit_receipt_mismatch" });
      return await db.transaction(async (tx) => {
        const current = await lockEvidenceCase(tx, companyId, input.caseId);
        const latest = await readWorkspaceRevisionBinding(tx, producer, workspaceId, companyId,
          { ...input, expectedTurn: metadata!.reservedTurn }, { ignoreVersion: true, forUpdate: true });
        const stored = await operation(tx, companyId, workspaceId, input);
        if (latest.work.sourceWriteId !== input.operationId || stored?.metadata.leaseToken !== leaseToken) {
          throw conflict("Source operation lease changed; resume its recorded candidate", { code: "operation_lease_lost" });
        }
        const prepared = stored.metadata.recovery;
        if (!abort && prepared && (result.commitSha !== prepared.commitSha || result.inputCommitSha !== prepared.inputCommitSha
          || result.sourceDigest !== prepared.sourceDigest || result.inspectionDigest !== prepared.inspectionDigest)) {
          throw unprocessable("Publication does not match the durable candidate", { code: "source_edit_receipt_mismatch" });
        }
        const now = new Date();
        if (abort) {
          await tx.update(pipelineCaseWork).set({ sourceWriteId: null, updatedAt: now }).where(eq(pipelineCaseWork.id, latest.work.id));
          await tx.update(workspaceOperations).set({ status: "cancelled", metadata: { ...stored.metadata, leaseToken: null, leaseUntil: null },
            finishedAt: now, updatedAt: now }).where(eq(workspaceOperations.id, input.operationId));
          await tx.insert(pipelineCaseEvents).values({ companyId, caseId: input.caseId, type: "updated", actorType: "user", actorUserId: input.actorUserId,
            payload: { sourceWriteId: input.operationId, sourceWriteState: "abandoned", turn: latest.work.turn, version: current.version } });
          return { operationId: input.operationId, aborted: true as const, caseVersion: current.version, workTurn: latest.work.turn };
        }
        const receipt: PluginWorkspaceEditReceipt = { ...result, caseVersion: current.version, workTurn: latest.work.turn };
        const next = { ...stored.metadata, result: receipt, leaseToken: null, leaseUntil: null }; delete next.failure;
        await tx.update(workspaceOperations).set({ metadata: next, updatedAt: now }).where(eq(workspaceOperations.id, input.operationId));
        await tx.insert(activityLog).values({ companyId, actorType: "user", actorId: input.actorUserId, action: "pipeline.source_edit_pushed",
          entityType: "pipeline_case", entityId: input.caseId, details: { operationId: input.operationId, commitSha: receipt.commitSha, sourceDigest: receipt.sourceDigest } });
        return receipt;
      });
    } catch (error) {
      const details = (error as { details?: { code?: string; detail?: string } }).details;
      const failure = { code: details?.code ?? "source_edit_failed", ...(details?.detail ? { detail: details.detail.slice(0, 8000) } : {}) };
      // Preserve candidate/dispatch checkpoints saved during this attempt,
      // including a push whose execution response never reached the host.
      await db.update(workspaceOperations).set({ metadata: sql`${workspaceOperations.metadata} || ${JSON.stringify({ leaseToken: null, leaseUntil: null, failure })}::jsonb`, updatedAt: new Date() })
        .where(and(eq(workspaceOperations.companyId, companyId), eq(workspaceOperations.id, input.operationId), eq(workspaceOperations.status, "running"),
          sql`${workspaceOperations.metadata}->>'leaseToken' = ${leaseToken!}`));
      throw error;
    }
  }

  return {
    async edit(workspaceId: string, companyId: string, raw: unknown): Promise<PluginWorkspaceEditReceipt> {
      const parsed = workspaceEditRequestSchema.safeParse(raw);
      if (!parsed.success) throw unprocessable("Invalid source edit", { code: "validation" });
      const input = parsed.data;
      await producer.requireHumanMember(companyId, input.actorUserId);
      const { mode, ...request } = input;
      if (mode === "apply") return await mutate(companyId, workspaceId, request, false) as PluginWorkspaceEditReceipt;
      const binding = await readWorkspaceRevisionBinding(db, producer, workspaceId, companyId, input);
      if (binding.work.sourceRevisionId !== input.commitSha) throw conflict("Preview requires the published source", { code: "edit_base_conflict" });
      const execution = await executeWorkspaceRevisionProgram(db, runtime, binding, workspaceSourceEditProgram, input);
      const result = parseResponse(execution, request);
      if (result.published !== false) throw unprocessable("Preview receipt reported publication", { code: "source_edit_receipt_mismatch" });
      await readWorkspaceRevisionBinding(db, producer, workspaceId, companyId, input);
      return { ...result, caseVersion: input.expectedVersion, workTurn: input.expectedTurn };
    },
    async abort(workspaceId: string, companyId: string, raw: unknown): Promise<PluginWorkspaceEditAbortReceipt> {
      const parsed = workspaceEditAbortSchema.safeParse(raw);
      if (!parsed.success) throw unprocessable("Invalid source edit abandonment", { code: "validation" });
      await producer.requireHumanMember(companyId, parsed.data.actorUserId);
      return await mutate(companyId, workspaceId, parsed.data, true) as PluginWorkspaceEditAbortReceipt;
    },
  };
}
