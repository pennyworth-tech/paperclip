import { execFile } from "node:child_process";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, pipelineCases, pipelineCaseWork } from "@paperclipai/db";
import type { PluginWorkspaceRevisionRequest } from "@paperclipai/plugin-sdk";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { readWorkspaceProgramPlacement, runRemoteWorkspaceProgram, runUnleasedWorkspaceProgram, workspaceProgramCopyRoot, workspaceProgramDirectory } from "./workspace-program-environment.js";

type ContextDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export function sameWorkspaceRepository(metadata: string | null, repositorySsh: string) {
  return metadata?.replace(/^https:\/\/github\.com\//, "git@github.com:").replace(/\.git$/, "") === repositorySsh.replace(/\.git$/, "");
}

export async function readWorkspaceRevisionBinding(db: ContextDb, producer: { pluginId: string; pluginKey: string },
  workspaceId: string, companyId: string, input: PluginWorkspaceRevisionRequest, options: { ignoreVersion?: boolean; forUpdate?: boolean } = {}) {
  const query = db.select({ workspace: executionWorkspaces, case: pipelineCases, work: pipelineCaseWork, issue: issues })
    .from(pipelineCaseWork)
    .innerJoin(pipelineCases, and(eq(pipelineCases.id, pipelineCaseWork.caseId), eq(pipelineCases.companyId, companyId)))
    .innerJoin(issues, and(eq(issues.id, pipelineCaseWork.issueId), eq(issues.companyId, companyId)))
    .innerJoin(executionWorkspaces, and(eq(executionWorkspaces.id, issues.executionWorkspaceId), eq(executionWorkspaces.companyId, companyId)))
    .where(and(eq(pipelineCaseWork.companyId, companyId), eq(pipelineCaseWork.caseId, input.caseId), eq(executionWorkspaces.id, workspaceId)));
  const [row] = await (options.forUpdate ? query.for("update", { of: [pipelineCaseWork, issues] }) : query);
  if (!row) throw notFound("Case workspace not found");
  if (row.work.producerPluginId !== producer.pluginId || row.work.producerPluginKey !== producer.pluginKey) throw forbidden("Plugin does not own this preparation task");
  if ((!options.ignoreVersion && row.case.version !== input.expectedVersion) || row.work.turn !== input.expectedTurn) {
    throw conflict("Case or preparation turn changed", { code: "source_inspection_stale" });
  }
  if (row.case.workspaceRef?.executionWorkspaceId !== workspaceId || row.workspace.projectId !== row.issue.projectId
    || row.workspace.status !== "active" || row.workspace.closedAt || !sameWorkspaceRepository(row.workspace.repoUrl, input.repositorySsh)
    || row.workspace.branchName !== input.branch || row.case.fields.changeId !== input.changeId || row.case.fields.branch !== input.branch) {
    throw conflict("Case and workspace coordinates must match", { code: "workspace_mismatch" });
  }
  return row;
}

export function runLocalWorkspaceProgram(cwd: string, program: string, input: unknown, timeoutMs = 180_000) {
  if (timeoutMs < 1000) throw conflict("The workspace execution deadline has expired", { code: "workspace_environment_unavailable" });
  return new Promise<{ stdout: string; exitCode: number | null }>((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", program], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (!stdout) { reject(unprocessable("Workspace execution did not return a receipt; resume the same operation", { code: "workspace_execution_unavailable" })); return; }
      resolve({ stdout, exitCode: error ? typeof error.code === "number" ? error.code : null : 0 });
    });
    child.stdin?.on("error", () => {}); child.stdin?.end(JSON.stringify(input));
  });
}

/** The program is host-owned, never a plugin-supplied command or executable. */
export async function executeWorkspaceRevisionProgram(db: Db, runtime: EnvironmentRuntimeService,
  binding: Awaited<ReturnType<typeof readWorkspaceRevisionBinding>>, program: string, input: unknown, options: { deadline?: number } = {}) {
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 180_000);
  const placement = await readWorkspaceProgramPlacement(db, binding);
  if (placement.environment.driver !== "local") {
    if (!placement.lease) return runUnleasedWorkspaceProgram(db, runtime, binding, placement, program, input, deadline);
    const copyRestoreCwd = workspaceProgramCopyRoot(binding, placement.lease);
    const edit = input as { mode?: string; recovery?: unknown };
    if (copyRestoreCwd && edit.mode === "apply" && !edit.recovery) throw conflict("This edit needs its original workspace journal", { code: "source_edit_legacy_copy_unavailable" });
    const result = await runRemoteWorkspaceProgram(db, runtime, binding, placement.environment, placement.lease,
      workspaceProgramDirectory(binding, placement.environment, placement.lease), program, input, deadline);
    return { ...result, ...(copyRestoreCwd ? { copyRestoreCwd } : {}) };
  }
  if (["local_fs", "git_worktree"].includes(binding.workspace.providerType) && binding.workspace.cwd) {
    return runLocalWorkspaceProgram(binding.workspace.cwd, program, input, deadline - Date.now());
  }
  throw conflict("The workspace's execution environment is unavailable", { code: "workspace_environment_unavailable" });
}
