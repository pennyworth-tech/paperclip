import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const schemaPolicy = z.object({
  schemaName: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  requireReviewDeck: z.boolean(),
  rendererSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((value) => !value.rendererSha256 || value.requireReviewDeck,
  "A renderer produces the required review deck");
const policySchema = z.object({
  format: z.literal(1),
  schemas: z.array(schemaPolicy).max(50).refine((values) => new Set(values.map((value) => value.schemaName)).size === values.length),
}).strict();
export type WorkspaceOpenSpecPolicy = z.infer<typeof policySchema>;

/** Operator-owned configuration, read in the host before generating a remote
 * program. Neither plugin input, repository files nor a remote environment can
 * select a policy. The only executable is the fixed isolated Python renderer;
 * its committed bytes must match an explicitly approved digest. */
export function readWorkspaceOpenSpecPolicy(): WorkspaceOpenSpecPolicy {
  const file = process.env.PAPERCLIP_OPENSPEC_POLICY_FILE;
  if (file === undefined) return { format: 1, schemas: [] };
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(file)) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) throw new Error();
    const bytes = Buffer.alloc(65_537);
    let length = 0, count: number;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > 65_536) throw new Error();
    return policySchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))));
  } catch {
    throw new Error("workspace_openspec_policy_invalid");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
