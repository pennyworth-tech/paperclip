import { execFile } from "node:child_process";
import { z } from "zod";
import type { PluginWorkspaceEditRequest, PluginWorkspaceEditAbortRequest } from "@paperclipai/plugin-sdk";
import { unprocessable } from "../errors.js";
import { workspaceRevisionRequestSchema } from "./workspace-revision-inspection.js";
import { workspaceSourceEditProgram } from "./workspace-source-edit-program.js";

const fileSchema = z.object({
  path: z.string().max(240).regex(/^(?:(?:research|proposal|design|tasks)\.md|specs\/[a-z0-9][a-z0-9-]*\/spec\.md)$/),
  baseSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  text: z.string().refine((value) => !value.includes("\0") && Buffer.byteLength(value) <= 1_000_000
    && Buffer.from(value).toString("utf8") === value, "File must be bounded UTF-8 text").nullable(),
}).strict().refine((file) => file.baseSha256 !== null || file.text !== null, "Cannot delete an absent file");
const edits = {
  operationId: z.string().uuid(), actorUserId: z.string().min(1).max(200).regex(/^\S+$/), reason: z.string().trim().min(1).max(2000),
  files: z.array(fileSchema).min(1).max(50).refine((files) => new Set(files.map((file) => file.path)).size === files.length
    && Buffer.byteLength(JSON.stringify(files)) <= 4_000_000, "Edits must be unique and bounded"),
};
export const workspaceEditRequestSchema = workspaceRevisionRequestSchema.extend({ ...edits, mode: z.enum(["preview", "apply"]) }).strict();
export const workspaceEditAbortSchema = workspaceRevisionRequestSchema.extend(edits).strict();

/** Internal executor only. A callable host port must first reserve the native
 * case/workspace writer, authenticate the actor, and block approval/dispatch
 * until publication or proven abandonment completes. */
export function runLocalWorkspaceSourceEdit(cwd: string, input: PluginWorkspaceEditRequest | (PluginWorkspaceEditAbortRequest & { mode: "abort" })) {
  return new Promise<{ stdout: string; exitCode: number | null }>((resolve, reject) => {
    const child = execFile(process.execPath, ["-e", workspaceSourceEditProgram],
      { cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
        if (!stdout) { reject(unprocessable("Source editing did not return a receipt; resume the same operation", { code: "source_edit_unavailable" })); return; }
        resolve({ stdout, exitCode: error ? typeof error.code === "number" ? error.code : null : 0 });
      });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}
