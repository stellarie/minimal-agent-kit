import type { DatabaseSync } from "node:sqlite";
import type { AdapterConfig } from "../config.ts";
import { GRANT_GROUPS, denyAll } from "../auth/grants.ts";
import { isToolMode } from "../guard/modes.ts";
import { LoungeError } from "../lounge/room.ts";
import { seedEntries } from "./seed.ts";
import {
  TAPE_SLOTS,
  validId,
  type AgentEntry,
  type AgentPatch,
  type NewAgent,
  type RuntimeKind,
  type RuntimeOptions,
  type Tape,
} from "./types.ts";

export type RosterChange = "add" | "update" | "retire";
type Listener = (id: string, kind: RosterChange) => void;

const MAX_MODEL = 200;
const MAX_REPLY = 8000;
const NEW_KEYS = ["id", "runtime", "model", "effort", "enabled", "tape", "options", "toolMode"];
// Options of one runtime mean nothing to another.
const RUNTIME_OPTION_KEYS = ["command", "commandArgs", "reply", "softMs", "hardMs"];
const PATCH_KEYS = ["runtime", "model", "effort", "enabled", "tape", "options", "position", "toolMode"];

interface Row {
  id: string;
  runtime: string;
  model: string;
  effort: string;
  enabled: number;
  tape: number;
  options: string;
  position: number;
  retired_at: string | null;
  // NULL on a row that predates tool modes.
  tool_mode: string | null;
}

