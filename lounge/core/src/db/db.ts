import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ROOM } from "../config.ts";

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

// Older databases lack later columns.
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function openDb(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  addColumn(db, "rooms", "topic", "TEXT NOT NULL DEFAULT ''");
  addColumn(db, "messages", "kind", "TEXT NOT NULL DEFAULT 'text'");
  addColumn(db, "rooms", "parent", "TEXT");
  addColumn(db, "messages", "attachments", "TEXT");
  addColumn(db, "events", "repeat", "TEXT NOT NULL DEFAULT 'none'");
  addColumn(db, "rooms", "category", "TEXT");
  addColumn(db, "rooms", "position", "INTEGER");
  addColumn(db, "agents", "tool_mode", "TEXT");
  addColumn(db, "rooms", "turn_mode", "TEXT");
  addColumn(db, "rooms", "slow_sec", "INTEGER");
  addColumn(db, "threads", "parent_id", "TEXT");
  addColumn(db, "messages", "reply_to", "INTEGER");
  // Old channels keep their creation order.
  db.exec("UPDATE rooms SET position = rowid WHERE position IS NULL");
  db.prepare("INSERT OR IGNORE INTO rooms (id, name) VALUES (?, ?)").run(DEFAULT_ROOM, "Lounge");
  return db;
}
