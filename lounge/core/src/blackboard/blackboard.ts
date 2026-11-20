import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The kit blackboard: <project>/.kit/tasks/<slug>.md (core/skills/workflow/blackboard.md).
// This module only reads. It has no write call.

export const TASK_STATUSES = ["planning", "implementing", "review", "done", "blocked"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface BoardItem {
  id: string;
  done: boolean;
  text: string;
  owner: string;
  files?: string;
  result?: string;
}

export interface ParsedTask {
  ok: true;
  name: string;
  title: string;
  status: TaskStatus;
  owner: string;
  updated: string;
  items: BoardItem[];
}

// A file that does not parse shows as raw text.
export interface RawTask {
  ok: false;
  name: string;
  raw: string;
  warning: string;
}

export type BoardTask = ParsedTask | RawTask;

const ITEM = /^- \[( |x|X)\] ([\w.-]+): (.*)$/;
const ITEM_KEY = /^(owner|files|result): (.*)$/;

function raw(name: string, text: string, warning: string): RawTask {
  return { ok: false, name, raw: text, warning };
}

// An item line, or the reason it does not parse.
function parseItem(line: string): BoardItem | string {
  const m = ITEM.exec(line);
  if (!m) return `a work item line does not match "- [ ] W1: text | owner: none": ${line}`;
  const [text, ...fields] = m[3]!.split(" | ");
  const item: BoardItem = { id: m[2]!, done: m[1] !== " ", text: text!.trim(), owner: "none" };
  for (const field of fields) {
    const kv = ITEM_KEY.exec(field.trim());
    if (!kv) return `item ${item.id} has an unknown field: ${field.trim()}`;
    item[kv[1] as "owner" | "files" | "result"] = kv[2]!.trim();
  }
  return item;
}

export function parseTask(name: string, text: string): BoardTask {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return raw(name, text, "the file has no front matter");
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end < 0) return raw(name, text, "the front matter is not closed");
  const meta = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (kv) meta.set(kv[1]!, kv[2]!.trim());
  }
  const status = TASK_STATUSES.find((s) => s === meta.get("status"));
  if (!status) return raw(name, text, `status must be one of ${TASK_STATUSES.join(", ")}`);
  const owner = meta.get("owner");
  if (!owner) return raw(name, text, "the front matter has no owner");
  const body = lines.slice(end + 1);
  const title = body.find((l) => l.startsWith("# "))?.slice(2).trim();
  if (!title) return raw(name, text, "the file has no title line");
  const items: BoardItem[] = [];
  let inItems = false;
  for (const line of body) {
    if (line.startsWith("## ")) inItems = line.trimEnd() === "## Work Items";
    else if (inItems && line.trim() !== "") {
      const item = parseItem(line);
      if (typeof item === "string") return raw(name, text, item);
      items.push(item);
    }
  }
  return { ok: true, name, title, status, owner, updated: meta.get("updated") ?? "", items };
}

// A real folder: a link to a folder elsewhere does not count.
function hasFolder(parent: string, name: string): boolean {
  try {
    return readdirSync(parent, { withFileTypes: true }).some((e) => e.name === name && e.isDirectory());
  } catch {
    return false;
  }
}

// Every *.md file in <cwd>/.kit/tasks, sorted by name. The names come from the
// folder listing and the path is built from literals, so a read stays in cwd.
export function readBoard(cwd: string): BoardTask[] {
  const kit = join(cwd, ".kit");
  const dir = join(kit, "tasks");
  if (!hasFolder(cwd, ".kit") || !hasFolder(kit, "tasks")) return [];
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
  const board: BoardTask[] = [];
  for (const name of names) {
    try {
      board.push(parseTask(name, readFileSync(join(dir, name), "utf8")));
    } catch (err) {
      board.push(raw(name, "", `the file cannot be read: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  return board;
}
