#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Names only, never values. The child-env allowlist test needs to prove a
// server secret (DATABASE_URL) did not reach this process, and the value of a
// leaked secret must not be the thing written to a temp file to prove it.
// PAPERCLIP_-prefixed so the allowlist itself admits the request variable.
function dumpEnvKeys() {
  const target = process.env.PAPERCLIP_ACPX_ENV_DUMP;
  if (!target) return;
  writeFileSync(target, JSON.stringify(Object.keys(process.env).sort()));
}

async function handleRequest(request) {
  if (request.method === "initialize") {
    dumpEnvKeys();
    process.stderr.write("Error handling request { method: 'nes/close' } { code: -32601 }\n");
    process.stderr.write("paperclip-acp-echo-agent started\n");
    return {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false, sessionCapabilities: { close: {} } },
      agentInfo: { name: "paperclip-acp-echo-agent", version: "1.0.0" },
    };
  }
  if (request.method === "session/new") return { sessionId: randomUUID() };
  if (request.method === "session/prompt") {
    writeMessage({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: request.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: process.env.PAPERCLIP_ACPX_SPAWN_SMOKE ?? "missing" },
        },
      },
    });
    return { stopReason: "end_turn" };
  }
  if (request.method === "session/close" || request.method === "session/set_mode" || request.method === "session/set_config_option") return {};
  if (request.method === "session/cancel") return null;
  throw new Error(`Unsupported ACP method: ${request.method}`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const result = await handleRequest(request);
    if (request.id !== undefined && result !== null) writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    if (request?.id !== undefined) {
      writeMessage({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: String(error?.message ?? error) } });
    }
  }
});
