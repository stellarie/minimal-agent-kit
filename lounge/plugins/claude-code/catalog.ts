import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface CatalogModel {
  id: string;
  label: string;
  efforts: string[];
  section: string;
}

export interface ModelCatalog {
  models: CatalogModel[];
  // Alias name to the id of its default model.
  aliases: Record<string, string>;
  fetchedAt: number;
}

const EMPTY: ModelCatalog = { models: [], aliases: {}, fetchedAt: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function maskedIds(folder: string): Set<string> {
  const raw = readJson(join(folder, "masked-ids.json"));
  return new Set(isRecord(raw) ? strings(raw.ids) : []);
}

function parseCatalog(raw: unknown, masked: Set<string>): ModelCatalog | undefined {
  const root = isRecord(raw) ? raw : {};
  const config = isRecord(root.catalog) ? root.catalog.config : undefined;
  if (!isRecord(config) || !Array.isArray(config.models)) return undefined;
  const models: CatalogModel[] = [];
  for (const m of config.models) {
    if (!isRecord(m) || typeof m.id !== "string" || masked.has(m.id)) continue;
    models.push({
      id: m.id,
      label: typeof m.name === "string" ? m.name : m.id,
      efforts: isRecord(m.runtime) ? strings(m.runtime.effort_levels) : [],
      section: typeof m.section === "string" ? m.section : "main",
    });
  }
  const aliases: Record<string, string> = {};
  if (isRecord(config.provider_alias_targets)) {
    for (const [name, target] of Object.entries(config.provider_alias_targets)) {
      if (isRecord(target) && typeof target.default === "string") aliases[name] = target.default;
    }
  }
  const main = models.filter((m) => m.section === "main");
  const rest = models.filter((m) => m.section !== "main");
  return { models: [...main, ...rest], aliases, fetchedAt: typeof root.fetchedAt === "number" ? root.fetchedAt : 0 };
}

function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// The newest catalog file that the Claude CLI cached, or an empty catalog.
export function readClaudeCatalog(configDir: string = claudeConfigDir()): ModelCatalog {
  const folder = join(configDir, "cache", "model-catalog");
  let names: string[];
  try {
    names = readdirSync(folder).filter((n) => n.endsWith("-cc.json"));
  } catch {
    return EMPTY;
  }
  const masked = maskedIds(folder);
  let best: ModelCatalog | undefined;
  for (const name of names) {
    const got = parseCatalog(readJson(join(folder, name)), masked);
    if (got !== undefined && (best === undefined || got.fetchedAt > best.fetchedAt)) best = got;
  }
  return best ?? EMPTY;
}
