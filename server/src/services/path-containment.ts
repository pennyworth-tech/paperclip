/**
 * Path containment for image-rooted lookups.
 *
 * Several startup paths let a control-plane document name something *inside* a
 * root the image controls — a bundled plugin, a built-in adapter package — and
 * every one of them owes the same guarantee: the resolved path is under that
 * root, with symlinks resolved, or the instance refuses to start.
 *
 * The two helpers live here rather than in one consumer so that guarantee is
 * written once. A second copy is how the two drift, and a containment check
 * that drifts is a containment check that is wrong somewhere.
 *
 * This is the SECOND of two barriers. The first is lexical: a document's
 * `relativePath` is validated on spelling at parse time (see
 * `managed-config.ts`), before any filesystem call. This layer catches what a
 * spelling rule cannot — a symlink planted inside the root.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Canonicalize a path for containment comparison. Symlinks are resolved so a
 * link inside a root cannot point resolution at a directory outside it.
 *
 * A path that does not exist is canonicalized as far as it does: the nearest
 * existing ancestor is resolved with `realpath` and the remaining segments are
 * appended lexically. Resolving only whole paths is wrong in both directions —
 * it reports a missing path under a symlinked root as an escape, and reports a
 * missing path under a symlinked *intermediate* directory as contained when it
 * is not.
 */
export function canonicalize(p: string): string {
  let current = path.resolve(p);
  const trailing: string[] = [];
  // Bounded by construction: every iteration removes one segment, and
  // `path.dirname` of a root is that root, which ends the walk.
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Segment-based containment, never a string-prefix test (which would accept
 * `/app/packages-evil` for root `/app/packages`). The root itself counts as
 * inside; callers that require a strict descendant check that separately.
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
