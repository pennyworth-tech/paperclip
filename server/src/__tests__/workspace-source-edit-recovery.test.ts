import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PluginWorkspaceEditAbortRequest } from "@paperclipai/plugin-sdk";
import { readSourceEditRecovery, runDurableSourceEdit, sourceEditCandidateRequestDigest,
  type PreparedSourceEditCheckpoint, type SourceEditCheckpoint, type SourceEditProgramInput, type SourceEditRecovery } from "../services/workspace-source-edit-recovery.js";

function fixture() {
  const input: PluginWorkspaceEditAbortRequest = { caseId: randomUUID(), expectedVersion: 2, expectedTurn: 3, operationId: randomUUID(),
    commitSha: "a".repeat(40), repositorySsh: "git@github.com:fixture/spec.git", branch: "openspec/fixture-change", changeId: "fixture-change",
    actorUserId: "operator", reason: "Clarify the spec", files: [{ path: "proposal.md", baseSha256: "a".repeat(64), text: "Proposed clarification" }] };
  const bundle = Buffer.from("Fixture only; real Git bundle execution is covered in workspace-source-edit.test.ts");
  const recovery: SourceEditRecovery = { protocol: "openspec-source-candidate/v1", operationId: input.operationId, baseCommitSha: input.commitSha,
    requestDigest: sourceEditCandidateRequestDigest(input), createdAt: "2026-09-28T00:00:00.000Z", commitSha: "b".repeat(40),
    inputCommitSha: "c".repeat(40), sourceDigest: "d".repeat(64), bundleSha256: createHash("sha256").update(bundle).digest("hex"), bundleBase64: bundle.toString("base64") };
  const applied = { stdout: JSON.stringify({ ok: true, result: { commitSha: recovery.commitSha } }), exitCode: 0 };
  let stored: SourceEditCheckpoint = {};
  const save = vi.fn(async (checkpoint: PreparedSourceEditCheckpoint) => { stored = structuredClone(checkpoint); });
  const execute = vi.fn(async (request: SourceEditProgramInput) => {
    if (request.mode === "prepare") return { stdout: JSON.stringify({ ok: true, result: { prepared: true, recovery } }), exitCode: 0 };
    expect(stored).toEqual({ recovery, publicationDispatched: true });
    expect(request).toEqual({ ...input, mode: "apply", recovery });
    return applied;
  });
  return { input, recovery, applied, execute, save, stored: () => structuredClone(stored) };
}

