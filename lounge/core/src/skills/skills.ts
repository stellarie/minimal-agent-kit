import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChatTurnInput } from "../adapters/types.ts";
import { LoungeError } from "../lounge/room.ts";
import type { RuntimeContext } from "../roster/types.ts";

export const SKILL_NAME = /^[a-z0-9-]{1,64}$/;
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_DESCRIPTION = 1024;
const READ_FILE_MAX = 1024 * 1024;
const SKILL_FILE = "SKILL.md";
const REMOVED = ".removed";
// A $name is a whole word: no word character or $ before it, none after it.
const REF = /(?<![\w$])\$([a-z][a-z0-9-]{0,63})(?![\w-])/g;

export interface SkillInfo {
  name: string;
  description: string;
  size: number;
}

export interface SkillSkip {
  name: string;
  reason: string;
}

export interface SkillScan {
  skills: SkillInfo[];
  skipped: SkillSkip[];
}

// What the context lists for each skill.
export interface SkillEntry {
  name: string;
  description: string;
}

export type Parsed =
  | { ok: true; name: string; description: string; body: string }
  | { ok: false; reason: string };

function bad(message: string): LoungeError {
  return new LoungeError("bad_skill", message);
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      // Not JSON escapes: take the inner text.
    }
    return v.slice(1, -1);
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// Top-level `key: value` pairs only, plain, quoted, or block text.
function frontPairs(front: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = front.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!.trim();
    const more: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === "")) {
      more.push(lines[++i]!.trim());
    }
    while (more.length > 0 && more.at(-1) === "") more.pop();
    const block = /^([>|])[+-]?$/.exec(rest);
    if (block) out[key] = block[1] === ">" ? more.join(" ").replace(/\s+/g, " ").trim() : more.join("\n");
    else out[key] = more.length > 0 ? `${unquote(rest)} ${more.join(" ")}`.trim() : unquote(rest);
  }
  return out;
}

export function parseSkill(raw: string): Parsed {
  const text = raw.replace(/^﻿/, "");
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return { ok: false, reason: "no front matter" };
  const rest = text.slice(open[0].length);
  const close = /^---[ \t]*$/m.exec(rest);
  if (!close) return { ok: false, reason: "no front matter" };
  const pairs = frontPairs(rest.slice(0, close.index));
  const name = pairs.name;
  if (name === undefined || name === "") return { ok: false, reason: "no front matter name" };
  if (!SKILL_NAME.test(name)) return { ok: false, reason: `name is outside [a-z0-9-]{1,64}: ${name.slice(0, 80)}` };
  const description = pairs.description;
  if (description === undefined || description === "") return { ok: false, reason: "no front matter description" };
  const body = rest.slice(close.index + close[0].length).replace(/^(\r?\n)+/, "");
  return { ok: true, name, description, body };
}