function bad(message: string): LoungeError {
  return new LoungeError("bad_agent", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// modesOk: its runtime supports tool modes.
function toEntry(row: Row, modesOk: boolean): AgentEntry {
  let options: RuntimeOptions = {};
  try {
    const parsed: unknown = JSON.parse(row.options);
    if (isObject(parsed)) options = parsed;
  } catch {
    // A bad row falls back to no options.
  }
  return {
    id: row.id,
    runtime: row.runtime,
    model: row.model,
    effort: row.effort,
    enabled: Number(row.enabled) === 1,
    tape: Number(row.tape) as Tape,
    options,
    position: Number(row.position),
    retired: row.retired_at !== null,
    toolMode: row.tool_mode === null || row.tool_mode === undefined ? "full" : isToolMode(row.tool_mode) ? row.tool_mode : modesOk ? "ask" : "full",
  };
}

function trimmed(value: unknown): unknown {
  return typeof value === "string" ? value.trim() : value;
}

function checkOptions(value: unknown): void {
  if (!isObject(value)) throw bad("options must be an object");
  const { command, commandArgs, softMs, hardMs, reply } = value;
  if (command !== undefined && (typeof command !== "string" || command.length === 0)) {
    throw bad("options.command must be a non-empty string");
  }
  if (commandArgs !== undefined) {
    const ok = Array.isArray(commandArgs) && commandArgs.every((arg) => typeof arg === "string");
    if (!ok) throw bad("options.commandArgs must be a list of strings");
  }
  for (const [key, v] of [["softMs", softMs], ["hardMs", hardMs]] as const) {
    if (v !== undefined && !isPositiveInt(v)) throw bad(`options.${key} must be a positive integer`);
  }
  if (reply !== undefined && (typeof reply !== "string" || reply.length > MAX_REPLY)) {
    throw bad(`options.reply must be a string of at most ${MAX_REPLY} characters`);
  }
}

// One row per agent. Retired rows stay.
export class Roster {
  readonly #db: DatabaseSync;
  readonly #kinds: () => RuntimeKind[];
  readonly #groupIds: () => string[];
  readonly #owner: (runtime: string) => string | undefined;
  readonly #listeners = new Set<Listener>();

  constructor(
    db: DatabaseSync,
    seed: Partial<Record<string, AdapterConfig>>,
    kinds: () => RuntimeKind[],
    groupIds: () => string[] = () => GRANT_GROUPS.map((g) => g.id),
    // The plugin id that adds a runtime, for the reason text.
    owner: (runtime: string) => string | undefined = () => undefined,
  ) {
    this.#db = db;
    this.#kinds = kinds;
    this.#groupIds = groupIds;
    this.#owner = owner;
    const count = Number(db.prepare("SELECT COUNT(*) AS n FROM agents").get()?.n ?? 0);
    if (count > 0) return;
    db.exec("BEGIN");
    try {
      for (const entry of seedEntries(seed)) this.#insert(entry);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  #toEntry(row: Row): AgentEntry {
    return toEntry(row, this.kind(row.runtime)?.toolModes === true);
  }

  #row(id: string): AgentEntry | undefined {
    const row = this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? this.#toEntry(row as unknown as Row) : undefined;
  }

  #insert(entry: AgentEntry): void {
    this.#db
      .prepare(
        "INSERT INTO agents (id, runtime, model, effort, enabled, tape, options, position, retired_at, tool_mode) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
      )
      .run(
        entry.id,
        entry.runtime,
        entry.model,
        entry.effort,
        entry.enabled ? 1 : 0,
        entry.tape,
        JSON.stringify(entry.options),
        entry.position,
        entry.toolMode,
      );
  }

  active(): AgentEntry[] {
    const rows = this.#db
      .prepare("SELECT * FROM agents WHERE retired_at IS NULL ORDER BY position, id")
      .all();
    return (rows as unknown as Row[]).map((r) => this.#toEntry(r));
  }

  // Retired rows only. Old messages keep a tape.
  retired(): AgentEntry[] {
    const rows = this.#db.prepare("SELECT * FROM agents WHERE retired_at IS NOT NULL ORDER BY position, id").all();
    return (rows as unknown as Row[]).map((r) => this.#toEntry(r));
  }

  // Retired rows are included.
  get(id: string): AgentEntry | undefined {
    return this.#row(id);
  }

  // True for an active agent only.
  has(id: string): boolean {
    const entry = this.#row(id);
    return entry !== undefined && !entry.retired;
  }

  // True when it is active and switched on.
  enabled(id: string): boolean {
    const entry = this.#row(id);
    return entry !== undefined && !entry.retired && entry.enabled;
  }

  // True when it is switched on and its runtime is loaded.
  ready(id: string): boolean {
    return this.enabled(id) && this.runtimeReason(id) === undefined;
  }

  kind(runtime: string): RuntimeKind | undefined {
    return this.#kinds().find((k) => k.id === runtime);
  }

  // Why its runtime is not loaded. Unset when it is, or when the agent is not active.
  runtimeReason(id: string): string | undefined {
    const entry = this.#row(id);
    if (entry === undefined || entry.retired || this.kind(entry.runtime) !== undefined) return undefined;
    const plugin = this.#owner(entry.runtime);
    return plugin === undefined
      ? `runtime ${entry.runtime} needs a plugin`
      : `runtime ${entry.runtime} needs plugin ${plugin}`;
  }

  // A runtime that stays unchanged may be missing: the agent can still be edited.
  #validate(entry: AgentEntry, current?: AgentEntry): void {
    const kind = this.kind(entry.runtime);
    const missingOk = kind === undefined && typeof entry.runtime === "string" && entry.runtime === current?.runtime;
    if (typeof entry.runtime !== "string" || (kind === undefined && !missingOk)) {
      throw bad(`unknown runtime: ${String(entry.runtime)}`);
    }
    if (typeof entry.model !== "string" || entry.model.length > MAX_MODEL) {
      throw bad(`model must be a string of at most ${MAX_MODEL} characters`);
    }
    // A leading hyphen would read as a CLI flag.
    if (/[\u0000-\u001f\u007f]/.test(entry.model) || entry.model.startsWith("-")) {
      throw bad("model has no control character and no leading hyphen");
    }
    if (typeof entry.effort !== "string") throw bad("effort must be a string");
    // A missing runtime lists no efforts: the agent keeps its effort or clears it.
    const known: (string | undefined)[] = kind === undefined ? [current?.effort] : kind.efforts(entry);
    if (entry.effort !== "" && !known.includes(entry.effort)) {
      throw bad(`${entry.runtime} does not take effort ${entry.effort}`);
    }
    if (typeof entry.enabled !== "boolean") throw bad("enabled must be true or false");
    if (!TAPE_SLOTS.includes(entry.tape)) throw bad("tape must be 1 to 4");
    if (!Number.isInteger(entry.position) || entry.position < 0) {
      throw bad("position must be a whole number, 0 or more");
    }
    if (!isToolMode(entry.toolMode)) throw bad("toolMode must be read-only, ask, auto, or full");
    // A runtime that is not loaded keeps the mode it has.
    const modesOk = kind === undefined ? entry.toolMode === current?.toolMode : kind.toolModes === true;
    if (entry.toolMode !== "full" && !modesOk) throw bad(`${entry.runtime} ignores tool modes: use full`);
    checkOptions(entry.options);
    const optionError = kind?.validate?.(entry.options);
    if (optionError !== undefined) throw bad(optionError);
  }

  add(input: NewAgent): AgentEntry {
    if (!isObject(input)) throw bad("body must be an object");
    for (const key of Object.keys(input)) if (!NEW_KEYS.includes(key)) throw bad(`unknown field ${key}`);
    const { id } = input;
    if (!validId(id)) {
      throw bad("id must be 2 to 24 characters: a-z, 0-9, and hyphen, starting with a letter");
    }
    // A retired id stays taken.
    // Old messages keep one author.
    if (this.#row(id) !== undefined) throw bad(`${id} is taken`);
    const top = this.#db.prepare("SELECT MAX(position) AS top FROM agents").get()?.top;
    const position = top === null || top === undefined ? 0 : Number(top) + 1;
    const entry: AgentEntry = {
      id,
      runtime: input.runtime,
      model: (trimmed(input.model) ?? "") as string,
      effort: input.effort ?? "",
      enabled: input.enabled ?? true,
      tape: input.tape ?? (((position % 4) + 1) as Tape),
      options: input.options ?? {},
      position,
      retired: false,
      toolMode: input.toolMode === undefined ? (this.kind(input.runtime)?.toolModes === true ? "ask" : "full") : input.toolMode,
    };
    this.#validate(entry);
    this.#db.exec("BEGIN");
    try {
      this.#insert(entry);
      denyAll(this.#db, id, this.#groupIds());
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
    this.#notify(id, "add");
    return entry;
  }

  #active(id: string): AgentEntry {
    const entry = this.#row(id);
    if (entry === undefined || entry.retired) throw new LoungeError("unknown_agent", `no agent: ${id}`);
    return entry;
  }

  update(id: string, patch: AgentPatch): AgentEntry {
    const current = this.#active(id);
    if (!isObject(patch)) throw bad("body must be an object");
    for (const key of Object.keys(patch)) if (!PATCH_KEYS.includes(key)) throw bad(`unknown field ${key}`);
    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const merged = { ...current, ...changes } as AgentEntry;
    merged.model = trimmed(merged.model) as string;
    if (changes["runtime"] !== undefined && changes["runtime"] !== current.runtime && changes["options"] === undefined) {
      const options = { ...current.options };
      for (const key of RUNTIME_OPTION_KEYS) delete options[key];
      merged.options = options;
    }
    // A runtime that ignores modes would show a mode that never applies.
    if (
      changes["runtime"] !== undefined &&
      changes["runtime"] !== current.runtime &&
      changes["toolMode"] === undefined &&
      this.kind(merged.runtime)?.toolModes !== true
    ) {
      merged.toolMode = "full";
    }
    this.#validate(merged, current);
    this.#db
      .prepare(
        "UPDATE agents SET runtime = ?, model = ?, effort = ?, enabled = ?, tape = ?, options = ?, position = ?, tool_mode = ? " +
          "WHERE id = ?",
      )
      .run(
        merged.runtime,
        merged.model,
        merged.effort,
        merged.enabled ? 1 : 0,
        merged.tape,
        JSON.stringify(merged.options),
        merged.position,
        merged.toolMode,
        id,
      );
    this.#notify(id, "update");
    return merged;
  }

  retire(id: string): void {
    this.#active(id);
    this.#db.prepare("UPDATE agents SET retired_at = ? WHERE id = ?").run(new Date().toISOString(), id);
    this.#notify(id, "retire");
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #notify(id: string, kind: RosterChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(id, kind);
      } catch (err) {
        console.error("roster listener failed:", err);
      }
    }
  }
}
