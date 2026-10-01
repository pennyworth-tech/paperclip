import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkspaceOpenSpecPolicy } from "../services/workspace-openspec-policy.js";
import { readSourceEditInspection } from "../services/workspace-source-edit-inspection.js";

const directories: string[] = [];
const configure = (value: unknown) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-policy-")); directories.push(directory);
  const file = path.join(directory, "policy.json");
  fs.writeFileSync(file, JSON.stringify(value)); vi.stubEnv("PAPERCLIP_OPENSPEC_POLICY_FILE", file); return file;
};
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
describe("operator OpenSpec policy boundary", () => {
  it("has no implicit repository execution approval", () => {
    vi.stubEnv("PAPERCLIP_OPENSPEC_POLICY_FILE", undefined);
    expect(readWorkspaceOpenSpecPolicy()).toEqual({ format: 1, schemas: [] });
  });
  it("accepts a digest and requirement, never commands or arbitrary paths", () => {
    const entry = { schemaName: "example-review", requireReviewDeck: true, rendererSha256: "a".repeat(64) };
    configure({ format: 1, schemas: [entry] }); expect(readWorkspaceOpenSpecPolicy().schemas).toEqual([entry]);
    for (const patch of [{ command: "sh" }, { path: "/tmp/script" }, { schemaName: "../escape" }, { rendererSha256: "HEAD" }, { requireReviewDeck: false }]) {
      configure({ format: 1, schemas: [{ ...entry, ...patch }] });
      expect(readWorkspaceOpenSpecPolicy).toThrow("workspace_openspec_policy_invalid");
    }
    configure({ format: 1, schemas: [entry, entry] }); expect(readWorkspaceOpenSpecPolicy).toThrow("workspace_openspec_policy_invalid");
  });
  it("rejects unavailable, relative, linked, non-file and oversized policy instead of disabling it", () => {
    const file = configure({ format: 1, schemas: [] });
    for (const value of ["", "policy.json", file + ".missing", path.dirname(file)]) {
      vi.stubEnv("PAPERCLIP_OPENSPEC_POLICY_FILE", value); expect(readWorkspaceOpenSpecPolicy).toThrow("workspace_openspec_policy_invalid");
    }
    fs.symlinkSync(file, file + ".link"); vi.stubEnv("PAPERCLIP_OPENSPEC_POLICY_FILE", file + ".link");
    expect(readWorkspaceOpenSpecPolicy).toThrow("workspace_openspec_policy_invalid");
    fs.writeFileSync(file, " ".repeat(65_537)); vi.stubEnv("PAPERCLIP_OPENSPEC_POLICY_FILE", file);
    expect(readWorkspaceOpenSpecPolicy).toThrow("workspace_openspec_policy_invalid");
  });
  it("retains the original required-deck invariant in a stored inspection", () => {
    const inspection = { files: [], cli: { version: "test", status: { schemaName: "example-review", isComplete: true, reviewDeckRequired: true },
      validation: { items: [{ id: "example-change", valid: true }] }, readiness: { state: "ready", reasons: [], deck: "not_required" } } };
    expect(() => readSourceEditInspection(inspection, "example-change", (value) => value)).toThrow("source_edit_inspection_invalid");
    inspection.cli.readiness.deck = "verified";
    expect(readSourceEditInspection(inspection, "example-change", (value) => value).inspection).toEqual(inspection);
  });
});
