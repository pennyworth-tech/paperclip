import { describe, expect, it } from "vitest";
import { applyChildEnvAllowlist, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("is not the security boundary: a non-PAPERCLIP_ host secret survives it", () => {
    // The sanitizer only covers the PAPERCLIP_* namespace, so the server's own
    // DATABASE_URL passed straight through to every spawned harness. The
    // allowlist is the pass that actually stops it.
    const sanitized = sanitizeInheritedPaperclipEnv({
      DATABASE_URL: "postgres://paperclip:secret@127.0.0.1:5432/paperclip",
      PATH: "/usr/bin",
    });
    expect(sanitized.DATABASE_URL).toBe("postgres://paperclip:secret@127.0.0.1:5432/paperclip");

    expect(applyChildEnvAllowlist(sanitized).env.DATABASE_URL).toBeUndefined();
  });
});
