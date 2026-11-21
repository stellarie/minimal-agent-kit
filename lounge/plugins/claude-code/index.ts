import { execFileSync } from "node:child_process";
import type { AgentEntry, RuntimeContext, RuntimeKind } from "../../core/src/roster/types.ts";
import { ClaudeAdapter } from "./adapter.ts";
import { readClaudeCatalog, type ModelCatalog } from "./catalog.ts";

const SOFT_MS = 60_000;
const HARD_MS = 180_000;
const HELP_MS = 5_000;
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

const NO_CATALOG: ModelCatalog = { models: [], aliases: {}, fetchedAt: 0 };

function effortRank(effort: string): number {
  const at = EFFORT_ORDER.indexOf(effort);
  return at < 0 ? EFFORT_ORDER.length : at;
}

// The levels that the --effort option of `claude --help` lists.
export function effortsFromHelp(help: string): string[] {
  const at = help.indexOf("--effort");
  if (at < 0) return [];
  const option = help.slice(at).split(/\n\s+--/)[0]!;
  const list = /\(([a-z]+(?:,\s*[a-z]+)+)\)/.exec(option);
  return list ? list[1]!.split(",").map((s) => s.trim()) : [];
}

function readHelp(): string {
  try {
    return execFileSync("claude", ["--help"], {
      encoding: "utf8",
      timeout: HELP_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export function claudeKind(catalog: ModelCatalog = NO_CATALOG, fallbackEfforts: readonly string[] = []): RuntimeKind {
  const union = (): string[] => {
    const all = new Set(catalog.models.flatMap((m) => m.efforts));
    return all.size > 0 ? [...all].sort((a, b) => effortRank(a) - effortRank(b)) : [...fallbackEfforts];
  };
  return {
    id: "claude-code",
    label: "Claude Code",
    efforts: (entry: AgentEntry) => {
      const id = catalog.aliases[entry.model] ?? entry.model;
      const model = catalog.models.find((m) => m.id === id);
      return model ? [...model.efforts] : union();
    },
    models: () => [...Object.keys(catalog.aliases), ...catalog.models.map((m) => m.id)],
    toolModes: true,
    create: (entry: AgentEntry, ctx: RuntimeContext) =>
      new ClaudeAdapter({
        command: entry.options.command ?? "claude",
        commandArgs: entry.options.commandArgs ?? [],
        softMs: entry.options.softMs ?? SOFT_MS,
        hardMs: entry.options.hardMs ?? HARD_MS,
        home: ctx.home,
        mcpUrl: ctx.mcpUrl,
        hookFile: ctx.hookFile,
        prompt: ctx.prompt,
        activity: ctx.activity,
        model: entry.model,
        effort: entry.effort,
        toolMode: entry.toolMode,
      }),
  };
}

export default function setup(api: { runtime(def: RuntimeKind): void }): void {
  const catalog = readClaudeCatalog();
  const fallback = catalog.models.length > 0 ? [] : effortsFromHelp(readHelp());
  api.runtime(claudeKind(catalog, fallback));
}
