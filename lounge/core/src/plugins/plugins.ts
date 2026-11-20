import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { readSetting, writeSetting } from "../db/settings.ts";
import type { PluginGuard } from "../guard/guard.ts";
import { LoungeError } from "../lounge/room.ts";
import { ID_PATTERN, type RuntimeKind } from "../roster/types.ts";

export type PluginEvent = "message" | "turnEnd" | "eventFire";
const EVENTS: readonly PluginEvent[] = ["message", "turnEnd", "eventFire"];

export interface ToolField {
  type: "string" | "number" | "boolean";
  description?: string;
  optional?: boolean;
}

export interface PluginTool {
  plugin: string;
  name: string;
  mcpName: string;
  description: string;
  input: Record<string, ToolField>;
  run(args: Record<string, unknown>, ctx: { caller: string }): unknown;
}

export interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  error?: string;
  tools: string[];
  guards: number;
  // Runtime ids the plugin adds while it is enabled.
  runtimes: string[];
  // True for a plugin that ships with the lounge.
  bundled: boolean;
  panel?: string;
}

interface Manifest {
  name: string;
  version?: string;
  description?: string;
  main?: string;
  panel?: string;
  // Declared so a disabled plugin can still be named.
  runtimes: string[];
}

interface Loaded {
  id: string;
  dir: string;
  bundled: boolean;
  manifest?: Manifest;
  enabled: boolean;
  errors: string[];
  tools: PluginTool[];
  guards: PluginGuard[];
  runtimes: RuntimeKind[];
  listeners: Map<PluginEvent, ((payload: unknown) => unknown)[]>;
  dispose?: () => unknown;
}

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOOL = /^[a-z0-9_]{1,32}$/;
const SETTING = "plugins.enabled";
const TYPES = new Set(["string", "number", "boolean"]);

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function readManifest(dir: string): Manifest {
  const raw = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")) as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.trim() === "") throw new Error("plugin.json needs a name");
  const opt = (k: string) => {
    const v = raw[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw new Error(`plugin.json ${k} must be a string`);
    return v;
  };
  const runtimes = raw.runtimes ?? [];
  const listed = Array.isArray(runtimes) && runtimes.every((r) => typeof r === "string" && ID_PATTERN.test(r));
  if (!listed) throw new Error("plugin.json runtimes must be a list of runtime ids");
  return {
    name: raw.name.trim(),
    version: opt("version"),
    description: opt("description"),
    main: opt("main"),
    panel: opt("panel"),
    runtimes: runtimes as string[],
  };
}

function checkRuntime(def: unknown): RuntimeKind {
  const d = (def ?? {}) as Record<string, unknown>;
  if (typeof d.id !== "string" || !ID_PATTERN.test(d.id)) {
    throw new Error("a runtime id must be 2 to 24 characters: a-z, 0-9, and hyphen, starting with a letter");
  }
  if (typeof d.label !== "string" || d.label.trim() === "") throw new Error(`runtime ${d.id} needs a label`);
  for (const fn of ["efforts", "models", "create"]) {
    if (typeof d[fn] !== "function") throw new Error(`runtime ${d.id} needs ${fn}`);
  }
  return d as unknown as RuntimeKind;
}

export interface PluginsOptions {
  home: string;
  db: DatabaseSync;
  log?: (line: string) => void;
  // Read-only plugins that ship with the lounge.
  bundledDir?: string;
  // Ids a plugin cannot take.
  coreRuntimes?: () => readonly string[];
}

// {repo}/plugins, from core/src/plugins.
const BUNDLED_DIR = resolve(import.meta.dirname, "..", "..", "..", "plugins");

// Plugins are the owner's code: they run in the core with full access.
export class Plugins {
  #home: string;
  #bundled: string;
  #coreRuntimes: () => readonly string[];
  #db: DatabaseSync;
  #log: (line: string) => void;
  #loaded: Loaded[] = [];
  // The kinds of the last finished load. A reload keeps them until it ends,
  // so a turn that starts in between still finds its runtime.
  #runtimes: RuntimeKind[] = [];
  #generation = 0;
  // Loads run one after another: an older load must not commit after a newer one.
  #queue: Promise<void> = Promise.resolve();
  #listeners = new Set<() => void>();

  constructor(opts: PluginsOptions) {
    this.#home = opts.home;
    this.#bundled = opts.bundledDir ?? BUNDLED_DIR;
    this.#coreRuntimes = opts.coreRuntimes ?? (() => []);
    this.#db = opts.db;
    this.#log = opts.log ?? ((line) => console.log(line));
  }

  dir(): string {
    return join(this.#home, "plugins");
  }

  enabledIds(): Set<string> {
    const raw = readSetting(this.#db, SETTING);
    if (!raw) return new Set();
    try {
      const list = JSON.parse(raw) as unknown;
      return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }

  // Adds ids to the setting. It does not load them.
  addEnabled(ids: string[]): void {
    const set = this.enabledIds();
    for (const id of ids) set.add(id);
    writeSetting(this.#db, SETTING, JSON.stringify([...set].sort()));
  }

  load(): Promise<void> {
    const run = this.#queue.then(() => this.#load());
    this.#queue = run.catch(() => {});
    return run;
  }

  async #load(): Promise<void> {
    await this.#unload();
    const generation = ++this.#generation;
    const enabled = this.enabledIds();
    // A plugin in the home folder wins over a bundled one.
    const found = new Map<string, { dir: string; bundled: boolean }>();
    for (const [root, bundled] of [[this.#bundled, true], [this.dir(), false]] as const) {
      if (!existsSync(root)) continue;
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() || !ID.test(d.name)) continue;
        if (!bundled && found.get(d.name)?.bundled) {
          this.#log(`plugin ${d.name}: home folder replaces the bundled plugin`);
        }
        found.set(d.name, { dir: join(root, d.name), bundled });
      }
    }
    const next: Loaded[] = [];
    const usedTools = new Set<string>();
    const usedRuntimes = new Map<string, string>();
    for (const id of [...found.keys()].sort()) {
      const { dir, bundled } = found.get(id)!;
      const p: Loaded = {
        id,
        dir,
        bundled,
        enabled: enabled.has(id),
        errors: [],
        tools: [],
        guards: [],
        runtimes: [],
        listeners: new Map(),
      };
      next.push(p);
      try {
        p.manifest = readManifest(dir);
      } catch (err) {
        p.errors.push((err as Error).message);
        continue;
      }
      if (!p.enabled || !p.manifest.main) continue;
      try {
        await this.#setup(p, generation, usedTools, usedRuntimes);
      } catch (err) {
        p.errors.push(`setup failed: ${(err as Error).message}`);
        p.tools = [];
        p.guards = [];
        p.listeners.clear();
        // Free the ids it took, so a later plugin may use them.
        for (const rt of p.runtimes) usedRuntimes.delete(rt.id);
        p.runtimes = [];
      }
    }
    this.#loaded = next;
    this.#runtimes = next.flatMap((p) => p.runtimes);
    for (const p of next) {
      if (p.errors.length) this.#log(`plugin ${p.id}: ${p.errors.join("; ")}`);
    }
    this.#emit();
  }

  async #setup(
    p: Loaded,
    generation: number,
    usedTools: Set<string>,
    usedRuntimes: Map<string, string>,
  ): Promise<void> {
    const main = resolve(p.dir, p.manifest!.main!);
    if (!inside(main, p.dir)) throw new Error("main must be inside the plugin folder");
    const mod = (await import(`${pathToFileURL(main).href}?v=${generation}`)) as { default?: unknown };
    if (typeof mod.default !== "function") throw new Error("the main module must export a default setup function");
    const api = {
      id: p.id,
      dir: p.dir,
      log: (text: unknown) => this.#log(`plugin ${p.id}: ${String(text)}`),
      guard: (fn: unknown) => {
        if (typeof fn !== "function") throw new Error("guard needs a function");
        p.guards.push({ plugin: p.id, fn: fn as PluginGuard["fn"] });
      },
      tool: (def: unknown) => this.#addTool(p, def, usedTools),
      runtime: (def: unknown) => this.#addRuntime(p, def, usedRuntimes),
      on: (event: unknown, fn: unknown) => {
        if (!EVENTS.includes(event as PluginEvent)) throw new Error(`unknown event ${String(event)}`);
        if (typeof fn !== "function") throw new Error("on needs a function");
        const list = p.listeners.get(event as PluginEvent) ?? [];
        list.push(fn as (payload: unknown) => unknown);
        p.listeners.set(event as PluginEvent, list);
      },
    };
    const result = await (mod.default as (a: typeof api) => unknown)(api);
    if (typeof result === "function") p.dispose = result as () => unknown;
  }

  #addRuntime(p: Loaded, def: unknown, used: Map<string, string>): void {
    const kind = checkRuntime(def);
    if (this.#coreRuntimes().includes(kind.id)) throw new Error(`runtime ${kind.id} is a core runtime`);
    const owner = used.get(kind.id);
    if (owner !== undefined) throw new Error(`runtime ${kind.id} already belongs to plugin ${owner}`);
    used.set(kind.id, p.id);
    p.runtimes.push(kind);
  }

  #addTool(p: Loaded, def: unknown, usedTools: Set<string>): void {
    const d = (def ?? {}) as Record<string, unknown>;
    if (typeof d.name !== "string" || !TOOL.test(d.name)) throw new Error("a tool name must match [a-z0-9_]{1,32}");
    if (typeof d.run !== "function") throw new Error(`tool ${d.name} needs run`);
    const input: Record<string, ToolField> = {};
    const raw = (d.input ?? {}) as Record<string, unknown>;
    for (const [key, field] of Object.entries(raw)) {
      const f = (field ?? {}) as Record<string, unknown>;
      if (!/^[A-Za-z_][\w]{0,31}$/.test(key) || typeof f.type !== "string" || !TYPES.has(f.type)) {
        throw new Error(`tool ${d.name} input ${key} needs type string, number, or boolean`);
      }
      input[key] = {
        type: f.type as ToolField["type"],
        ...(typeof f.description === "string" ? { description: f.description } : {}),
        ...(f.optional === true ? { optional: true } : {}),
      };
    }
    const mcpName = `plugin_${p.id.replace(/-/g, "_")}_${d.name}`;
    if (usedTools.has(mcpName)) throw new Error(`tool ${mcpName} already exists`);
    usedTools.add(mcpName);
    p.tools.push({
      plugin: p.id,
      name: d.name,
      mcpName,
      description: typeof d.description === "string" ? d.description : `Plugin ${p.id} tool ${d.name}`,
      input,
      run: d.run as PluginTool["run"],
    });
  }

  async #unload(): Promise<void> {
    for (const p of this.#loaded) {
      if (!p.dispose) continue;
      try {
        await p.dispose();
      } catch (err) {
        this.#log(`plugin ${p.id}: dispose failed: ${(err as Error).message}`);
      }
    }
    this.#loaded = [];
  }

  async close(): Promise<void> {
    await this.#queue;
    await this.#unload();
    this.#runtimes = [];
  }

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo[]> {
    if (!this.#loaded.some((p) => p.id === id)) {
      await this.load();
      if (!this.#loaded.some((p) => p.id === id)) throw new LoungeError("unknown_plugin", `unknown plugin ${id}`);
    }
    const set = this.enabledIds();
    if (enabled) set.add(id);
    else set.delete(id);
    writeSetting(this.#db, SETTING, JSON.stringify([...set].sort()));
    await this.load();
    return this.list();
  }

  list(): PluginInfo[] {
    return this.#loaded.map((p) => {
      const m = p.manifest;
      const panel = p.enabled && m?.panel && this.panelFile(p.id, m.panel) ? `/plugins/${p.id}/${m.panel.replace(/\\/g, "/")}` : undefined;
      return {
        id: p.id,
        name: m?.name ?? p.id,
        ...(m?.version ? { version: m.version } : {}),
        ...(m?.description ? { description: m.description } : {}),
        enabled: p.enabled,
        ...(p.errors.length ? { error: p.errors.join("; ") } : {}),
        tools: p.tools.map((t) => t.mcpName),
        guards: p.guards.length,
        runtimes: p.enabled ? p.runtimes.map((r) => r.id) : (m?.runtimes ?? []),
        bundled: p.bundled,
        ...(panel ? { panel } : {}),
      };
    });
  }

  guards(): PluginGuard[] {
    return this.#loaded.flatMap((p) => p.guards);
  }

  tools(): PluginTool[] {
    return this.#loaded.flatMap((p) => p.tools);
  }

  // The runtimes of enabled plugins, in load order.
  runtimes(): RuntimeKind[] {
    return this.#runtimes;
  }

  // The plugin that adds a runtime. A loaded plugin wins over a manifest.
  runtimeOwner(runtime: string): string | undefined {
    const live = this.#loaded.find((p) => p.runtimes.some((r) => r.id === runtime));
    if (live) return live.id;
    return this.#loaded.find((p) => p.manifest?.runtimes.includes(runtime))?.id;
  }

  // Grant rows: one per enabled plugin with tools.
  grantGroups(): { id: string; label: string; plugin: string; tools: string[] }[] {
    return this.#loaded
      .filter((p) => p.tools.length > 0)
      .map((p) => ({
        id: `plugin.${p.id}`,
        label: `Plugin: ${p.manifest?.name ?? p.id}`,
        plugin: p.id,
        tools: p.tools.map((t) => t.mcpName),
      }));
  }

  emit(event: PluginEvent, payload: unknown): void {
    for (const p of this.#loaded) {
      for (const fn of p.listeners.get(event) ?? []) {
        try {
          const out = fn(payload) as { catch?: unknown } | undefined;
          if (out && typeof out.catch === "function") {
            (out as Promise<unknown>).catch((err: unknown) => this.#log(`plugin ${p.id}: ${event} failed: ${(err as Error).message}`));
          }
        } catch (err) {
          this.#log(`plugin ${p.id}: ${event} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  // A file in an enabled plugin folder, or undefined.
  panelFile(id: string, rel: string): string | undefined {
    const p = this.#loaded.find((x) => x.id === id);
    if (!p || !p.enabled) return undefined;
    const full = resolve(p.dir, rel);
    if (!inside(full, p.dir)) return undefined;
    try {
      const real = realpathSync(full);
      if (!inside(real, realpathSync(p.dir)) || !statSync(real).isFile()) return undefined;
      return real;
    } catch {
      return undefined;
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(): void {
    for (const l of [...this.#listeners]) {
      try {
        l();
      } catch (err) {
        console.error("plugin listener failed:", err);
      }
    }
  }
}

export { sep };
