import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { openDb } from "../src/db/db.ts";
import { LoungeError, Room, type Layout } from "../src/lounge/room.ts";
import { tempHome } from "./helpers.ts";

function setup(t: TestContext) {
  const home = tempHome();
  const file = join(home.dir, "lounge.db");
  const db = openDb(file);
  const room = new Room(db);
  const frames: Layout[] = [];
  room.onLayout((l) => frames.push(l));
  t.after(() => {
    db.close();
    home.cleanup();
  });
  return { room, frames, db, file };
}

const code = (c: string) => (err: unknown) => err instanceof LoungeError && err.code === c;
const order = (room: Room) =>
  room
    .channels()
    .filter((c) => !c.parent)
    .map((c) => `${c.category ?? "-"}/${c.id}`);

test("a new channel goes last in the no-category group", (t) => {
  const { room } = setup(t);
  room.createChannel("games", "owner");
  room.createChannel("art", "owner");
  assert.deepEqual(order(room), ["-/lounge", "-/games", "-/art"]);
});

test("categories: create, rename, and delete keep channel order", (t) => {
  const { room, frames } = setup(t);
  room.createChannel("games", "owner");
  room.createChannel("art", "owner");
  const fun = room.createCategory("Fun");
  assert.match(fun.id, /^cat-[0-9a-f]{8}$/);
  room.setLayout({
    categories: [fun.id],
    channels: [
      { id: "lounge", category: null },
      { id: "art", category: fun.id },
      { id: "games", category: fun.id },
    ],
  });
  assert.deepEqual(order(room), ["-/lounge", `${fun.id}/art`, `${fun.id}/games`]);
  assert.deepEqual(room.renameCategory(fun.id, "Play"), { id: fun.id, name: "Play" });
  room.deleteCategory(fun.id);
  assert.deepEqual(order(room), ["-/lounge", "-/art", "-/games"]);
  assert.deepEqual(room.categories(), []);
  assert.equal(frames.length, 4);
  assert.throws(() => room.renameCategory(fun.id, "x"), code("unknown_category"));
  assert.throws(() => room.deleteCategory(fun.id), code("unknown_category"));
  assert.throws(() => room.createCategory(" "), code("bad_category"));
});

test("setLayout orders categories and refuses an incomplete or wrong list", (t) => {
  const { room } = setup(t);
  room.createChannel("games", "owner");
  const thread = room.createThread("games", "Work", "owner");
  const a = room.createCategory("A");
  const b = room.createCategory("B");
  const good = {
    categories: [b.id, a.id],
    channels: [
      { id: "games", category: b.id },
      { id: "lounge", category: a.id },
    ],
  };
  const out = room.setLayout(good);
  assert.deepEqual(out.categories.map((c) => c.name), ["B", "A"]);
  assert.deepEqual(order(room), [`${b.id}/games`, `${a.id}/lounge`]);
  assert.equal(room.channel(thread.id)?.category, undefined);
  const before = JSON.stringify(room.layout());
  const bad = [
    { ...good, channels: [{ id: "games", category: null }] },
    { ...good, channels: [...good.channels, { id: "games", category: null }] },
    { ...good, channels: [...good.channels, { id: thread.id, category: null }] },
    { ...good, channels: [{ id: "games", category: "cat-00000000" }, good.channels[1]] },
    { ...good, categories: [a.id] },
    { categories: "x", channels: [] },
    null,
  ];
  for (const body of bad) assert.throws(() => room.setLayout(body), code("bad_layout"));
  assert.equal(JSON.stringify(room.layout()), before);
});

test("an old database keeps its channel order", (t) => {
  const home = tempHome();
  const file = join(home.dir, "old.db");
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  raw.exec("INSERT INTO rooms (id, name) VALUES ('lounge', 'Lounge'), ('zeta', 'zeta'), ('alpha', 'alpha')");
  raw.close();
  const db = openDb(file);
  t.after(() => {
    db.close();
    home.cleanup();
  });
  const room = new Room(db);
  assert.deepEqual(room.channels().map((c) => c.id), ["lounge", "zeta", "alpha"]);
  room.createChannel("beta", "owner");
  assert.equal(room.channels().at(-1)?.id, "beta");
});
