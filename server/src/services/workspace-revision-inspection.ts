import { createHash } from "node:crypto";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import type { PluginWorkspaceRevisionInspection } from "@paperclipai/plugin-sdk";
import { conflict, unprocessable } from "../errors.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import { workspaceRevisionInspectionProgram } from "./workspace-revision-inspection-program.js";
import { workspaceRevisionOriginProgram } from "./workspace-revision-origin.js";
import { sameWorkspaceRepository } from "./workspace-repository.js";
import type { WorkspaceProgramEnv } from "./workspace-program-environment.js";
import { executeWorkspaceRevisionProgram, readWorkspaceRevisionBinding, runLocalWorkspaceProgram } from "./workspace-revision-context.js";
export { sameWorkspaceRepository } from "./workspace-revision-context.js";

export const workspaceRevisionRequestSchema = z.object({
  caseId: z.string().uuid(), expectedVersion: z.number().int().positive(), expectedTurn: z.number().int().nonnegative(),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/), repositorySsh: z.string().regex(/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/),
  branch: z.string().min(1).max(200), changeId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,99}$/),
}).strict();

/** No shell, arbitrary command, path, environment or executable argument is exposed to plugins. */
export function runLocalRevisionInspection(cwd: string, input: z.infer<typeof workspaceRevisionRequestSchema>) {
  return runLocalWorkspaceProgram(cwd, workspaceRevisionInspectionProgram, input);
}

export function workspaceRevisionInspectionService(db: Db, producer: { pluginId: string; pluginKey: string },
  runtime: EnvironmentRuntimeService) {
  return {
    async inspect(workspaceId: string, companyId: string, raw: unknown): Promise<PluginWorkspaceRevisionInspection> {
      const parsed = workspaceRevisionRequestSchema.safeParse(raw);
      if (!parsed.success) throw unprocessable("Invalid revision inspection", { code: "validation" });
      const input = parsed.data;
      const readBinding = () => readWorkspaceRevisionBinding(db, producer, workspaceId, companyId, input);
      const binding = await readBinding();
      const env: WorkspaceProgramEnv = async (execute) => {
        // Validate the actual origin and unsafe repository config without a
        // credential, inside the same placement used for the full inspection.
        const preflight = await execute(workspaceRevisionOriginProgram);
        let receipt: { ok: boolean; remoteUrl?: string; code?: string };
        try { receipt = JSON.parse(preflight.stdout); }
        catch { throw unprocessable("Invalid workspace preflight receipt", { code: "source_inspection_failed" }); }
        if (preflight.exitCode !== 0 || !receipt.ok || typeof receipt.remoteUrl !== "string"
          || !sameWorkspaceRepository(receipt.remoteUrl, input.repositorySsh)) {
          throw unprocessable("Source preflight failed", { code: /^[a-z][a-z0-9_]*$/.test(receipt.code ?? "") ? receipt.code : "source_inspection_failed" });
        }
        const resolved: Record<string, string> = { PAPERCLIP_WORKSPACE_INSPECTION_ORIGIN: receipt.remoteUrl };
        if (!receipt.remoteUrl.startsWith("https://")) return resolved;
        const current = await readBinding();
        if (current.issue.checkoutRunId !== binding.issue.checkoutRunId) throw conflict("Checkout changed during inspection", { code: "source_inspection_stale" });
        const auth = await createGitRemoteAuthProvider(db, companyId, {
          issueId: binding.issue.id, heartbeatRunId: binding.issue.checkoutRunId,
        })(receipt.remoteUrl);
        if (auth) {
          Object.assign(resolved, auth.env, { GIT_CONFIG_COUNT: String(auth.configArgs.length / 2) });
          for (let i = 0; i < auth.configArgs.length; i += 2) {
            const config = auth.configArgs[i + 1]!, separator = config.indexOf("=");
            resolved[`GIT_CONFIG_KEY_${i / 2}`] = config.slice(0, separator);
            resolved[`GIT_CONFIG_VALUE_${i / 2}`] = config.slice(separator + 1);
          }
        }
        return resolved;
      };
      const execution = await executeWorkspaceRevisionProgram(db, runtime, binding, workspaceRevisionInspectionProgram, input, { env });
      let response: { ok: boolean; code?: string; result?: Omit<PluginWorkspaceRevisionInspection,
        "workspaceId" | "caseId" | "caseVersion" | "workTurn" | "inspectedAt" | "inspectionDigest"> };
      try { response = JSON.parse(execution.stdout); }
      catch { throw unprocessable("Invalid workspace inspection receipt", { code: "source_inspection_failed" }); }
      if (execution.exitCode !== 0 || !response.ok || !response.result) {
        throw unprocessable("Source inspection failed", { code: /^[a-z][a-z0-9_]*$/.test(response.code ?? "") ? response.code : "source_inspection_failed" });
      }
      const current = await readBinding();
      if (current.issue.checkoutRunId !== binding.issue.checkoutRunId) throw conflict("Checkout changed during inspection", { code: "source_inspection_stale" });
      const inspectedAt = new Date().toISOString();
      const inspectionDigest = createHash("sha256").update(JSON.stringify(response.result)).digest("hex");
      await db.insert(activityLog).values({ companyId, actorType: "system", actorId: producer.pluginKey, action: "pipeline.source_inspected",
        entityType: "pipeline_case", entityId: input.caseId, details: { pluginId: producer.pluginId, workspaceId, commitSha: input.commitSha, inspectionDigest } });
      return { ...response.result, workspaceId, caseId: input.caseId, caseVersion: input.expectedVersion,
        workTurn: input.expectedTurn, inspectedAt, inspectionDigest };
    },
  };
}
