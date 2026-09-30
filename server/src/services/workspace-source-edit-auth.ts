import type { Db } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { createGitRemoteAuthProvider } from "./git-credentials.js";
import type { WorkspaceProgramEnv } from "./workspace-program-environment.js";
import { sameWorkspaceRepository } from "./workspace-repository.js";
import { readWorkspaceRevisionOrigin } from "./workspace-revision-origin.js";

// An edit retry can already be at its candidate HEAD. The edit program checks
// that HEAD against its durable journal; this credential-free preflight checks
// repository identity/configuration without preventing that recovery.
export const workspaceSourceEditOriginProgram = "const __name=(fn,name)=>Object.defineProperty(fn,'name',{value:name,configurable:true}); "
  + "try { const remoteUrl=(" + readWorkspaceRevisionOrigin.toString() + ")(JSON.parse(require('node:fs').readFileSync(0,'utf8')), "
  + sameWorkspaceRepository.toString() + ", false); process.stdout.write(JSON.stringify({ok:true,remoteUrl})); } "
  + "catch(error) { process.stdout.write(JSON.stringify({ok:false,code:/^[a-z][a-z0-9_]*$/.test(error.message)?error.message:'source_edit_failed'})); process.exitCode=1; }";

/** Only publication resolves a credential, after workspace and writer checks. */
export function workspaceSourceEditAuthEnv(db: Db, companyId: string, repositorySsh: string,
  validateWriter: () => Promise<{ issueId: string; heartbeatRunId: string | null; responsibleUserId: string }>): WorkspaceProgramEnv {
  return async (execute) => {
    const preflight = await execute(workspaceSourceEditOriginProgram);
    let receipt: { ok?: boolean; remoteUrl?: string; code?: string };
    try { receipt = JSON.parse(preflight.stdout); }
    catch { throw unprocessable("Invalid source-edit preflight receipt", { code: "source_edit_failed" }); }
    if (preflight.exitCode !== 0 || !receipt.ok || typeof receipt.remoteUrl !== "string"
      || !sameWorkspaceRepository(receipt.remoteUrl, repositorySsh)) {
      throw unprocessable("Source-edit preflight failed", {
        code: /^[a-z][a-z0-9_]*$/.test(receipt.code ?? "") ? receipt.code : "source_edit_failed",
      });
    }
    const context = await validateWriter();
    const env: Record<string, string> = { PAPERCLIP_WORKSPACE_EDIT_ORIGIN: receipt.remoteUrl };
    if (!receipt.remoteUrl.startsWith("https://")) return env;
    const auth = await createGitRemoteAuthProvider(db, companyId, context)(receipt.remoteUrl);
    if (auth) {
      Object.assign(env, auth.env, { GIT_CONFIG_COUNT: String(auth.configArgs.length / 2) });
      for (let i = 0; i < auth.configArgs.length; i += 2) {
        const config = auth.configArgs[i + 1]!, separator = config.indexOf("=");
        env[`GIT_CONFIG_KEY_${i / 2}`] = config.slice(0, separator);
        env[`GIT_CONFIG_VALUE_${i / 2}`] = config.slice(separator + 1);
      }
    }
    return env;
  };
}
