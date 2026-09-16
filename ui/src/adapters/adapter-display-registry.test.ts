import { afterEach, describe, expect, it } from "vitest";
import { Cpu, Terminal } from "lucide-react";

import {
  getAdapterDisplay,
  getAdapterLabel,
  getAdapterLabels,
  setRuntimeAdapterDisplay,
} from "./adapter-display-registry";

afterEach(() => {
  setRuntimeAdapterDisplay([]);
});

describe("adapter display registry", () => {
  it("uses user-facing labels without the legacy local qualifier for built-in adapters", () => {
    expect(getAdapterLabel("codex_local")).toBe("Codex");
    expect(getAdapterLabel("claude_local")).toBe("Claude Code");
    expect(getAdapterLabel("acpx_local")).toBe("ACPX (retired)");
    expect(getAdapterLabel("cursor")).toBe("Cursor");
    expect(getAdapterLabel("gemini_local")).toBe("Gemini CLI");
    expect(getAdapterLabel("grok_local")).toBe("Grok Build");
    expect(getAdapterLabel("kimi_local")).toBe("Kimi Code");
    expect(getAdapterLabel("hermes_local")).toBe("Hermes");
    expect(getAdapterLabel("hermes_gateway")).toBe("Hermes Gateway");
    expect(getAdapterLabel("opencode_local")).toBe("OpenCode");
    expect(getAdapterLabel("pi_local")).toBe("Pi");

    expect(getAdapterLabels()).toMatchObject({
      codex_local: "Codex",
      claude_local: "Claude Code",
      acpx_local: "ACPX (retired)",
      cursor: "Cursor",
      gemini_local: "Gemini CLI",
      grok_local: "Grok Build",
      kimi_local: "Kimi Code",
      hermes_local: "Hermes",
      hermes_gateway: "Hermes Gateway",
      opencode_local: "OpenCode",
      pi_local: "Pi",
    });
  });

  it("drops local suffixes for unknown plugin adapter labels", () => {
    expect(getAdapterLabel("droid_local")).toBe("Droid");
    expect(getAdapterDisplay("droid_local")).toMatchObject({
      label: "Droid",
      description: "External adapter",
    });
  });

  it("keeps a gateway suffix for unknown plugin adapter labels", () => {
    expect(getAdapterLabel("droid_gateway")).toBe("Droid (gateway)");
    expect(getAdapterDisplay("droid_gateway")).toMatchObject({
      label: "Droid (gateway)",
      description: "External gateway adapter",
    });
  });
});

describe("runtime adapter display overlay", () => {
  it("gives an adapter this bundle does not know a real name, description and icon", () => {
    setRuntimeAdapterDisplay([
      {
        type: "my_adapter",
        label: "My Adapter",
        description: "An adapter shipped in the server image",
        iconName: "terminal",
      },
    ]);
    expect(getAdapterLabel("my_adapter")).toBe("My Adapter");
    expect(getAdapterDisplay("my_adapter")).toEqual({
      label: "My Adapter",
      description: "An adapter shipped in the server image",
      icon: Terminal,
    });
  });

  it("falls back to the derived display when the server sends no metadata", () => {
    setRuntimeAdapterDisplay([{ type: "droid_local", label: "droid_local" }]);
    expect(getAdapterDisplay("droid_local")).toMatchObject({
      label: "Droid",
      description: "External adapter",
      icon: Cpu,
    });
  });

  // An icon name selects from a closed set; it never becomes an import, a URL,
  // or markup. An unrecognized name is simply the default icon.
  it("resolves an unrecognized icon name to the default", () => {
    setRuntimeAdapterDisplay([
      { type: "my_adapter", label: "My Adapter", iconName: "../../evil.svg" },
    ]);
    expect(getAdapterDisplay("my_adapter").icon).toBe(Cpu);
  });

  // The compiled-in map is the authority for everything this bundle ships, so
  // a server response cannot rename a shipped adapter.
  it("cannot override a compiled-in adapter's display", () => {
    setRuntimeAdapterDisplay([
      { type: "claude_local", label: "Not Claude", description: "spoofed", iconName: "terminal" },
    ]);
    expect(getAdapterLabel("claude_local")).toBe("Claude Code");
    expect(getAdapterDisplay("claude_local").description).toBe("Claude Code CLI harness");
  });

  it("drops an adapter the server stops reporting", () => {
    setRuntimeAdapterDisplay([{ type: "droid_local", label: "Droid Deluxe" }]);
    expect(getAdapterLabel("droid_local")).toBe("Droid Deluxe");
    setRuntimeAdapterDisplay([]);
    expect(getAdapterLabel("droid_local")).toBe("Droid");
  });
});
