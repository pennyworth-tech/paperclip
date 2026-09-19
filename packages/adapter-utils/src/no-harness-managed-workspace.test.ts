import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Paperclip owns the execution workspace. It creates the worktree, it records
 * which run holds it, and it defers a second run through the workspace-busy
 * ladder. A harness that makes its OWN worktree, or that declines to persist a
 * session, takes that ownership back silently -- the run would then edit a
 * directory Paperclip is not tracking, and resume would look for a session the
 * harness never kept.
 *
 * Neither failure is loud. Both look like a run that simply did less than
 * expected. So this is an assertion rather than a review note: these flags must
 * stay absent from the adapters this fleet dispatches to.
 *
 * `hermes` is the deliberate exception. It ships a `worktreeMode` config toggle
 * that passes `-w`, it is documented as doing so, and nothing in this fleet
 * dispatches to it.
 */

const ADAPTER_ROOT = path.resolve(__dirname, "../../adapters");

const FLEET_ADAPTERS = ["claude-local", "codex-local", "opencode-local"] as const;

// Flags that hand workspace or session ownership to the harness.
const FORBIDDEN = [
  "--worktree",
  "--no-session-persistence",
] as const;

describe("adapters this fleet dispatches to leave workspace and session ownership with Paperclip", () => {
  for (const adapter of FLEET_ADAPTERS) {
    const executePath = path.join(ADAPTER_ROOT, adapter, "src/server/execute.ts");

    it(`${adapter} passes no harness-managed workspace or session flag`, () => {
      expect(existsSync(executePath)).toBe(true);
      const source = readFileSync(executePath, "utf8");

      for (const flag of FORBIDDEN) {
        expect(source, `${adapter} must not pass ${flag}`).not.toContain(flag);
      }

      // `-w` is only meaningful as a standalone argument; matching the bare
      // string would catch every `-w` inside an unrelated word.
      expect(
        /["'`]-w["'`]/.test(source),
        `${adapter} must not pass -w`,
      ).toBe(false);
    });
  }

  it("hermes is the known exception and is not in the fleet set", () => {
    const hermes = path.join(ADAPTER_ROOT, "hermes/src/server/execute.ts");
    if (!existsSync(hermes)) return; // hermes is optional in slimmer builds
    expect(readFileSync(hermes, "utf8")).toContain("-w");
    expect(FLEET_ADAPTERS).not.toContain("hermes" as never);
  });
});
