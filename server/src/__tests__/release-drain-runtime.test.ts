import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectReleaseDrainProcess, inspectReleaseDrainResources, trackReleaseDrainOperation, releaseDrainOperationCount } from "../services/release-drain-runtime.js";

afterEach(() => vi.restoreAllMocks());

describe("release drain evidence", () => {
  it("treats permission errors and invalid process identities as unknown", () => {
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect(inspectReleaseDrainProcess(123)).toBe("unknown");
    expect(inspectReleaseDrainProcess(123, true)).toBe("unknown");
    expect(inspectReleaseDrainProcess(-1)).toBe("unknown");
  });

  it("treats only ESRCH as evidence of process exit", () => {
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
    expect(inspectReleaseDrainProcess(123)).toBe("absent");
    expect(inspectReleaseDrainProcess(123, true)).toBe("absent");
  });

  it("fails closed when the Docker execution domain is undeclared", async () => {
    const resources = await inspectReleaseDrainResources({});
    expect(resources.unknown).toContain("docker_execution_domain_undeclared");
  });

  it("tracks in-flight lifecycle work through rejection and cleanup", async () => {
    let finish!: () => void;
    const operation = trackReleaseDrainOperation(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      throw new Error("fixture failure");
    });
    expect(releaseDrainOperationCount()).toBe(1);
    finish();
    await expect(operation).rejects.toThrow("fixture failure");
    expect(releaseDrainOperationCount()).toBe(0);
  });
});
