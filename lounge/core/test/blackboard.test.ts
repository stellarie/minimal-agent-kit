import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTask, readBoard } from "../src/blackboard/blackboard.ts";

const VALID = `---
status: implementing
owner: worker-a
updated: 2026-11-21
---

# Add the panel

## Objective
Show the board.

## Work Items
- [ ] W1: write the reader | owner: none | files: a.ts, b.ts
- [x] W2: write the view | owner: worker-a | result: panel done, abc1234

## Thread
[worker-a, 2026-11-21] started
`;

function project(t: TestContext): { cwd: string; tasks: string } {
  const cwd = mkdtempSync(join(tmpdir(), "board-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5 }));
  const tasks = join(cwd, ".kit", "tasks");
  mkdirSync(tasks, { recursive: true });
  return { cwd, tasks };
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const path = join(e.parentPath, e.name);
    out[path] = e.isFile() ? readFileSync(path, "utf8") : "<dir>";
  }
  return out;
}

test("c14_2_valid", (t) => {
  const { cwd, tasks } = project(t);
  writeFileSync(join(tasks, "panel.md"), VALID);
  const board = readBoard(cwd);
  assert.deepEqual(board, [
    {
      ok: true,
      name: "panel.md",
      title: "Add the panel",
      status: "implementing",
      owner: "worker-a",
      updated: "2026-11-21",
      items: [
        { id: "W1", done: false, text: "write the reader", owner: "none", files: "a.ts, b.ts" },
        { id: "W2", done: true, text: "write the view", owner: "worker-a", result: "panel done, abc1234" },
      ],
    },
  ]);
});

test("c14_2_valid_crlf_bom_order: a CRLF file with a byte order mark parses, and files sort by name", (t) => {
  const { cwd, tasks } = project(t);
  writeFileSync(join(tasks, "b.md"), "﻿" + VALID.replace(/\n/g, "\r\n"));
  writeFileSync(join(tasks, "a.md"), VALID);
  writeFileSync(join(tasks, "notes.txt"), "not a task");
  mkdirSync(join(tasks, "dir.md"));
  const board = readBoard(cwd);
  assert.deepEqual(board.map((x) => [x.name, x.ok]), [["a.md", true], ["b.md", true]]);
});

test("c14_2_valid_owner_default: an item without an owner key shows owner none", () => {
  const task = parseTask("x.md", VALID.replace(" | owner: none", ""));
  assert.equal(task.ok, true);
  if (task.ok) assert.equal(task.items[0]!.owner, "none");
});

test("c14_2_valid_no_items: a file with no Work Items section has no items", () => {
  const task = parseTask("x.md", "---\nstatus: planning\nowner: none\nupdated: 2026-11-21\n---\n\n# T\n\n## Objective\nx\n");
  assert.deepEqual(task.ok && task.items, []);
});

test("c14_2_malformed", () => {
  const broken: Record<string, string> = {
    "no front matter": "# T\n\n## Work Items\n- [ ] W1: a | owner: none\n",
    "unclosed front matter": "---\nstatus: planning\nowner: none\n\n# T\n",
    "bad status": VALID.replace("implementing", "napping"),
    "no status": VALID.replace("status: implementing\n", ""),
    "no owner": VALID.replace("owner: worker-a\n", ""),
    "no title": VALID.replace("# Add the panel\n", ""),
    "bad item line": VALID.replace("- [x] W2:", "- [?] W2:"),
    "text in work items": VALID.replace("## Work Items\n", "## Work Items\nnot an item\n"),
    "unknown item key": VALID.replace("result:", "colour:"),
    "empty file": "",
  };
  for (const [label, text] of Object.entries(broken)) {
    const task = parseTask("bad.md", text);
    assert.equal(task.ok, false, label);
    if (!task.ok) {
      assert.equal(task.raw, text, label);
      assert.match(task.warning, /\S/, label);
      assert.equal(task.name, "bad.md", label);
    }
  }
});

test("SC30: Given a malformed task file, When the board is read, Then it shows the raw text with a warning and the other files still parse", (t) => {
  const { cwd, tasks } = project(t);
  writeFileSync(join(tasks, "a-bad.md"), "just words\n");
  writeFileSync(join(tasks, "b-good.md"), VALID);
  const board = readBoard(cwd);
  assert.equal(board.length, 2);
  assert.equal(board[0]!.ok, false);
  assert.equal(board[0]!.ok === false && board[0].raw, "just words\n");
  assert.equal(board[1]!.ok, true);
});

test("c14_2_no_folder", (t) => {
  const { cwd } = project(t);
  const bare = mkdtempSync(join(tmpdir(), "board-bare-"));
  t.after(() => rmSync(bare, { recursive: true, force: true, maxRetries: 5 }));
  assert.deepEqual(readBoard(bare), []);
  assert.deepEqual(readBoard(join(bare, "missing")), []);
  mkdirSync(join(bare, ".kit"));
  assert.deepEqual(readBoard(bare), []);
  writeFileSync(join(bare, ".kit", "tasks"), "a file, not a folder");
  assert.deepEqual(readBoard(bare), []);
  assert.deepEqual(readBoard(cwd), []);
});

test("SC29: Given no .kit/tasks folder, When the board is read, Then it is empty", (t) => {
  const bare = mkdtempSync(join(tmpdir(), "board-sc29-"));
  t.after(() => rmSync(bare, { recursive: true, force: true, maxRetries: 5 }));
  assert.deepEqual(readBoard(bare), []);
});

test("c14_1", (t) => {
  const { cwd, tasks } = project(t);
  writeFileSync(join(tasks, "a.md"), VALID);
  writeFileSync(join(tasks, "b.md"), "broken");
  const before = snapshot(cwd);
  readBoard(cwd);
  readBoard(join(cwd, "missing"));
  assert.deepEqual(snapshot(cwd), before);
});

test("c14_1_imports: the module imports only readdirSync and readFileSync from node:fs", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/blackboard/blackboard.ts", import.meta.url)), "utf8");
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(?:node:)?fs(?:\/promises)?"/g)];
  assert.equal(imports.length, 1);
  assert.deepEqual(
    imports[0]![1]!.split(",").map((s) => s.trim()).filter(Boolean).sort(),
    ["readFileSync", "readdirSync"],
  );
  assert.doesNotMatch(source, /import\s+\*\s+as\s+\w+\s+from\s+"(?:node:)?fs/);
  assert.doesNotMatch(source, /require\(/);
});

test("c14_2_valid_links: a tasks folder or file that is a link is not followed", (t) => {
  const { cwd, tasks } = project(t);
  const outside = mkdtempSync(join(tmpdir(), "board-out-"));
  t.after(() => rmSync(outside, { recursive: true, force: true, maxRetries: 5 }));
  writeFileSync(join(outside, "secret.md"), VALID);
  try {
    // A file link needs a right that Windows may not grant.
    symlinkSync(join(outside, "secret.md"), join(tasks, "link.md"), "file");
    assert.deepEqual(readBoard(cwd), []);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
  }
  // A junction needs no rights on Windows.
  rmSync(join(cwd, ".kit"), { recursive: true, force: true });
  mkdirSync(join(cwd, ".kit"));
  symlinkSync(outside, join(cwd, ".kit", "tasks"), "junction");
  assert.deepEqual(readBoard(cwd), []);
});
