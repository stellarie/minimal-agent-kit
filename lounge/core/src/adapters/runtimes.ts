import { resolve } from "node:path";
import type { RuntimeKind } from "../roster/types.ts";
import { replyAdapter } from "./stub.ts";

// The kit hook. The core resolves this path, so a plugin never guesses it.
export const HOOK_FILE = resolve(import.meta.dirname, "..", "..", "..", "..", "core", "guard", "guard.js");

const none = (): string[] => [];

// Runtimes that need no install. CLI runtimes are plugins.
export function coreKinds(): RuntimeKind[] {
  return [
    {
      id: "stub",
      label: "Stub (fixed reply)",
      efforts: none,
      models: none,
      create: (entry) => replyAdapter("stub", entry.options.reply ?? ""),
    },
  ];
}

// Test kinds replace kinds with the same id.
export function mergeKinds(base: RuntimeKind[], extra: RuntimeKind[] = []): RuntimeKind[] {
  const ids = new Set(extra.map((k) => k.id));
  return [...base.filter((k) => !ids.has(k.id)), ...extra];
}
