import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/db.ts";
import { tempHome } from "./helpers.ts";

function roomIds(file: string): string[] {
  const db = openDb(file);
  try {
    return db.prepare("SELECT id FROM rooms").all().map((r) => String(r.id));
  } finally {
    db.close();
  }
}

test("openDb creates tables and room lounge", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const db = openDb(join(home.dir, "lounge.db"));
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => String(r.name));
    for (const name of ["messages", "presence", "rooms"]) {
      assert.ok(tables.includes(name), `missing table ${name}`);
    }
    const rooms = db.prepare("SELECT id FROM rooms").all().map((r) => String(r.id));
    assert.deepEqual(rooms, ["lounge"]);
  } finally {
    db.close();
  }
});

test("openDb uses WAL", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const db = openDb(join(home.dir, "lounge.db"));
  try {
    const row = db.prepare("PRAGMA journal_mode").get();
    assert.equal(row?.journal_mode, "wal");
  } finally {
    db.close();
  }
});

test("openDb twice is idempotent", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const file = join(home.dir, "lounge.db");
  assert.deepEqual(roomIds(file), ["lounge"]);
  assert.deepEqual(roomIds(file), ["lounge"]);
});

test("openDb adds topic and kind to an older database", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const file = join(home.dir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(
    "CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL);" +
      "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id)," +
      " author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);" +
      "INSERT INTO rooms VALUES ('lounge', 'Lounge');" +
      "INSERT INTO messages (room_id, author, text, created_at) VALUES ('lounge', 'ada', 'hi', 'x');",
  );
  old.close();
  const db = openDb(file);
  try {
    const row = db.prepare("SELECT m.kind, r.topic FROM messages m JOIN rooms r ON r.id = m.room_id").get();
    assert.deepEqual({ ...row }, { kind: "text", topic: "" });
  } finally {
    db.close();
  }
});
