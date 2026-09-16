/**
 * Single source of truth for adapter display metadata.
 *
 * Three tiers, consulted in order:
 *
 * 1. `adapterDisplayMap`, compiled in. Always wins, so no label of a shipped
 *    adapter can be changed from outside this bundle.
 * 2. `runtimeDisplay`, populated from the server's adapter listing. Lets an
 *    adapter the bundle has no entry for — one a server declares and ships —
 *    present a real name instead of a humanized type id.
 * 3. A default derived from the type string.
 *
 * An icon is a *selector*, not an image: names resolve against `ICONS` below
 * and an unrecognized one falls back to `Cpu`. Nothing dynamic is ever derived
 * from a name — no import, no URL, no markup. A vendor wanting its own artwork
 * still needs a change in this file, which is the honest boundary: an icon is
 * code, and code comes from the bundle.
 */
import type { ComponentType } from "react";
import {
  Bot,
  Code,
  Gem,
  Moon,
  MousePointer2,
  Sparkles,
  Terminal,
  Cpu,
} from "lucide-react";
import { OpenCodeLogoIcon } from "@/components/OpenCodeLogoIcon";

// ---------------------------------------------------------------------------
// Type suffix parsing
// ---------------------------------------------------------------------------

// Suffixes stripped from type ids when deriving a human-readable label for
// unknown (plugin) adapter types. "_local" is a legacy qualifier from before
// first-class Environments and is never displayed; "_gateway" is re-appended
// as " (gateway)" to disambiguate gateway variants. Known adapters in
// `adapterDisplayMap` have final labels and never get a derived suffix.
const STRIPPED_TYPE_SUFFIXES = ["_local", "_gateway"] as const;

const DISPLAY_SUFFIXES: Record<string, string> = {
  _gateway: "gateway",
};

function getTypeSuffix(type: string): string | null {
  for (const [suffix, mode] of Object.entries(DISPLAY_SUFFIXES)) {
    if (type.endsWith(suffix)) return mode;
  }
  return null;
}

function withSuffix(label: string, suffix: string | null): string {
  return suffix ? `${label} (${suffix})` : label;
}

// ---------------------------------------------------------------------------
// Display metadata per adapter type
// ---------------------------------------------------------------------------

export interface AdapterDisplayInfo {
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  recommended?: boolean;
  comingSoon?: boolean;
  disabledLabel?: string;
  experimental?: boolean;
  hideFromVisualSelection?: boolean;
}

const adapterDisplayMap: Record<string, AdapterDisplayInfo> = {
  acpx_local: {
    label: "ACPX (retired)",
    description: "Retired standalone ACPX adapter",
    icon: Bot,
    comingSoon: true,
    disabledLabel: "Use Claude Code or Codex with the ACP engine",
    hideFromVisualSelection: true,
  },
  claude_local: {
    label: "Claude Code",
    description: "Claude Code CLI harness",
    icon: Sparkles,
    recommended: true,
  },
  codex_local: {
    label: "Codex",
    description: "Codex CLI harness",
    icon: Code,
    recommended: true,
  },
  paperclip_runner: {
    label: "Paperclip Runner",
    description: "Experimental Rust runner with a Codex provider",
    icon: Cpu,
    experimental: true,
  },
  gemini_local: {
    label: "Gemini CLI",
    description: "Gemini CLI harness",
    icon: Gem,
  },
  grok_local: {
    label: "Grok Build",
    description: "Grok Build harness",
    icon: Bot,
  },
  kimi_local: {
    label: "Kimi Code",
    description: "Kimi Code CLI harness",
    icon: Moon,
  },
  hermes_gateway: {
    label: "Hermes Gateway",
    description: "Remote Hermes API server",
    icon: Bot,
    hideFromVisualSelection: true,
  },
  hermes_local: {
    label: "Hermes",
    description: "Hermes harness",
    icon: Bot,
  },
  opencode_local: {
    label: "OpenCode",
    description: "OpenCode multi-provider harness",
    icon: OpenCodeLogoIcon,
  },
  pi_local: {
    label: "Pi",
    description: "Pi harness",
    icon: Terminal,
  },
  cursor: {
    label: "Cursor",
    description: "Cursor CLI harness",
    icon: MousePointer2,
  },
  cursor_cloud: {
    label: "Cursor Cloud",
    description: "Managed remote Cursor agent",
    icon: MousePointer2,
  },
  openclaw_gateway: {
    label: "OpenClaw Gateway",
    description: "External gateway adapter",
    icon: Bot,
    comingSoon: true,
    disabledLabel: "Invite external agents from the add-agent modal",
    hideFromVisualSelection: true,
  },
  process: {
    label: "Process",
    description: "Internal process adapter",
    icon: Cpu,
    comingSoon: true,
  },
  http: {
    label: "HTTP",
    description: "Internal HTTP adapter",
    icon: Cpu,
    comingSoon: true,
  },
};

