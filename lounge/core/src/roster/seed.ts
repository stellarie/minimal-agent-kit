import type { AdapterConfig } from "../config.ts";
import type { AgentEntry, Tape } from "./types.ts";

const CLI_SOFT_MS = 60_000;
const CLI_HARD_MS = 180_000;

interface SeedDefault {
  id: string;
  runtime: string;
  tape: Tape;
  enabled: boolean;
  softMs: number;
  hardMs: number;
  command: string;
}

const DEFAULTS: readonly SeedDefault[] = [
  { id: "ada", enabled: true, runtime: "claude-code", tape: 1, softMs: CLI_SOFT_MS, hardMs: CLI_HARD_MS, command: "claude" },
  { id: "bea", enabled: false, runtime: "codex", tape: 2, softMs: CLI_SOFT_MS, hardMs: CLI_HARD_MS, command: "codex" },
  { id: "cyd", enabled: true, runtime: "claude-code", tape: 3, softMs: 180_000, hardMs: 600_000, command: "claude" },
  { id: "dee", enabled: false, runtime: "codex", tape: 4, softMs: CLI_SOFT_MS, hardMs: 240_000, command: "codex" },
];

// Canonical JSON: key order does not matter.
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canon(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// After the first start, config.json adapters
// changes nothing.
// A line per seed row that differs.
export function seedDrift(
  roster: { get(id: string): AgentEntry | undefined },
  adapters: Partial<Record<string, AdapterConfig>>,
): string[] {
  const out: string[] = [];
  for (const seed of seedEntries(adapters)) {
    const row = roster.get(seed.id);
    if (row === undefined || row.retired) continue;
    if (row.enabled === seed.enabled && canon(row.options) === canon(seed.options)) continue;
    out.push(
      `config.json adapters.${seed.id} differs from the roster row. The roster wins. ` +
        `Change it with PATCH /api/agents/${seed.id}.`,
    );
  }
  return out;
}

// A config.json value wins over the default.
export function seedEntries(adapters: Partial<Record<string, AdapterConfig>>): AgentEntry[] {
  return DEFAULTS.map((d, position) => {
    const config = adapters[d.id];
    const options: AgentEntry["options"] = {};
    const command = config?.command ?? d.command;
    options.command = command;
    options.commandArgs = [...(config?.commandArgs ?? [])];
    options.softMs = config?.softMs ?? d.softMs;
    options.hardMs = config?.hardMs ?? d.hardMs;
    return {
      id: d.id,
      runtime: d.runtime,
      model: "",
      effort: "",
      enabled: config?.enabled ?? d.enabled,
      tape: d.tape,
      options,
      position,
      retired: false,
      toolMode: "full",
    };
  });
}
