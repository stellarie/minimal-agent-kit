import { test } from "node:test";
import assert from "node:assert/strict";
import { advance, finish, hintAt, press, type Hint, type Row } from "./drag.ts";

const BOX = { left: 0, right: 200, top: 0, bottom: 400 };

// loose: lounge, games | Fun: art, music | Empty
const ROWS: Row[] = [
  { kind: "group", category: null, top: 0, bottom: 60 },
  { kind: "channel", id: "lounge", category: null, top: 0, mid: 10, bottom: 20 },
  { kind: "channel", id: "games", category: null, top: 20, mid: 30, bottom: 40 },
  { kind: "group", category: "fun", top: 66, bottom: 160, headMid: 76 },
  { kind: "channel", id: "art", category: "fun", top: 90, mid: 100, bottom: 110 },
  { kind: "channel", id: "music", category: "fun", top: 110, mid: 120, bottom: 130 },
  { kind: "group", category: "empty", top: 166, bottom: 210, headMid: 176 },
];

const channel = (id: string) => ({ kind: "channel" as const, id });
const category = (id: string) => ({ kind: "category" as const, id });
const before = (id: string): Hint => ({ kind: "channel", drop: { kind: "before", id } });
const into = (cat: string | null): Hint => ({ kind: "channel", drop: { kind: "into", category: cat } });

test("c1_1: a pointer outside the list gives no hint", () => {
  for (const drag of [channel("games"), category("fun")]) {
    assert.equal(hintAt(drag, 300, 100, ROWS, BOX), null);
    assert.equal(hintAt(drag, -1, 100, ROWS, BOX), null);
    assert.equal(hintAt(drag, 50, -5, ROWS, BOX), null);
    assert.equal(hintAt(drag, 50, 400, ROWS, BOX), null);
  }
  assert.equal(hintAt(channel("games"), 50, 100, [], BOX), null);
});

test("c1_1: a channel over the upper half of a row drops before that row", () => {
  assert.deepEqual(hintAt(channel("games"), 50, 112, ROWS, BOX), before("music"));
  assert.deepEqual(hintAt(channel("games"), 50, 92, ROWS, BOX), before("art"));
  assert.deepEqual(hintAt(channel("art"), 50, 5, ROWS, BOX), before("lounge"));
});

test("c1_1: a channel over the lower half of a row drops before the next row, or at the group end", () => {
  assert.deepEqual(hintAt(channel("music"), 50, 105, ROWS, BOX), before("music"));
  assert.deepEqual(hintAt(channel("lounge"), 50, 15, ROWS, BOX), before("games"));
  assert.deepEqual(hintAt(channel("games"), 50, 125, ROWS, BOX), into("fun"));
  assert.deepEqual(hintAt(channel("art"), 50, 35, ROWS, BOX), into(null));
});

test("c1_1: a channel over a group with no visible row drops into that group", () => {
  assert.deepEqual(hintAt(channel("games"), 50, 190, ROWS, BOX), into("empty"));
  const folded = ROWS.filter((r) => r.kind === "group" || (r.kind === "channel" && r.category !== "fun"));
  assert.deepEqual(hintAt(channel("games"), 50, 100, folded, BOX), into("fun"));
  assert.equal(hintAt(channel("games"), 50, 63, ROWS, BOX), null);
});

test("c1_1: a category over a header drops before it or before the next category", () => {
  assert.deepEqual(hintAt(category("empty"), 50, 70, ROWS, BOX), { kind: "category", before: "fun" });
  assert.deepEqual(hintAt(category("empty"), 50, 80, ROWS, BOX), { kind: "category", before: "empty" });
  assert.deepEqual(hintAt(category("fun"), 50, 180, ROWS, BOX), { kind: "category", before: null });
  assert.deepEqual(hintAt(category("empty"), 50, 120, ROWS, BOX), { kind: "category", before: "empty" });
  assert.deepEqual(hintAt(category("empty"), 50, 63, ROWS, BOX), { kind: "category", before: "fun" });
});

test("c1_1: a category over the no-category group drops first, and past the last group drops last", () => {
  assert.deepEqual(hintAt(category("empty"), 50, 30, ROWS, BOX), { kind: "category", before: "fun" });
  assert.deepEqual(hintAt(category("fun"), 50, 300, ROWS, BOX), { kind: "category", before: null });
  const loose = ROWS.filter((r) => r.kind === "group" && r.category === null);
  assert.deepEqual(hintAt(category("fun"), 50, 30, loose, BOX), { kind: "category", before: null });
});

test("c1_2: a release before the pointer moves 4 px gives no drop and stays a click", () => {
  const pressed = press("channel", "games", 10, 10);
  assert.equal(pressed.phase, "pressed");
  const nudged = advance(pressed, 13, 10);
  assert.equal(nudged.phase, "pressed");
  assert.equal(finish(nudged, before("music")), null);
  assert.equal(advance(pressed, 12, 13).phase, "pressed");
  assert.equal(advance(pressed, 14, 10).phase, "dragging");
  assert.equal(advance(pressed, 10, 6).phase, "dragging");
});

test("c1_2: a release with no hint gives no drop", () => {
  const moving = advance(press("category", "fun", 0, 0), 40, 40);
  assert.equal(moving.phase, "dragging");
  assert.equal(finish(moving, null), null);
});

test("c1_2: a release during a drag with a hint gives that hint", () => {
  const moving = advance(press("channel", "games", 0, 0), 40, 40);
  const hint = before("music");
  assert.deepEqual(finish(moving, hint), hint);
  const back = advance(moving, 1, 1);
  assert.equal(back.phase, "dragging");
  assert.deepEqual(finish(back, into("fun")), into("fun"));
  assert.equal(moving.kind, "channel");
  assert.equal(moving.id, "games");
});
