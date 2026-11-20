import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** A roster id. */
export type Agent = string;
export type Caller = Agent | "owner";

// First-start rows only.
// Later agents come from the roster table.
export const SEED_AGENTS = ["ada", "bea", "cyd", "dee"] as const;
export type SeedAgent = (typeof SEED_AGENTS)[number];

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 47621;
export const DEFAULT_ROOM = "lounge";

export type Grant = "start" | "queue" | "reject";
const GRANTS: readonly Grant[] = ["start", "queue", "reject"];

export interface SessionConfig {
  maxRunning: number;
  queueTimeoutMs: number;
  replyWaitMs: number;
  contextMessages: number;
}

export interface AdapterConfig {
  enabled: boolean;
  command?: string;
  // Put before the CLI flags.
  commandArgs?: string[];
  softMs?: number;
  hardMs?: number;
}

export interface SchedulerConfig {
  enabled: boolean;
  replyDelayMs: number;
  idleMs: number;
  jitterMs: number;
  turnsPerHour: number;
  turnsPerAgentPerDay: number;
  agentOnlyBeforePause: number;
  // Channel turns that may run at once.
  maxConcurrent: number;
}

export interface LoungeConfig {
  host: string;
  port: number;
  // Seed input for the first start only.
  // The roster table owns the rows after that.
  adapters: Record<SeedAgent, AdapterConfig>;
  sessions: SessionConfig;
  scheduler: SchedulerConfig;
  permissions: Record<string, { chat: Grant; work: Grant }>;
}

export const DEFAULT_PERMISSION: Readonly<{ chat: Grant; work: Grant }> = { chat: "start", work: "queue" };

export function permissionsFor(config: LoungeConfig, caller: Caller): { chat: Grant; work: Grant } {
  const own = Object.hasOwn(config.permissions, caller) ? config.permissions[caller] : undefined;
  return own ?? { ...DEFAULT_PERMISSION };
}

export function defaultConfig(): LoungeConfig {
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    adapters: {
      ada: { enabled: true, command: "claude", commandArgs: [], softMs: 60_000, hardMs: 180_000 },
      bea: { enabled: false },
      cyd: { enabled: true, softMs: 180_000, hardMs: 600_000 },
      dee: { enabled: false, softMs: 60_000, hardMs: 240_000 },
    },
    sessions: {
      maxRunning: 3,
      queueTimeoutMs: 1_800_000,
      replyWaitMs: 20_000,
      contextMessages: 40,
    },
    scheduler: {
      enabled: true,
      replyDelayMs: 3_000,
      idleMs: 900_000,
      jitterMs: 300_000,
      turnsPerHour: 12,
      turnsPerAgentPerDay: 40,
      agentOnlyBeforePause: 20,
      maxConcurrent: 3,
    },
    permissions: {
      owner: { chat: "start", work: "start" },
      ada: { chat: "start", work: "queue" },
      cyd: { chat: "start", work: "queue" },
      bea: { chat: "reject", work: "reject" },
      dee: { chat: "reject", work: "reject" },
    },
  };
}

// AGENT_LOUNGE_HOME, else the .agent-lounge folder of the user profile.
export function loungeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_LOUNGE_HOME || join(homedir(), ".agent-lounge");
}

/**
 * The working folder of a chat turn: a sibling of the lounge home.
 * Inside the home, a turn is two `..` steps from the tokens.
 * The name has no "agent-lounge", so the guard text rules do not read it as the home.
 */
