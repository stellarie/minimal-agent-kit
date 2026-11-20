import assert from "node:assert/strict";
import { test } from "node:test";
import type { Layout, LayoutBody } from "./api.ts";
import { applyBody, moveCategory, moveChannel, sameBody, stepCategory, stepChannel, toBody } from "./layout.ts";

// lounge, games | Fun: art, music | Empty: none
const base: Layout = {
  categories: [
    { id: "fun", name: "Fun" },
    { id: "empty", name: "Empty" },
  ],
  channels: [
    { id: "lounge", name: "lounge", topic: "" },
    { id: "games", name: "games", topic: "" },
    { id: "art", name: "art", topic: "", category: "fun" },
    { id: "music", name: "music", topic: "", category: "fun" },
    { id: "thread-1", name: "t", topic: "", parent: "games" },
  ],
};

const show = (b: LayoutBody) => b.channels.map((c) => `${c.category ?? "-"}/${c.id}`).join(" ");

test("a channel moves before another, across groups", () => {
  assert.equal(show(moveChannel(base, "lounge", { kind: "before", id: "music" })), "-/games fun/art fun/lounge fun/music");
  assert.equal(show(moveChannel(base, "music", { kind: "before", id: "lounge" })), "-/music -/lounge -/games fun/art");
});

test("a channel moves into an empty category and out of a category", () => {
  const into = moveChannel(base, "games", { kind: "into", category: "empty" });
  assert.equal(show(into), "-/lounge fun/art fun/music empty/games");
  assert.equal(show(moveChannel(base, "art", { kind: "into", category: null })), "-/lounge -/games -/art fun/music");
});

test("a drop on itself changes nothing", () => {
  assert.ok(sameBody(moveChannel(base, "games", { kind: "before", id: "games" }), toBody(base)));
  assert.ok(sameBody(moveCategory(base, "fun", "fun"), toBody(base)));
});

test("categories reorder, and threads stay out of the body", () => {
  assert.deepEqual(moveCategory(base, "empty", "fun").categories, ["empty", "fun"]);
  assert.deepEqual(moveCategory(base, "fun", null).categories, ["empty", "fun"]);
  assert.ok(!toBody(base).channels.some((c) => c.id.startsWith("thread-")));
});

test("keyboard steps move one place and cross group edges", () => {
  assert.equal(show(stepChannel(base, "lounge", 1)), "-/games -/lounge fun/art fun/music");
  assert.equal(show(stepChannel(base, "games", 1)), "-/lounge fun/games fun/art fun/music");
  assert.equal(show(stepChannel(base, "art", -1)), "-/lounge -/games -/art fun/music");
  assert.equal(show(stepChannel(base, "music", 1)), "-/lounge -/games fun/art empty/music");
  assert.ok(sameBody(stepChannel(base, "lounge", -1), toBody(base)));
  assert.deepEqual(stepCategory(base, "fun", 1).categories, ["empty", "fun"]);
  assert.ok(sameBody(stepCategory(base, "fun", -1), toBody(base)));
});

test("applyBody gives the new layout and keeps threads", () => {
  const next = applyBody(base, moveChannel(base, "games", { kind: "into", category: "empty" }));
  assert.equal(next.channels.find((c) => c.id === "games")?.category, "empty");
  assert.ok(next.channels.some((c) => c.id === "thread-1"));
  assert.ok(sameBody(toBody(next), moveChannel(base, "games", { kind: "into", category: "empty" })));
});
