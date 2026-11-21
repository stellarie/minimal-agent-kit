import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexIsolationArgs } from "./isolate.ts";
import { locateCodex } from "./locate.ts";

const DEBUG_MS = 20_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

interface CodexCatalogModel {
  id: string;
  label: string;
  efforts: string[];
  default: string;
}

interface CodexCatalog {
  models: CodexCatalogModel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string): CodexCatalogModel[] | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(data) || !Array.isArray(data.models)) return undefined;
  const models: CodexCatalogModel[] = [];
  for (const m of data.models) {
    if (!isRecord(m) || m.visibility !== "list" || typeof m.slug !== "string") continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    models.push({
      id: m.slug,
      label: typeof m.display_name === "string" ? m.display_name : m.slug,
      efforts: levels.flatMap((l) => (isRecord(l) && typeof l.effort === "string" ? [l.effort] : [])),
      default: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : "",
    });
  }
  return models;
}

// The models that the lounge Codex install lists, from `codex debug models`.
// A failed run falls back to the cache that Codex keeps in the lounge codex home.
export async function readCodexCatalog(opts: {
  home: string;
  command?: string;
  commandArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<CodexCatalog> {
  const isolation = codexIsolationArgs(opts.home);
  try {
    const exe = locateCodex(opts.command ?? "codex", opts.env);
    const run = await promisify(execFile)(exe, [...(opts.commandArgs ?? []), ...isolation.args, "debug", "models"], {
      env: { ...process.env, ...isolation.env },
      timeout: DEBUG_MS,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
    });
    const models = parse(run.stdout);
    if (models !== undefined) return { models };
  } catch {
    // Codex is missing, signed out, or offline: use the cache.
  }
  try {
    const models = parse(readFileSync(join(isolation.env.CODEX_HOME!, "models_cache.json"), "utf8"));
    if (models !== undefined) return { models };
  } catch {
    // No cache file.
  }
  return { models: [] };
}
