import type { AgentEntry, RuntimeContext, RuntimeKind } from "../../core/src/roster/types.ts";
import { ClaudeAdapter } from "./adapter.ts";

const SOFT_MS = 60_000;
const HARD_MS = 180_000;
// `claude --help` lists these efforts (2026-11-07).
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = ["opus", "sonnet", "haiku", "fable"];

export function claudeKind(): RuntimeKind {
  return {
    id: "claude-code",
    label: "Claude Code",
    efforts: () => [...EFFORTS],
    models: () => [...MODELS],
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
  api.runtime(claudeKind());
}
