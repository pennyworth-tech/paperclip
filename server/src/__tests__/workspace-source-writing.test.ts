import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues,
  pipelineCases, pipelineCaseWork, projects, workspaceOperations } from "@paperclipai/db";
import type { PluginWorkspaceEditRequest } from "@paperclipai/plugin-sdk";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";
import { workspaceSourceWritingService } from "../services/workspace-source-writing.js";
import * as workspacePrograms from "../services/workspace-revision-context.js";
import * as gitCredentials from "../services/git-credentials.js";
import { workspaceSourceEditOriginProgram } from "../services/workspace-source-edit-auth.js";
import { sourceEditCandidateRequestDigest } from "../services/workspace-source-edit-recovery.js";
import { pipelineService } from "../services/pipelines.js";
import { pipelineCaseWorkService } from "../services/pipeline-case-work.js";
import { caseWorkRunClaimCondition } from "../services/pipeline-case-work-execution.js";
import { withSourceWriteClaimGuard } from "../services/workspace-source-write-guard.js";
import { issueService } from "../services/issues.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Source writing storage tests unavailable: ${support.reason}`);
suite("native source writer and one preparation task", () => {
  let db: ReturnType<typeof createDb>, temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const actor = { type: "user" as const, userId: "board-user" };
  const producer = { pluginId: randomUUID(), pluginKey: "test.spec-studio", requireHumanMember: vi.fn(async (_companyId: string, userId: string) => {
    if (userId !== actor.userId) throw new Error("Not an active board member");
  }) };
  const base = "a".repeat(40), next = "b".repeat(40), digest = "b".repeat(64);
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-source-writing-"); db = createDb(temp.connectionString); }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Source writing", defaultResponsibleUserId: actor.userId,
      issuePrefix: `S${randomUUID().slice(0, 6).toUpperCase()}` }).returning();
    const companyId = company!.id;
    const [project] = await db.insert(projects).values({ companyId, name: "Source project" }).returning();
    const [author] = await db.insert(agents).values({ companyId, name: "Author", status: "idle", adapterType: "process" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "Case workspace",
      mode: "isolated", strategyType: "git_worktree", providerType: "git_worktree", branchName: "openspec/fixture-change",
      repoUrl: "git@github.com:fixture/spec.git", cwd: "/host/mirror-must-not-execute" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, projectId: project!.id, executionWorkspaceId: workspace!.id, title: "Prepare spec", status: "backlog" }).returning();
    const [environment] = await db.insert(environments).values({ name: "Source environment " + randomUUID(), driver: "sandbox" }).returning();
    await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id, executionWorkspaceId: workspace!.id,
      issueId: issue!.id, status: "active", metadata: { remoteCwd: "/case-workspace", workspaceRealization: {
        mode: "in_place", authoritativeRoot: "/case-workspace", environmentId: environment!.id,
      } } });
    const pipeline = pipelineService(db, { heartbeat: { wakeup: async () => null } });
    const created = await pipeline.createPipeline({ companyId, key: "openspec", name: "OpenSpec", projectId: null, actor });
    for (const stage of await pipeline.listStages(companyId, created.id)) await pipeline.updateStage({ companyId, pipelineId: created.id,
      stageId: stage.id, actor, patch: { config: { ...stage.config, revisionPublication: { producerPluginKey: producer.pluginKey, reopenToStageKey: "in_progress" } } } });
    const { case: row } = await pipeline.ingestCase({ companyId, pipelineId: created.id, caseKey: "fixture", title: "Fixture", actor,
      fields: { changeId: "fixture-change", branch: workspace!.branchName }, workspaceRef: { executionWorkspaceId: workspace!.id } });
    const work = pipelineCaseWorkService(db, producer); await work.bind(companyId, row.id, issue!.id);
    await db.update(pipelineCaseWork).set({ sourceRevisionId: base, sourceContentDigest: "a".repeat(64) }).where(eq(pipelineCaseWork.caseId, row.id));
    const request: PluginWorkspaceEditRequest = { caseId: row.id, expectedVersion: row.version, expectedTurn: 0, operationId: randomUUID(),
      commitSha: base, repositorySsh: workspace!.repoUrl!, branch: workspace!.branchName!, changeId: "fixture-change", mode: "apply",
      actorUserId: actor.userId, reason: "Clarify the source", files: [{ path: "proposal.md", baseSha256: "a".repeat(64), text: "Proposed source" }] };
    const recovery = (input = request) => ({ protocol: "openspec-source-candidate/v1", operationId: input.operationId, baseCommitSha: base,
      requestDigest: sourceEditCandidateRequestDigest(input), createdAt: "2026-09-28T00:00:00.000Z", commitSha: next, inputCommitSha: "c".repeat(40), sourceDigest: digest,
      bundleSha256: createHash("sha256").update("fixture").digest("hex"), bundleBase64: Buffer.from("fixture").toString("base64") });
    const reply = (input = request, mode: string = input.mode) => ({ stdout: JSON.stringify({ ok: true, result: mode === "prepare"
      ? { prepared: true, recovery: recovery(input) } : mode === "abort" ? { operationId: input.operationId, aborted: true } : { operationId: input.operationId, baseCommitSha: base, commitSha: next,
        inputCommitSha: "c".repeat(40), sourceDigest: digest, deckHtml: "<html>Fixture</html>", changedFiles: [{ path: "proposal.md", beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64) }],
        validation: { passed: true, cliVersion: "1.2.0" }, published: mode === "apply" } }), exitCode: 0 });
    const execute = vi.fn(async ({ stdin, cwd }: { stdin?: string; cwd?: string }) => {
      expect(cwd).toBe("/case-workspace"); const input = JSON.parse(stdin!) as PluginWorkspaceEditRequest;
      if (input.mode === "apply") {
        const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, input.operationId));
        expect(operation!.metadata).toMatchObject({ recovery: recovery(input), publicationDispatched: true });
      }
      return reply(input, input.mode);
    });
    const preflight = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ ok: true, remoteUrl: request.repositorySsh }) }));
    const editor = workspaceSourceWritingService(db, producer, { execute: (args: { args?: string[]; stdin?: string; cwd?: string }) =>
      args.args?.includes(workspaceSourceEditOriginProgram) ? preflight() : execute(args) } as unknown as EnvironmentRuntimeService);
    const readCase = async () => (await db.select().from(pipelineCases).where(eq(pipelineCases.id, row.id)))[0]!;
    const publish = async (caseVersion: number, patch = {}) => pipeline.publishRevision({ companyId, caseId: row.id,
      producerPluginId: producer.pluginId, producerPluginKey: producer.pluginKey, expectedVersion: caseVersion, baseRevisionId: base,
      requestKey: "source:" + request.operationId, sourceWriteId: request.operationId, revisionId: next, contentDigest: digest, reason: "Publish verified source", ...patch });
    return { companyId, project: project!, author: author!, workspace: workspace!, issue: issue!, row, pipeline, work, request, reply, execute, preflight, editor, readCase, publish };
  }

  it("previews without reserving a writer, changing assignment, or invalidating the case", async () => {
    const f = await seed(), receipt = await f.editor.edit(f.workspace.id, f.companyId, { ...f.request, mode: "preview" });
    expect(receipt).toMatchObject({ published: false, caseVersion: f.row.version, workTurn: 0 });
    expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ issueId: f.issue.id, turn: 0, sourceWriteId: null, sourceRevisionId: base });
    expect((await f.readCase()).version).toBe(f.row.version);
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.request.operationId))).toHaveLength(0);
  });
  it("resolves company HTTPS publication auth after preflight and the native reservation, without persisting the token", async () => {
    const f = await seed(), url = "https://github.com/fixture/spec";
    f.preflight.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ ok: true, remoteUrl: url }) });
    const auth = vi.fn(async () => gitCredentials.buildGitAuthInvocation({ token: "fixture-source-token", source: "company_secret", secretName: "GITHUB_TOKEN" }));
    const provider = vi.spyOn(gitCredentials, "createGitRemoteAuthProvider").mockReturnValue(auth);
    try {
      await f.editor.edit(f.workspace.id, f.companyId, { ...f.request, mode: "preview" });
      expect(provider).not.toHaveBeenCalled(); expect(f.preflight).not.toHaveBeenCalled();
      const receipt = await f.editor.edit(f.workspace.id, f.companyId, f.request);
      expect(f.preflight.mock.invocationCallOrder[0]).toBeLessThan(provider.mock.invocationCallOrder[0]!);
      expect(provider).toHaveBeenCalledWith(db, f.companyId, { issueId: f.issue.id, heartbeatRunId: null, responsibleUserId: actor.userId });
      expect(auth).toHaveBeenCalledWith(url);
      const calls = f.execute.mock.calls as unknown as [{ env?: Record<string, string>; stdin?: string }][];
      expect(calls[1]![0].env?.PAPERCLIP_GIT_TOKEN).toBeUndefined(); // prepare
      expect(calls[2]![0].env).toMatchObject({ PAPERCLIP_GIT_TOKEN: "fixture-source-token", PAPERCLIP_WORKSPACE_EDIT_ORIGIN: url });
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.request.operationId));
      expect(JSON.stringify([receipt, operation, calls.map(([args]) => args.stdin)])).not.toContain("fixture-source-token");
    } finally { provider.mockRestore(); }
  });
  it("parks the same task and blocks native handoff, approval, checkout, workspace cleanup and unrelated publication", async () => {
    const f = await seed(), receipt = await f.editor.edit(f.workspace.id, f.companyId, f.request);
    expect(receipt).toMatchObject({ published: true, caseVersion: f.row.version + 1, workTurn: 1 });
    expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ issueId: f.issue.id, role: "waiting", agentId: null, sourceWriteId: f.request.operationId });
    await expect(f.work.handoff(f.companyId, f.row.id, { expectedTurn: 1, expectedAgentId: null, requestKey: "racing-author", role: "author",
      agentId: f.author.id, revisionId: base, reason: "Race" })).rejects.toMatchObject({ details: { code: "source_write_pending" } });
    await expect(f.pipeline.transitionCase({ companyId: f.companyId, caseId: f.row.id, expectedVersion: receipt.caseVersion,
      toStageKey: "done", force: true, reason: "Bypass", actor })).rejects.toMatchObject({ details: { code: "source_write_pending" } });
    await expect(f.pipeline.patchCaseContent({ companyId: f.companyId, caseId: f.row.id, expectedVersion: receipt.caseVersion,
      title: "Changed under source writer", actor })).rejects.toMatchObject({ details: { code: "source_write_pending" } });
    await expect(issueService(db).checkout(f.issue.id, f.author.id, ["in_review"], null)).rejects.toMatchObject({ details: { code: "source_write_pending" } });
    await expect(executionWorkspaceService(db).archiveWorkspaceUnderLifecycleLock({ id: f.workspace.id, patch: {}, closedAt: new Date() }))
      .rejects.toMatchObject({ details: { code: "source_write_pending" } });
    await expect(f.publish(receipt.caseVersion, { sourceWriteId: undefined })).rejects.toMatchObject({ details: { code: "source_write_pending" } });
    await expect(f.publish(receipt.caseVersion, { revisionId: "d".repeat(40) })).rejects.toMatchObject({ details: { code: "source_write_not_ready" } });
    await f.publish(receipt.caseVersion);
    expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ issueId: f.issue.id, sourceRevisionId: next, sourceWriteId: null, turn: 1 });
    expect(await f.editor.edit(f.workspace.id, f.companyId, f.request)).toEqual(receipt);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("retains a reservation through a lost execution response and replays the same operation", async () => {
    const f = await seed(); f.execute.mockRejectedValueOnce(new Error("Response lost"));
    await expect(f.editor.edit(f.workspace.id, f.companyId, f.request)).rejects.toThrow("Response lost");
    expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ sourceWriteId: f.request.operationId, turn: 1 });
    await expect(f.editor.edit(f.workspace.id, f.companyId, { ...f.request, reason: "Replace the old request" }))
      .rejects.toMatchObject({ details: { code: "edit_request_conflict" } });
    const receipt = await f.editor.edit(f.workspace.id, f.companyId, f.request); await f.publish(receipt.caseVersion);
    expect((await f.work.get(f.companyId, f.row.id))!.turns).toHaveLength(1);
  });
  it("proves abandonment before clearing the guard, preserving the issue and review history", async () => {
    const f = await seed(); f.execute.mockResolvedValueOnce({ stdout: JSON.stringify({ ok: false, code: "edit_validation_failed" }), exitCode: 1 });
    await expect(f.editor.edit(f.workspace.id, f.companyId, f.request)).rejects.toMatchObject({ details: { code: "edit_validation_failed" } });
    const { mode: _mode, ...request } = f.request;
    expect(await f.editor.abort(f.workspace.id, f.companyId, request)).toMatchObject({ aborted: true, workTurn: 1 });
    expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ sourceWriteId: null, sourceRevisionId: base, issueId: f.issue.id });
    await expect(f.editor.edit(f.workspace.id, f.companyId, f.request)).rejects.toMatchObject({ details: { code: "edit_aborted" } });
  });
  it("preserves its durable candidate on a lost publication response and resumes without preparation", async () => {
    const f = await seed();
    f.execute.mockResolvedValueOnce(f.reply(f.request, "prepare")).mockRejectedValueOnce(new Error("Publication response lost"));
    await expect(f.editor.edit(f.workspace.id, f.companyId, f.request)).rejects.toThrow("Publication response lost");
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.request.operationId));
    expect(operation!.metadata).toMatchObject({ publicationDispatched: true, recovery: { commitSha: next }, leaseToken: null, leaseUntil: null });
    const { mode: _, ...abort } = f.request;
    await expect(f.editor.abort(f.workspace.id, f.companyId, abort)).rejects.toMatchObject({ details: { code: "edit_publication_uncertain" } });
    expect(f.execute).toHaveBeenCalledTimes(2);
    const receipt = await f.editor.edit(f.workspace.id, f.companyId, f.request);
    expect(f.execute).toHaveBeenCalledTimes(3); await f.publish(receipt.caseVersion);
    expect((await f.work.get(f.companyId, f.row.id))!.issueId).toBe(f.issue.id);
    expect((await f.work.get(f.companyId, f.row.id))!.turns).toHaveLength(1);
  });
  it("rejects a publication receipt for a different candidate while retaining the writer", async () => {
    const f = await seed(), reply = JSON.parse(f.reply().stdout); reply.result.commitSha = "e".repeat(40);
    f.execute.mockResolvedValueOnce(f.reply(f.request, "prepare")).mockResolvedValueOnce({ stdout: JSON.stringify(reply), exitCode: 0 });
    await expect(f.editor.edit(f.workspace.id, f.companyId, f.request)).rejects.toMatchObject({ details: { code: "source_edit_receipt_mismatch" } });
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.request.operationId));
    expect(operation!.metadata).toMatchObject({ recovery: { commitSha: next }, publicationDispatched: true, leaseToken: null });
    expect(operation!.metadata?.result).toBeUndefined();
    expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ issueId: f.issue.id, sourceWriteId: f.request.operationId });
  });
  it("requires the original workspace journal to prove abandonment for legacy reservations", async () => {
    const f = await seed(); f.execute.mockRejectedValueOnce(new Error("Legacy execution response lost"));
    await expect(f.editor.edit(f.workspace.id, f.companyId, f.request)).rejects.toThrow("Legacy execution response lost");
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.request.operationId));
    const legacy = { ...operation!.metadata }; delete legacy.recoveryProtocol;
    await db.update(workspaceOperations).set({ metadata: legacy }).where(eq(workspaceOperations.id, f.request.operationId));
    f.execute.mockResolvedValueOnce({ stdout: JSON.stringify({ ok: false, code: "edit_publication_uncertain" }), exitCode: 1 });
    const { mode: _, ...request } = f.request;
    await expect(f.editor.abort(f.workspace.id, f.companyId, request)).rejects.toMatchObject({ details: { code: "edit_publication_uncertain" } });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ sourceWriteId: f.request.operationId });
  });
  it("persists a copy publication through failed host restoration without dispatching another remote edit", async () => {
    const f = await seed(), cwd = f.workspace.cwd!;
    await db.update(environmentLeases).set({ metadata: { remoteCwd: "/case-workspace", workspaceRealization: {
      mode: "copy", authoritativeRoot: cwd, local: { path: cwd },
    } } }).where(eq(environmentLeases.executionWorkspaceId, f.workspace.id));
    const restore = vi.spyOn(workspacePrograms, "runLocalWorkspaceProgram").mockRejectedValueOnce(new Error("Host restoration interrupted"));
    try {
      await expect(f.editor.edit(f.workspace.id, f.companyId, f.request)).rejects.toThrow("Host restoration interrupted");
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.request.operationId));
      expect(operation!.metadata).toMatchObject({ leaseToken: null, publicationDispatched: true, copyPublication: {
        cwd, operationId: f.request.operationId, baseCommitSha: base, commitSha: next,
      } });
      const { mode: _, ...abort } = f.request;
      await expect(f.editor.abort(f.workspace.id, f.companyId, abort)).rejects.toMatchObject({ details: { code: "edit_already_published" } });
      restore.mockResolvedValueOnce(f.reply());
      const receipt = await f.editor.edit(f.workspace.id, f.companyId, f.request);
      expect(f.execute).toHaveBeenCalledTimes(2); expect(restore).toHaveBeenCalledTimes(2);
      await f.publish(receipt.caseVersion);
      expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ issueId: f.issue.id, turn: 1, sourceWriteId: null, sourceRevisionId: next });
    } finally { restore.mockRestore(); }
  });
  it("records abandonment before a delayed Apply can reserve or execute", async () => {
    const f = await seed(), { mode: _, ...request } = f.request;
    expect(await f.editor.abort(f.workspace.id, f.companyId, request)).toMatchObject({ aborted: true, workTurn: 0 });
    await expect(f.editor.edit(f.workspace.id, f.companyId, f.request)).rejects.toMatchObject({ details: { code: "edit_aborted" } });
    expect(f.execute).not.toHaveBeenCalled();
    expect(await f.work.get(f.companyId, f.row.id)).toMatchObject({ sourceWriteId: null, turn: 0, sourceRevisionId: base });
    expect((await f.readCase()).version).toBe(f.row.version);
  });
  it("refuses active runs and invalidates an ended Author turn before late continuation claims", async () => {
    const f = await seed();
    const turn = await f.work.handoff(f.companyId, f.row.id, { expectedTurn: 0, expectedAgentId: null, requestKey: "author", role: "author",
      agentId: f.author.id, revisionId: base, reason: "Author source" });
    const context = { issueId: f.issue.id, pluginId: producer.pluginId, caseWorkTurn: { caseId: f.row.id, turn: turn.turn, agentId: f.author.id } };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.author.id, status: "running", contextSnapshot: context }).returning();
    const request = { ...f.request, expectedTurn: turn.turn };
    await expect(f.editor.edit(f.workspace.id, f.companyId, request)).rejects.toMatchObject({ details: { code: "run_active" } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run!.id));
    const receipt = await f.editor.edit(f.workspace.id, f.companyId, request);
    const [late] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.author.id, status: "queued", contextSnapshot: context }).returning();
    const claim = () => withSourceWriteClaimGuard(db, f.companyId, f.issue.id, (tx) => tx.update(heartbeatRuns).set({ status: "running" })
      .where(and(eq(heartbeatRuns.id, late!.id), caseWorkRunClaimCondition(f.companyId, f.issue.id, f.author.id, context))).returning());
    await expect(claim()).rejects.toMatchObject({ details: { code: "source_write_pending" } });
    await f.publish(receipt.caseVersion);
    expect(await claim()).toEqual([]);
  });
  it("serializes concurrent Apply calls and enforces company, producer and actor scope", async () => {
    const f = await seed();
    const outcomes = await Promise.allSettled([f.editor.edit(f.workspace.id, f.companyId, f.request), f.editor.edit(f.workspace.id, f.companyId, f.request)]);
    expect(outcomes.some((result) => result.status === "fulfilled")).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect((await f.work.get(f.companyId, f.row.id))!.turns).toHaveLength(1);
    await expect(f.editor.edit(f.workspace.id, randomUUID(), f.request)).rejects.toMatchObject({ status: 404 });
    await expect(f.editor.edit(f.workspace.id, f.companyId, { ...f.request, actorUserId: "forged-user" })).rejects.toThrow("Not an active board member");
    const other = workspaceSourceWritingService(db, { ...producer, pluginId: randomUUID() }, { execute: f.execute } as unknown as EnvironmentRuntimeService);
    await expect(other.edit(f.workspace.id, f.companyId, f.request)).rejects.toMatchObject({ status: 403 });
  });
});