export function chatFolder(home: string, agent: string): string {
  // A home at a drive root has no sibling.
  if (dirname(home) === home) return join(homedir(), ".lounge-chat", agent);
  const name = `${basename(home).replace(/agent-?/gi, "") || "lounge"}-chat`;
  return join(dirname(home), name, agent);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseAdapter(
  raw: Partial<AdapterConfig> | undefined,
  base: AdapterConfig,
  name: SeedAgent,
  file: string,
): AdapterConfig {
  const out: AdapterConfig = { ...base };
  if (raw === undefined) return out;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error(`invalid adapters.${name}.enabled in ${file}`);
    out.enabled = raw.enabled;
  }
  if (raw.command !== undefined) {
    if (typeof raw.command !== "string" || raw.command.length === 0) {
      throw new Error(`invalid adapters.${name}.command in ${file}`);
    }
    out.command = raw.command;
  }
  if (raw.commandArgs !== undefined) {
    const args: unknown = raw.commandArgs;
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      throw new Error(`invalid adapters.${name}.commandArgs in ${file}`);
    }
    out.commandArgs = [...args];
  }
  for (const key of ["softMs", "hardMs"] as const) {
    if (raw[key] === undefined) continue;
    if (!isPositiveInt(raw[key])) throw new Error(`invalid adapters.${name}.${key} in ${file}`);
    out[key] = raw[key];
  }
  return out;
}

function parseSessions(
  raw: Partial<SessionConfig> | undefined,
  base: SessionConfig,
  file: string,
): SessionConfig {
  const out: SessionConfig = { ...base };
  for (const key of Object.keys(base) as (keyof SessionConfig)[]) {
    const value = raw?.[key];
    if (value === undefined) continue;
    if (!isPositiveInt(value)) throw new Error(`invalid sessions.${key} in ${file}`);
    out[key] = value;
  }
  return out;
}

function parseScheduler(
  raw: Partial<SchedulerConfig> | undefined,
  base: SchedulerConfig,
  file: string,
): SchedulerConfig {
  const out: SchedulerConfig = { ...base };
  if (raw?.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error(`invalid scheduler.enabled in ${file}`);
    out.enabled = raw.enabled;
  }
  for (const key of Object.keys(base) as (keyof SchedulerConfig)[]) {
    if (key === "enabled") continue;
    const value = raw?.[key];
    if (value === undefined) continue;
    // Zero jitter or delay is valid.
    const ok = typeof value === "number" && Number.isInteger(value) && value >= 0;
    if (!ok) throw new Error(`invalid scheduler.${key} in ${file}`);
    out[key] = value;
  }
  return out;
}

function parsePermissions(
  raw: Record<string, Partial<{ chat: Grant; work: Grant }>> | undefined,
  base: LoungeConfig["permissions"],
  file: string,
): LoungeConfig["permissions"] {
  const out: LoungeConfig["permissions"] = {};
  const callers = new Set<string>(["owner", ...SEED_AGENTS, ...Object.keys(base), ...Object.keys(raw ?? {})]);
  for (const caller of callers) {
    const entry = { ...permissionsFor({ permissions: base } as LoungeConfig, caller) };
    for (const kind of ["chat", "work"] as const) {
      const value: unknown = raw?.[caller]?.[kind];
      if (value === undefined) continue;
      // Chat turns never queue for approval in stage 5a.
      const valid = GRANTS.includes(value as Grant) && !(kind === "chat" && value === "queue");
      if (!valid) throw new Error(`invalid permissions.${caller}.${kind} in ${file}`);
      entry[kind] = value as Grant;
    }
    out[caller] = entry;
  }
  return out;
}

export function loadConfig(home: string): LoungeConfig {
  mkdirSync(home, { recursive: true });
  const file = join(home, "config.json");
  const defaults = defaultConfig();
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(defaults, null, 2) + "\n");
    return defaults;
  }
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LoungeConfig>;
  const config: LoungeConfig = {
    host: raw.host ?? defaults.host,
    port: raw.port ?? defaults.port,
    adapters: { ...defaults.adapters },
    sessions: parseSessions(raw.sessions, defaults.sessions, file),
    scheduler: parseScheduler(raw.scheduler, defaults.scheduler, file),
    permissions: parsePermissions(raw.permissions, defaults.permissions, file),
  };
  for (const name of SEED_AGENTS) {
    config.adapters[name] = parseAdapter(raw.adapters?.[name], defaults.adapters[name], name, file);
  }
  if (typeof config.host !== "string") {
    throw new Error(`invalid host in ${file}`);
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`invalid port in ${file}: ${String(config.port)}`);
  }
  return config;
}