describe("durable source edit publication", () => {
  it("persists the exact candidate and dispatch marker before Apply", async () => {
    const f = fixture();
    expect(await runDurableSourceEdit(f.input, false, {}, f)).toEqual(f.applied);
    expect(f.execute.mock.calls.map(([request]) => request.mode)).toEqual(["prepare", "apply"]);
    expect(f.save.mock.calls.map(([checkpoint]) => checkpoint.publicationDispatched)).toEqual([false, true]);
  });
  it("cannot dispatch if either durable write fails", async () => {
    for (const failAt of [1, 2]) {
      const f = fixture(); let writes = 0;
      const save = vi.fn(async () => { if (++writes === failAt) throw new Error("Native lease lost"); });
      await expect(runDurableSourceEdit(f.input, false, {}, { execute: f.execute, save })).rejects.toThrow("Native lease lost");
      expect(f.execute.mock.calls.map(([request]) => request.mode)).toEqual(["prepare"]);
    }
  });
  it("reuses its stored candidate after a lost Apply response and refuses abandonment", async () => {
    const f = fixture(); f.execute.mockImplementationOnce(async () => ({ stdout: JSON.stringify({ ok: true, result: { prepared: true, recovery: f.recovery } }), exitCode: 0 }));
    f.execute.mockRejectedValueOnce(new Error("Sandbox response lost"));
    await expect(runDurableSourceEdit(f.input, false, {}, f)).rejects.toThrow("Sandbox response lost");
    expect(f.stored()).toEqual({ recovery: f.recovery, publicationDispatched: true });
    await expect(runDurableSourceEdit(f.input, true, f.stored(), f)).rejects.toMatchObject({ details: { code: "edit_publication_uncertain" } });
    f.execute.mockClear();
    expect(await runDurableSourceEdit(f.input, false, f.stored(), f)).toEqual(f.applied);
    expect(f.execute.mock.calls.map(([request]) => request.mode)).toEqual(["apply"]);
  });
  it("allows abandonment of preparation without relying on a vanished sandbox", async () => {
    const f = fixture(); const execution = await runDurableSourceEdit(f.input, true, { recovery: f.recovery, publicationDispatched: false }, f);
    expect(JSON.parse(execution.stdout)).toEqual({ ok: true, result: { operationId: f.input.operationId, aborted: true } });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
  });
  it("preserves typed validation failures without storing or dispatching publication", async () => {
    const f = fixture(), failure = { stdout: JSON.stringify({ ok: false, code: "edit_validation_failed" }), exitCode: 1 };
    f.execute.mockResolvedValue(failure);
    expect(await runDurableSourceEdit(f.input, false, {}, f)).toEqual(failure);
    expect(f.save).not.toHaveBeenCalled(); expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("refuses regeneration when dispatch was recorded but its candidate is missing", async () => {
    const f = fixture();
    await expect(runDurableSourceEdit(f.input, false, { publicationDispatched: true }, f))
      .rejects.toMatchObject({ details: { code: "source_edit_recovery_missing" } });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects changed inputs, corrupt bytes, and oversized recovery before execution", async () => {
    const f = fixture();
    for (const recovery of [{ ...f.recovery, requestDigest: "e".repeat(64) }, { ...f.recovery, bundleBase64: "broken" },
      { ...f.recovery, bundleBase64: "A".repeat(5_333_337) }, { ...f.recovery, createdAt: "invalid" }]) {
      await expect(runDurableSourceEdit(f.input, false, { recovery }, f)).rejects.toMatchObject({ details: { code: "source_edit_recovery_invalid" } });
    }
    expect(f.execute).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled();
    expect(readSourceEditRecovery({ ...f.recovery, unsafe: "drop this" }, f.input)).toEqual(f.recovery);
  });
  it("records successful copy publication before restoring and resumes restoration without remote execution", async () => {
    const f = fixture(), copyPublication = { cwd: "/canonical/case", operationId: f.input.operationId, baseCommitSha: f.input.commitSha,
      commitSha: f.recovery.commitSha, inputCommitSha: f.recovery.inputCommitSha, sourceDigest: f.recovery.sourceDigest, cliVersion: "1.2.0" };
    f.execute.mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true, result: { ...copyPublication, published: true,
      validation: { passed: true, cliVersion: "1.2.0" } } }), exitCode: 0, copyRestoreCwd: copyPublication.cwd } as never);
    const restore = vi.fn(async (request: SourceEditProgramInput, cwd: string) => {
      expect(f.stored()).toMatchObject({ copyPublication });
      expect(request).toEqual({ ...f.input, mode: "restore", recovery: f.recovery, publication: copyPublication });
      expect(cwd).toBe(copyPublication.cwd); throw new Error("Concurrent staged work");
    });
    await expect(runDurableSourceEdit(f.input, false, { recovery: f.recovery }, { ...f, restore })).rejects.toThrow("Concurrent staged work");
    expect(f.execute).toHaveBeenCalledTimes(1); expect(restore).toHaveBeenCalledTimes(1);
    const restored = { ...f.applied }; restore.mockResolvedValueOnce(restored as never);
    expect(await runDurableSourceEdit(f.input, false, f.stored(), { ...f, restore })).toEqual(restored);
    expect(f.execute).toHaveBeenCalledTimes(1); expect(restore).toHaveBeenCalledTimes(2);
  });
  it("does not restore an unacknowledged or mismatched copy publication", async () => {
    const f = fixture(), restore = vi.fn(), save = vi.fn(async (checkpoint: PreparedSourceEditCheckpoint) => {
      if (checkpoint.copyPublication) throw new Error("Publication checkpoint lost");
    });
    const reply = { stdout: JSON.stringify({ ok: true, result: { ...f.recovery, published: true, validation: { passed: true, cliVersion: "1.2.0" } } }),
      exitCode: 0, copyRestoreCwd: "/canonical/case" };
    f.execute.mockResolvedValue(reply);
    await expect(runDurableSourceEdit(f.input, false, { recovery: f.recovery }, { execute: f.execute, save, restore }))
      .rejects.toThrow("Publication checkpoint lost");
    expect(restore).not.toHaveBeenCalled();
    const bad = JSON.parse(reply.stdout); bad.result.commitSha = "f".repeat(40);
    f.execute.mockResolvedValue({ ...reply, stdout: JSON.stringify(bad) });
    await expect(runDurableSourceEdit(f.input, false, { recovery: f.recovery }, { execute: f.execute, save, restore }))
      .rejects.toMatchObject({ details: { code: "source_copy_receipt_invalid" } });
    expect(restore).not.toHaveBeenCalled();
  });
  it("cannot promote a saved draft through a changed copy publication receipt", async () => {
    const f = fixture(), restore = vi.fn(async (_request: SourceEditProgramInput, _cwd: string) => f.applied);
    f.recovery.inspection = { files: [{ path: "openspec/changes/fixture-change/proposal.md", sha256: "e".repeat(64) }], cli: {
      version: "1.2.0", status: { schemaName: "example-review", isComplete: false },
      validation: { items: [{ id: f.input.changeId, valid: false }] },
      readiness: { state: "draft", reasons: ["artifacts_incomplete"], deck: "missing" },
    } };
    f.recovery.inspectionDigest = createHash("sha256").update(JSON.stringify(f.recovery.inspection)).digest("hex");
    const result = { operationId: f.input.operationId, baseCommitSha: f.input.commitSha, commitSha: f.recovery.commitSha,
      inputCommitSha: f.recovery.inputCommitSha, sourceDigest: f.recovery.sourceDigest, inspectionDigest: f.recovery.inspectionDigest,
      published: true, validation: { passed: false, cliVersion: "1.2.0" } };
    for (const changed of [{ ...result, validation: { passed: true, cliVersion: "1.2.0" } }, { ...result, inspectionDigest: "f".repeat(64) }]) {
      f.execute.mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true, result: changed }), exitCode: 0, copyRestoreCwd: "/canonical/case" } as never);
      await expect(runDurableSourceEdit(f.input, false, { recovery: f.recovery }, { ...f, restore }))
        .rejects.toMatchObject({ details: { code: "source_copy_receipt_invalid" } });
      expect(restore).not.toHaveBeenCalled(); expect(f.stored().copyPublication).toBeUndefined();
    }
    f.execute.mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true, result }), exitCode: 0, copyRestoreCwd: "/canonical/case" } as never);
    expect(await runDurableSourceEdit(f.input, false, { recovery: f.recovery }, { ...f, restore })).toEqual(f.applied);
    expect(f.stored().copyPublication?.inspectionDigest).toBe(f.recovery.inspectionDigest);
    expect(restore.mock.calls[0]![0]).toMatchObject({ mode: "restore", recovery: { inspection: { cli: { readiness: { state: "draft" } } } } });
  });
});
