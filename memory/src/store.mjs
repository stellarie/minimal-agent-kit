import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULTS, refresh, retention, tier } from "./decay.mjs";
import { MEMORY_TYPES, oneLine, parseMemory, serializeMemory, splitTags } from "./frontmatter.mjs";
import { readJson, readText, withLock, writeFileAtomic } from "./fsutil.mjs";
import { scoreMemory, snippet } from "./search.mjs";

const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const AGENT_PATTERN = /[^a-z0-9_-]/g;

export function resolveRoot(env = process.env) {
  return env.AGENT_MEMORY_HOME || path.join(os.homedir(), ".agent-memory");
}

// An explicit name wins over the runtime default.
// Codex sets PLUGIN_ROOT; Claude Code sets only CLAUDE_PLUGIN_ROOT.
export function resolveAgent(env = process.env, { agent, runtime } = {}) {
  let name = agent || env.AGENT_MEMORY_AGENT || runtime || env.AGENT_MEMORY_RUNTIME;
  if (!name && env.PLUGIN_ROOT) name = "codex";
  if (!name && (env.CLAUDECODE || env.CLAUDE_PLUGIN_ROOT)) name = "claude";
  name = String(name || "default").toLowerCase().replace(AGENT_PATTERN, "");
  return name || "default";
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function newId() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${stamp}-${crypto.randomBytes(4).toString("hex")}`;
}

function firstLine(body, width = 120) {
  const line = body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line.length > width ? `${line.slice(0, width - 3)}...` : line;
}

const TEMPLATE_TYPES = new Set(["feedback", "project"]);
const TEMPLATE_LABELS = ["Why:", "How to apply:"];

function hasLabeledLine(body, label) {
  return body.split(/\r?\n/).some((line) => {
    const text = line.trim();
    return text.startsWith(label) && text.slice(label.length).trim() !== "";
  });
}

// One rule set for the tool, the CLI, and the capture hook.
export function validateMemoryInput({ title, type, body }) {
  title = oneLine(title);
  if (!title) throw new Error("remember needs a title");
  type = String(type ?? "").trim().toLowerCase();
  if (!MEMORY_TYPES.includes(type)) {
    throw new Error(`remember needs a type: one of ${MEMORY_TYPES.join(", ")}`);
  }
  body = String(body ?? "");
  if (TEMPLATE_TYPES.has(type)) {
    const missing = TEMPLATE_LABELS.filter((label) => !hasLabeledLine(body, label));
    if (missing.length) {
      throw new Error(
        `a ${type} memory body needs a line that starts with ${missing.map((l) => `"${l}"`).join(" and ")}`,
      );
    }
  }
  return { title, type, body };
}

const typeLabel = (memory) => (memory.type ? `(${memory.type}) ` : "");

export class Store {
  constructor({ root = resolveRoot(), agent = resolveAgent() } = {}) {
    this.root = root;
    this.agent = String(agent).toLowerCase().replace(AGENT_PATTERN, "") || "default";
    this.memoriesDir = path.join(root, "memories");
    this.stateFile = path.join(root, "state", `${this.agent}.json`);
    this.lockDir = path.join(root, ".lock");
    this.config = { ...DEFAULTS, ...readJson(path.join(root, "config.json"), {}) };
  }

  locked(fn) {
    return withLock(this.lockDir, fn);
  }

  readState() {
    const state = readJson(this.stateFile, null) ?? { version: 1, session: 0, memories: {} };
    state.memories ??= {};
    state.session ??= 0;
    return state;
  }

  writeState(state) {
    writeFileAtomic(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }

  memoryFile(id) {
    if (!ID_PATTERN.test(String(id))) throw new Error(`invalid memory id: ${id}`);
    return path.join(this.memoriesDir, `${id}.md`);
  }

  readMemory(id) {
    const file = this.memoryFile(id);
    if (!fs.existsSync(file)) throw new Error(`no memory with id ${id}`);
    return parseMemory(readText(file));
  }

  writeMemory(memory) {
    writeFileAtomic(this.memoryFile(memory.id), serializeMemory(memory));
  }

  listMemories() {
    let names;
    try {
      names = fs.readdirSync(this.memoriesDir);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const memories = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      try {
        memories.push(parseMemory(readText(path.join(this.memoriesDir, name))));
      } catch {
        // A hand-edited file with broken frontmatter must not break the index.
      }
    }
    return memories.filter((m) => m.id && ID_PATTERN.test(m.id));
  }

  remember({ title, type, body = "", tags = [], pin = false, author }) {
    ({ title, type, body } = validateMemoryInput({ title, type, body }));
    return this.locked(() => {
      let id = newId();
      while (fs.existsSync(this.memoryFile(id))) id = newId();
      const memory = {
        id,
        title,
        type,
        tags: splitTags(tags),
        pinned: Boolean(pin),
        valid: true,
        invalid_reason: "",
        author: author || this.agent,
        created: today(),
        updated: today(),
        body,
      };
      this.writeMemory(memory);
      const state = this.readState();
      state.memories[id] = refresh(undefined, state.session, this.config);
      this.writeState(state);
      return memory;
    });
  }

  search({ query, limit = 8, includeInvalid = false }) {
    const state = this.readState();
    return this.listMemories()
      .filter((m) => includeInvalid || m.valid)
      .map((m) => ({
        memory: m,
        score: scoreMemory(query, m),
        retention: retention(state.memories[m.id], state.session),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.retention - a.retention)
      .slice(0, Math.max(1, Number(limit) || 8))
      .map((hit) => ({
        id: hit.memory.id,
        title: hit.memory.title,
        type: hit.memory.type,
        valid: hit.memory.valid,
        score: Number(hit.score.toFixed(2)),
        retention: Number(hit.retention.toFixed(3)),
        snippet: snippet(query, hit.memory),
      }));
  }

  recall(id) {
    return this.locked(() => {
      const memory = this.readMemory(id);
      const state = this.readState();
      const before = state.memories[id];
      const after = refresh(before, state.session, this.config);
      state.memories[id] = after;
      this.writeState(state);
      return { memory, entry: after, retention: retention(after, state.session) };
    });
  }

  setPinned(id, pinned) {
    return this.locked(() => {
      const memory = this.readMemory(id);
      memory.pinned = Boolean(pinned);
      memory.updated = today();
      this.writeMemory(memory);
      return memory;
    });
  }

  invalidate(id, reason) {
    reason = oneLine(reason);
    if (!reason) throw new Error("invalidate needs a reason");
    return this.locked(() => {
      const memory = this.readMemory(id);
      memory.valid = false;
      memory.invalid_reason = reason;
      memory.updated = today();
      this.writeMemory(memory);
      return memory;
    });
  }

  startSession() {
    return this.locked(() => {
      const state = this.readState();
      state.session += 1;
      this.writeState(state);
      return state.session;
    });
  }

  tiers() {
    const state = this.readState();
    const groups = { pinned: [], hot: [], fading: [], cold: [], invalid: [] };
    for (const memory of this.listMemories()) {
      const entry = state.memories[memory.id];
      groups[tier(memory, entry, state.session, this.config)].push({
        memory,
        retention: retention(entry, state.session),
      });
    }
    groups.pinned.sort((a, b) => a.memory.title.localeCompare(b.memory.title));
    for (const name of ["hot", "fading", "cold"]) {
      groups[name].sort((a, b) => b.retention - a.retention);
    }
    return { session: state.session, groups };
  }

  index() {
    const { session, groups } = this.tiers();
    const room = Math.max(0, this.config.budget - groups.pinned.length);
    const hot = groups.hot.slice(0, room);
    const fading = groups.fading.slice(0, room - hot.length);
    const hidden =
      groups.cold.length + (groups.hot.length - hot.length) + (groups.fading.length - fading.length);

    const lines = [`# Memory index (agent: ${this.agent}, session ${session})`];
    const full = ({ memory }) => `- [${memory.id}] ${typeLabel(memory)}${memory.title} - ${firstLine(memory.body)}`;
    if (groups.pinned.length) lines.push("", "Pinned:", ...groups.pinned.map(full));
    if (hot.length) lines.push("", "Recent:", ...hot.map(full));
    if (fading.length) {
      lines.push(
        "",
        "Fading (recall to keep):",
        ...fading.map(({ memory }) => `- [${memory.id}] ${typeLabel(memory)}${memory.title}`),
      );
    }
    if (!groups.pinned.length && !hot.length && !fading.length) lines.push("", "No memories in the index.");
    lines.push(
      "",
      `${hidden} more memories are not in this index.`,
      "Search before you assume: the memory_search tool, or `amem search \"<words>\"`.",
    );
    return lines.join("\n");
  }

  stats() {
    const { session, groups } = this.tiers();
    return {
      agent: this.agent,
      session,
      root: this.root,
      ...Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, list.length])),
    };
  }
}
