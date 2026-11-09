import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.mjs";
import { retention } from "../src/decay.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amem-"));
}

function advance(store, sessions) {
  for (let i = 0; i < sessions; i++) store.startSession();
}

function entryOf(store, id) {
  return store.readState().memories[id];
}

test("recall near forgetting raises stability and restores retention", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  store.startSession();
  const m = store.remember({ type: "reference", title: "Deploy uses blue green", body: "Switch the router last." });
  const before = entryOf(store, m.id);
  advance(store, 3);
  const session = store.readState().session;
  const faded = retention(before, session);
  assert.ok(faded < 0.5, `expected faded retention, got ${faded}`);

  const { entry } = store.recall(m.id);
  assert.ok(entry.s > before.s, "stability grows on recall");
  assert.equal(retention(entry, session), 1);
  assert.equal(entry.uses, 2);
});

test("more sessions without recall give lower retention", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  const m = store.remember({ type: "reference", title: "x fact", body: "y" });
  const entry = entryOf(store, m.id);
  const values = [0, 1, 2, 5, 10].map((dt) => retention(entry, entry.last + dt));
  for (let i = 1; i < values.length; i++) assert.ok(values[i] < values[i - 1]);
});

test("faded memory leaves the index but search still finds it", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  const m = store.remember({ type: "reference", title: "Kafka retention is seven days", body: "Set by ops in 2026." });
  assert.match(store.index(), new RegExp(m.id));
  advance(store, 10);
  assert.doesNotMatch(store.index(), new RegExp(m.id));
  assert.match(store.index(), /1 more memories are not in this index/);
  const hits = store.search({ query: "kafka retention" });
  assert.equal(hits[0]?.id, m.id);
  assert.equal(entryOf(store, m.id).uses, 1, "search must not refresh");
});

test("pinned memory stays in the index at any age", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  const m = store.remember({ type: "reference", title: "Never force push main", body: "Hard rule.", pin: true });
  advance(store, 500);
  assert.match(store.index(), new RegExp(`Pinned:[\\s\\S]*${m.id}`));
  store.setPinned(m.id, false);
  assert.doesNotMatch(store.index(), new RegExp(m.id));
});

test("invalid memory never shows in index or default search", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  const m = store.remember({ type: "reference", title: "API port is 8080", body: "local dev", pin: true });
  store.invalidate(m.id, "moved to 9090");
  assert.doesNotMatch(store.index(), new RegExp(m.id));
  assert.equal(store.search({ query: "api port" }).length, 0);
  const all = store.search({ query: "api port", includeInvalid: true });
  assert.equal(all[0].id, m.id);
  assert.equal(all[0].valid, false);
});

test("two recalls in one session refresh only once", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  const m = store.remember({ type: "reference", title: "t", body: "b" });
  advance(store, 2);
  const first = store.recall(m.id).entry;
  const second = store.recall(m.id).entry;
  assert.deepEqual(second, first);
});

test("strength is per agent", () => {
  const root = tempRoot();
  const a = new Store({ root, agent: "a" });
  const b = new Store({ root, agent: "b" });
  const m = a.remember({ type: "reference", title: "shared fact", body: "body" });
  assert.equal(b.readState().memories[m.id], undefined);
  assert.doesNotMatch(b.index(), new RegExp(m.id), "unseen memory starts cold for others");
  assert.equal(b.search({ query: "shared fact" })[0].id, m.id);

  const beforeA = entryOf(a, m.id);
  advance(b, 3);
  b.recall(m.id);
  assert.deepEqual(entryOf(a, m.id), beforeA);
  assert.equal(a.readState().session, 0, "clocks are per agent");
  assert.match(b.index(), new RegExp(m.id));
});

test("index respects the budget and lists hidden memories", () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ budget: 2 }));
  const store = new Store({ root, agent: "a" });
  for (let i = 0; i < 4; i++) store.remember({ type: "reference", title: `fact ${i}`, body: "b" });
  const entries = store.index().split("\n").filter((l) => l.startsWith("- ["));
  assert.equal(entries.length, 2);
  assert.match(store.index(), /2 more memories are not in this index/);
});

test("ids reject path traversal", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  assert.throws(() => store.recall("../state/a"), /invalid memory id/);
});

test("multi-line titles and tags cannot inject frontmatter", () => {
  const store = new Store({ root: tempRoot(), agent: "a" });
  const m = store.remember({ type: "reference", title: "a\nvalid: false", body: "---\nnot: frontmatter", tags: ["x\ny"] });
  const back = store.readMemory(m.id);
  assert.equal(back.valid, true);
  assert.equal(back.title, "a valid: false");
  assert.equal(back.body, "---\nnot: frontmatter");
});

test("hand-edited files: BOM and capitalized booleans", () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, "memories"));
  fs.writeFileSync(
    path.join(root, "memories", "hand-1.md"),
    "﻿---\r\nid: hand-1\r\ntitle: Hand written zebra note\r\nvalid: False\r\n---\r\n\r\nbody\r\n",
  );
  fs.writeFileSync(
    path.join(root, "memories", "hand-2.md"),
    "﻿---\nid: hand-2\ntitle: Hand pinned zebra rule: keep\npinned: TRUE\n---\n\nbody\n",
  );
  const store = new Store({ root, agent: "a" });
  assert.deepEqual(store.search({ query: "zebra" }).map((h) => h.id), ["hand-2"]);
  assert.equal(store.search({ query: "zebra", includeInvalid: true }).length, 2);
  assert.match(store.index(), /Pinned:[\s\S]*hand-2\] Hand pinned zebra rule: keep/);
});