// ---------------------------------------------------------------------------
// Runtime display overlay
// ---------------------------------------------------------------------------

/**
 * The closed set of icons a server-supplied `iconName` may select. Adding a
 * name here is a deliberate act in this bundle; a name that is not here
 * resolves to `Cpu`.
 */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  bot: Bot,
  code: Code,
  cpu: Cpu,
  gem: Gem,
  moon: Moon,
  pointer: MousePointer2,
  sparkles: Sparkles,
  terminal: Terminal,
};

export interface RuntimeAdapterDisplay {
  type: string;
  label?: string;
  description?: string;
  iconName?: string;
}

const runtimeDisplay = new Map<string, AdapterDisplayInfo>();

/**
 * Record display metadata the server reported for adapters this bundle has no
 * compiled-in entry for. Replaces the previous overlay wholesale, so an
 * adapter the server stops reporting stops overlaying.
 *
 * Entries for types already in `adapterDisplayMap` are ignored rather than
 * stored: the compiled-in map is the authority for everything this bundle
 * ships, and letting a server response edit those labels is a change of trust
 * boundary for no benefit.
 */
export function setRuntimeAdapterDisplay(entries: readonly RuntimeAdapterDisplay[]): void {
  runtimeDisplay.clear();
  for (const entry of entries) {
    if (entry.type in adapterDisplayMap) continue;
    const suffix = getTypeSuffix(entry.type);
    const label = entry.label && entry.label !== entry.type
      ? entry.label
      : withSuffix(humanizeType(entry.type), suffix);
    runtimeDisplay.set(entry.type, {
      label,
      description:
        entry.description ?? (suffix ? `External ${suffix} adapter` : "External adapter"),
      icon: (entry.iconName ? ICONS[entry.iconName] : undefined) ?? Cpu,
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function humanizeType(type: string): string {
  // Strip known type suffixes so "droid_local" → "Droid", not "Droid Local"
  let base = type;
  for (const suffix of STRIPPED_TYPE_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getAdapterLabel(type: string): string {
  // Known labels are final — only unknown (plugin) types get a derived
  // suffix, so labels like "OpenClaw Gateway" don't become
  // "OpenClaw Gateway (gateway)".
  const known = adapterDisplayMap[type];
  if (known) return known.label;
  const runtime = runtimeDisplay.get(type);
  if (runtime) return runtime.label;
  return withSuffix(humanizeType(type), getTypeSuffix(type));
}

export function getAdapterLabels(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [type, info] of Object.entries(adapterDisplayMap)) {
    labels[type] = info.label;
  }
  return labels;
}

export function getAdapterDisplay(type: string): AdapterDisplayInfo {
  const known = adapterDisplayMap[type];
  if (known) return known;

  const runtime = runtimeDisplay.get(type);
  if (runtime) return runtime;

  const suffix = getTypeSuffix(type);
  const label = withSuffix(humanizeType(type), suffix);
  return {
    label,
    description: suffix ? `External ${suffix} adapter` : "External adapter",
    icon: Cpu,
  };
}

export function isKnownAdapterType(type: string): boolean {
  return type in adapterDisplayMap;
}
