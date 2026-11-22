import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readSetting } from "../src/db/settings.ts";
import { GUARD_MODES, GuardModeStore, isGuardMode } from "../src/guard/guardMode.ts";

function memory(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return db;
}

test("c1_1: a new store with no setting gives normal", () => {
  assert.equal(new GuardModeStore(memory()).get(), "normal");
});

test("c1_1: a persisted auto comes back after a restart", () => {
  const db = memory();
  new GuardModeStore(db).set("auto");
  assert.equal(readSetting(db, "guard.mode"), "auto");
  assert.equal(new GuardModeStore(db).get(), "auto");
});

test("c1_1: bypass gives bypass now and normal after a restart", () => {
  const db = memory();
  const store = new GuardModeStore(db);
  store.set("bypass");
  assert.equal(store.get(), "bypass");
  assert.equal(readSetting(db, "guard.mode"), "normal");
  assert.equal(new GuardModeStore(db).get(), "normal");
});

test("c1_1: an unknown persisted value gives normal", () => {
  const db = memory();
  db.prepare("INSERT INTO settings (key, value) VALUES ('guard.mode', 'yolo')").run();
  assert.equal(new GuardModeStore(db).get(), "normal");
});

test("a set of an unknown mode throws and keeps the mode", () => {
  const store = new GuardModeStore(memory());
  store.set("auto");
  assert.throws(() => store.set("yolo" as never), /guard mode/);
  assert.equal(store.get(), "auto");
  assert.deepEqual([...GUARD_MODES], ["normal", "auto", "bypass"]);
  assert.equal(isGuardMode("bypass"), true);
  assert.equal(isGuardMode("Bypass"), false);
});
