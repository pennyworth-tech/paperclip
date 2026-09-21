import { describe, expect, it } from "vitest";
import {
  applyChildEnvAllowlist,
  refreshPaperclipWorkspaceEnvForExecution,
} from "./server-utils.js";

describe("applyChildEnvAllowlist", () => {
  it("drops host service credentials that no harness needs", () => {
    const { env, droppedKeys } = applyChildEnvAllowlist({
      DATABASE_URL: "postgres://paperclip:secret@127.0.0.1:5432/paperclip",
      GITHUB_TOKEN: "ghp_hostonly",
      STRIPE_SECRET_KEY: "sk_live_hostonly",
      PATH: "/usr/bin",
    });

    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(droppedKeys).toEqual(["DATABASE_URL", "GITHUB_TOKEN", "STRIPE_SECRET_KEY"]);
  });

  it("reports dropped key names only, never their values", () => {
    const { droppedKeys } = applyChildEnvAllowlist({
      DATABASE_URL: "postgres://paperclip:secret@127.0.0.1:5432/paperclip",
    });

    expect(droppedKeys).toEqual(["DATABASE_URL"]);
    expect(droppedKeys.join(" ")).not.toContain("secret");
  });

  it("keeps the whole PAPERCLIP_ runtime namespace the adapter assigns per run", () => {
    // These arrive through the adapter's curated `opts.env`, not from the host
    // process env. Severing any of them leaves the agent with no control-plane
    // identity, so the namespace is allowed whole rather than enumerated.
    const { env, droppedKeys } = applyChildEnvAllowlist({
      PAPERCLIP_API_KEY: "run-token",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_RUN_ID: "run_1",
      PAPERCLIP_TASK_ID: "TASK-123",
      PAPERCLIP_WAKE_REASON: "comment",
      PAPERCLIP_APPROVAL_ID: "apr_1",
      PAPERCLIP_RUNTIME_SERVICES_JSON: "[]",
      PAPERCLIP_WORKSPACE_CWD: "/w",
      PAPERCLIP_WORKSPACES_JSON: "[]",
    });

    expect(droppedKeys).toEqual([]);
    expect(Object.keys(env)).toHaveLength(9);
  });

  it("keeps process plumbing, workspace identity, harness homes and provider routes", () => {
    const { env, droppedKeys } = applyChildEnvAllowlist({
      PATH: "/usr/bin",
      HOME: "/home/agent",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      AGENT_HOME: "/home/agent/.paperclip/agents/a1",
      XDG_CONFIG_HOME: "/home/agent/.config",
      CLAUDE_CONFIG_DIR: "/home/agent/.claude",
      CODEX_HOME: "/home/agent/.codex",
      ANTHROPIC_API_KEY: "sk-ant-1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-token",
      OPENAI_API_KEY: "sk-openai-1",
      GOOGLE_API_KEY: "google-1",
      LITELLM_PROXY_API_BASE: "https://llm.example",
      HTTPS_PROXY: "http://proxy:8443",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/private-ca.pem",
      GIT_SSH_COMMAND: "ssh -i /home/agent/.ssh/id_ed25519",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    });

    expect(droppedKeys).toEqual([]);
    expect(Object.keys(env)).toHaveLength(20);
  });

  it("passes the per-run LLM gateway attribution tags through by prefix", () => {
    // Every lane assigns LITELLM_TAGS to the run env; the LITELLM_ prefix is
    // what carries it (and any LITELLM_* client setting) into the child.
    const { env, droppedKeys } = applyChildEnvAllowlist({
      PATH: "/usr/bin",
      LITELLM_TAGS: "agent:reviewer,issue:PRJ-12,stage:none",
    });

    expect(droppedKeys).toEqual([]);
    expect(env.LITELLM_TAGS).toBe("agent:reviewer,issue:PRJ-12,stage:none");
  });

  it("keeps the headless shaping and node-version-manager roots the adapters rely on", () => {
    // buildKimiHeadlessEnv writes CI/NO_COLOR, buildGeminiHeadlessEnv writes
    // COLORTERM, and the harness CLI shim reads its root from the version
    // manager. Dropping any of these breaks the spawn or its output shape.
    const { droppedKeys } = applyChildEnvAllowlist({
      CI: "1",
      NO_COLOR: "1",
      COLORTERM: "truecolor",
      NO_BROWSER: "1",
      NVM_DIR: "/home/agent/.nvm",
      VOLTA_HOME: "/home/agent/.volta",
      ASDF_DATA_DIR: "/home/agent/.asdf",
      PNPM_HOME: "/home/agent/.local/share/pnpm",
    });

    expect(droppedKeys).toEqual([]);
  });

  it("matches allowlisted names case-insensitively for the Windows and lowercase-proxy spellings", () => {
    const { env, droppedKeys } = applyChildEnvAllowlist({
      Path: "C:\\Windows\\System32",
      PATHEXT: ".EXE;.CMD",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: "C:\\Users\\agent",
      https_proxy: "http://proxy:8443",
      no_proxy: "localhost",
    });

    expect(droppedKeys).toEqual([]);
    expect(env.Path).toBe("C:\\Windows\\System32");
    expect(env.https_proxy).toBe("http://proxy:8443");
  });

  it("does not re-admit the Claude Code nesting guards by their bare name", () => {
    // `runChildProcess` deletes these before the allowlist runs. CLAUDECODE has
    // no underscore after CLAUDE, so the CLAUDE_ prefix does not cover it and
    // the strip sticks even if a caller re-adds it.
    const { env, droppedKeys } = applyChildEnvAllowlist({ CLAUDECODE: "1", PATH: "/usr/bin" });

    expect(env.CLAUDECODE).toBeUndefined();
    expect(droppedKeys).toEqual(["CLAUDECODE"]);
  });

  it("drops the host-only Paperclip CLI pointer, which is outside the PAPERCLIP_ namespace", () => {
    const { droppedKeys } = applyChildEnvAllowlist({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PATH: "/usr/bin",
    });

    expect(droppedKeys).toEqual(["PAPERCLIPAI_CMD"]);
  });

  it("admits the extra keys a caller declares", () => {
    const { env, droppedKeys } = applyChildEnvAllowlist(
      { GH_TOKEN: "ghp_config", DATABASE_URL: "postgres://host", PATH: "/usr/bin" },
      { additionalAllowed: ["GH_TOKEN"] },
    );

    expect(env.GH_TOKEN).toBe("ghp_config");
    expect(droppedKeys).toEqual(["DATABASE_URL"]);
  });

  it("admits the config-bound keys the refresh helper forwarded and consumes its marker", () => {
    const env: Record<string, string> = { PAPERCLIP_WORKSPACE_CWD: "/w" };
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig: { GH_TOKEN: "ghp_config", CUSTOM_GATEWAY_URL: "https://gw.example" },
      workspaceCwd: "/w",
    });
    expect(env.PAPERCLIP_CHILD_ENV_CONFIG_KEYS).toBe("GH_TOKEN,CUSTOM_GATEWAY_URL");

    const filtered = applyChildEnvAllowlist({ ...env, DATABASE_URL: "postgres://host" });

    expect(filtered.env.GH_TOKEN).toBe("ghp_config");
    expect(filtered.env.CUSTOM_GATEWAY_URL).toBe("https://gw.example");
    // The marker is Paperclip bookkeeping and never reaches the child.
    expect(filtered.env.PAPERCLIP_CHILD_ENV_CONFIG_KEYS).toBeUndefined();
    expect(filtered.droppedKeys).toEqual(["DATABASE_URL"]);
  });

  it("rewrites the marker from what the loop forwarded, so config cannot widen the allowlist", () => {
    const env: Record<string, string> = {};
    refreshPaperclipWorkspaceEnvForExecution({
      env,
      envConfig: { PAPERCLIP_CHILD_ENV_CONFIG_KEYS: "DATABASE_URL" },
      workspaceCwd: "/w",
    });

    const filtered = applyChildEnvAllowlist({ ...env, DATABASE_URL: "postgres://host" });

    expect(filtered.droppedKeys).toEqual(["DATABASE_URL"]);
  });

  it("clears a stale marker when the run forwards no config env", () => {
    const env: Record<string, string> = { PAPERCLIP_CHILD_ENV_CONFIG_KEYS: "GH_TOKEN" };
    refreshPaperclipWorkspaceEnvForExecution({ env, envConfig: {}, workspaceCwd: "/w" });

    expect(env.PAPERCLIP_CHILD_ENV_CONFIG_KEYS).toBeUndefined();
  });
});