// Names after $, kept when a skill of that name exists.
export function skillRefs(text: string, names: readonly string[]): string[] {
  const present = new Set(names);
  const out: string[] = [];
  for (const m of text.matchAll(REF)) {
    const name = m[1]!;
    if (present.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, "");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A skill that a plugin supplies. It is read-only, and a lounge skill of the same name wins.
export interface SkillSource {
  name: string;
  // Absolute folder of the SKILL.md and the files beside it.
  dir: string;
  // $NAME in the body becomes the absolute path.
  vars: Record<string, string>;
}

function slashes(path: string): string {
  return path.replace(/\\/g, "/");
}

// The lounge skills: one folder per skill under {home}/skills, and the skills of plugins.
// A skill folder of a harness (~/.claude/skills, ~/.codex/skills) is never read.
export class Skills {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #extra: () => SkillSource[];
  #signature = "";
  #scan: SkillScan = { skills: [], skipped: [] };

  constructor(opts: { home: string; now?: () => Date; extra?: () => SkillSource[] }) {
    this.#root = join(opts.home, "skills");
    this.#now = opts.now ?? (() => new Date());
    this.#extra = opts.extra ?? (() => []);
  }

  get root(): string {
    return this.#root;
  }

  #folders(): { name: string; file: string; stamp: string }[] {
    const out: { name: string; file: string; stamp: string }[] = [];
    try {
      for (const e of readdirSync(this.#root, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const folder = join(this.#root, e.name);
        const file = join(folder, SKILL_FILE);
        try {
          const st = lstatSync(file);
          if (!st.isFile()) continue;
          out.push({ name: e.name, file, stamp: `${e.name}|${statSync(folder).mtimeMs}|${st.mtimeMs}|${st.size}` });
        } catch {
          // A folder with no SKILL.md is no skill.
        }
      }
    } catch {
      // No skills folder yet.
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    const taken = new Set(out.map((f) => f.name));
    for (const src of this.#extra()) {
      if (taken.has(src.name)) continue;
      const file = join(src.dir, SKILL_FILE);
      try {
        const st = lstatSync(file);
        if (!st.isFile()) continue;
        taken.add(src.name);
        out.push({ name: src.name, file, stamp: `${src.name}|${file}|${st.mtimeMs}|${st.size}` });
      } catch {
        // A plugin folder with no SKILL.md is no skill.
      }
    }
    return out;
  }

  // The plugin that supplies a skill, unless a lounge skill of that name hides it.
  #sourceOf(name: string): SkillSource | undefined {
    try {
      if (lstatSync(join(this.#root, name, SKILL_FILE)).isFile()) return undefined;
    } catch {
      // No lounge skill of that name.
    }
    return this.#extra().find((s) => s.name === name);
  }

  // Scans again only when a folder or a SKILL.md changed.
  scan(): SkillScan {
    let rootStamp = "none";
    try {
      rootStamp = String(statSync(this.#root).mtimeMs);
    } catch {
      // No skills folder yet.
    }
    const folders = this.#folders();
    const signature = `${rootStamp}#${folders.map((f) => f.stamp).join(";")}`;
    if (signature === this.#signature) return this.#scan;
    const skills: SkillInfo[] = [];
    const skipped: SkillSkip[] = [];
    for (const f of folders) {
      const reason = this.#check(f.name, f.file, skills);
      if (reason !== undefined) skipped.push({ name: f.name, reason });
    }
    this.#signature = signature;
    this.#scan = { skills, skipped };
    return this.#scan;
  }

  #check(folder: string, file: string, into: SkillInfo[]): string | undefined {
    if (!SKILL_NAME.test(folder)) return "folder name is outside [a-z0-9-]{1,64}";
    let size: number;
    let raw: string;
    try {
      size = statSync(file).size;
      if (size > MAX_SKILL_BYTES) return `SKILL.md is over ${MAX_SKILL_BYTES / 1024} KiB`;
      raw = readFileSync(file, "utf8");
    } catch (err) {
      return `SKILL.md cannot be read: ${(err as Error).message}`;
    }
    const parsed = parseSkill(raw);
    if (!parsed.ok) return parsed.reason;
    if (parsed.name !== folder) return `name ${parsed.name} does not match folder ${folder}`;
    into.push({ name: folder, description: parsed.description.slice(0, MAX_DESCRIPTION), size });
    return undefined;
  }

  present(): Set<string> {
    return new Set(this.scan().skills.map((s) => s.name));
  }

  // Name and description of every valid skill. The context lists these.
  index(): SkillEntry[] {
    return this.scan().skills.map(({ name, description }) => ({ name, description }));
  }

  #folder(name: unknown): string {
    if (typeof name !== "string" || !SKILL_NAME.test(name)) throw bad("name must match [a-z0-9-]{1,64}");
    return join(this.#root, name);
  }

  // The folder of a skill that has a SKILL.md, valid or not.
  #existing(name: unknown): { folder: string; file: string } {
    const label = typeof name === "string" ? name.slice(0, 80) : String(name);
    if (typeof name !== "string" || !SKILL_NAME.test(name)) throw new LoungeError("unknown_skill", `unknown skill: ${label}`);
    const folder = join(this.#root, name);
    const file = join(folder, SKILL_FILE);
    try {
      if (lstatSync(file).isFile()) return { folder, file };
    } catch {
      // Falls through to the error.
    }
    throw new LoungeError("unknown_skill", `unknown skill: ${label}`);
  }

  // The whole SKILL.md, for the editor.
  get(name: string): { name: string; text: string } {
    const { file } = this.#existing(name);
    if (statSync(file).size > READ_FILE_MAX) throw bad("SKILL.md is too large to show");
    return { name, text: readFileSync(file, "utf8") };
  }

  // The text a turn loads: the SKILL.md under its front matter.
  // Only a valid skill loads. The editor still opens a skipped folder, so the owner can fix it.
  body(name: string): string {
    if (!this.present().has(name)) throw new LoungeError("unknown_skill", `unknown skill: ${String(name).slice(0, 80)}`);
    const source = this.#sourceOf(name);
    if (source) return this.#pluginBody(source);
    const { text } = this.get(name);
    const parsed = parseSkill(text);
    return parsed.ok ? parsed.body : text;
  }

  // The body with each $NAME of the plugin replaced, and the folder of the skill files at the end.
  #pluginBody(source: SkillSource): string {
    const parsed = parseSkill(readFileSync(join(source.dir, SKILL_FILE), "utf8"));
    let text = parsed.ok ? parsed.body : "";
    for (const [key, path] of Object.entries(source.vars)) {
      text = text.replace(new RegExp(`\\$${key}(?![A-Za-z0-9_])`, "g"), () => slashes(path));
    }
    return `${text.trimEnd()}\n\nSkill files: ${slashes(source.dir)}\n`;
  }

  #writeSkillFile(file: string, text: string): void {
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(temp, text);
    renameSync(temp, file);
  }

  create(input: unknown): SkillInfo {
    if (!isObject(input)) throw bad("body must be an object");
    const { name, description, body } = input;
    const folder = this.#folder(name);
    if (typeof description !== "string" || description.trim() === "") throw bad("description must be text");
    if (description.length > MAX_DESCRIPTION) throw bad(`description has at most ${MAX_DESCRIPTION} characters`);
    if (typeof body !== "string") throw bad("body must be text");
    const text = `---\nname: ${name as string}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${body}\n`;
    if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw bad(`SKILL.md has at most ${MAX_SKILL_BYTES / 1024} KiB`);
    mkdirSync(this.#root, { recursive: true });
    try {
      mkdirSync(folder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new LoungeError("skill_exists", `a skill named ${name as string} exists`);
      }
      throw err;
    }
    try {
      this.#writeSkillFile(join(folder, SKILL_FILE), text);
    } catch (err) {
      // The folder holds nothing yet: rmdir fails on a full one.
      rmdirSync(folder);
      throw err;
    }
    return { name: name as string, description: description.trim().slice(0, MAX_DESCRIPTION), size: Buffer.byteLength(text) };
  }

  replace(name: string, text: unknown): { name: string; text: string } {
    const { file } = this.#existing(name);
    if (typeof text !== "string") throw bad("text must be the full SKILL.md");
    if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw bad(`SKILL.md has at most ${MAX_SKILL_BYTES / 1024} KiB`);
    const parsed = parseSkill(text);
    if (!parsed.ok) throw bad(`SKILL.md is not valid: ${parsed.reason}`);
    if (parsed.name !== name) throw bad(`name must stay ${name}`);
    this.#writeSkillFile(file, text);
    return { name, text };
  }

  // Moves the folder aside. Nothing is deleted.
  remove(name: string): string {
    const { folder } = this.#existing(name);
    const aside = join(this.#root, REMOVED);
    mkdirSync(aside, { recursive: true });
    const base = `${name}-${stamp(this.#now())}`;
    let target = join(aside, base);
    for (let n = 2; existsSync(target); n++) target = join(aside, `${base}-${n}`);
    renameSync(folder, target);
    return target;
  }
}

type Prompt = RuntimeContext["prompt"];

// A prompt that adds the lounge skills to each turn. The skills are read on every
// call, so an edit shows at once. A $name counts only in the owner's last post.
export function withSkills(prompt: Prompt, store: Pick<Skills, "index" | "body">): Prompt {
  const extend = (input: ChatTurnInput): ChatTurnInput => {
    const skillIndex = store.index();
    const last = input.context.findLast((m) => m.author === "owner" && m.kind === undefined);
    const skillBodies: { name: string; body: string }[] = [];
    for (const name of last ? skillRefs(last.text, skillIndex.map((s) => s.name)) : []) {
      try {
        skillBodies.push({ name, body: store.body(name) });
      } catch {
        // A skill removed since the scan stays text.
      }
    }
    return { ...input, skillIndex, skillBodies };
  };
  return {
    ...prompt,
    systemText: (input) => prompt.systemText(extend(input)),
    turnText: (input) => prompt.turnText(extend(input)),
    chatPrompt: (input) => prompt.chatPrompt(extend(input)),
  };
}
