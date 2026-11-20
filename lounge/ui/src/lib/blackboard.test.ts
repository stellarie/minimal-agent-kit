import { test } from "node:test";
import assert from "node:assert/strict";
import { progress } from "./blackboard.ts";
import type { BoardItem } from "./api.ts";

const item = (id: string, done: boolean): BoardItem => ({ id, done, text: id, owner: "none" });

test("SC29: an empty task shows no progress", () => {
  assert.equal(progress([]), "no items");
});

test("c14_2_valid: progress counts the items that are done", () => {
  assert.equal(progress([item("W1", true), item("W2", false), item("W3", true)]), "2 of 3 done");
  assert.equal(progress([item("W1", false)]), "0 of 1 done");
});
