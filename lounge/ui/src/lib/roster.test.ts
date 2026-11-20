import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ID_PATTERN, OWNER_TAPE, RESERVED_IDS, TAPE_SLOTS, capitalize, tapeVar, validId } from "./roster.ts";
import { displayName } from "./format.ts";

// The ids of lounge/core/test/roster.test.ts.
const BAD = ["owner", "constructor", "prototype", "__proto__", "Nana", "n", "a b", "../x", "a".repeat(25), "1nana", ""];
const GOOD = ["nana", "na", "a".repeat(24), "nana-b", "n2", "mika-3"];

test("validId rejects the ids the core rejects", () => {
  for (const id of BAD) assert.equal(validId(id), false, JSON.stringify(id));
});

test("validId accepts the ids the core accepts", () => {
  for (const id of GOOD) assert.equal(validId(id), true, id);
});

// The core rule, read from its source file.
function coreRule(): RegExp {
  const file = new URL("../../../core/src/roster/types.ts", import.meta.url);
  const match = /export const ID_PATTERN = \/(.+)\/;/.exec(readFileSync(file, "utf8"));
  assert.ok(match, "core ID_PATTERN not found");
  return new RegExp(match[1]!);
}

// The reserved ids, read from the core source file.
function coreReserved(): string[] {
  const file = new URL("../../../core/src/roster/types.ts", import.meta.url);
  const match = /export const RESERVED_IDS[^=]*= \[(.+)\];/.exec(readFileSync(file, "utf8"));
  assert.ok(match, "core RESERVED_IDS not found");
  return match[1]!.split(",").map((part) => part.trim().replace(/"/g, ""));
}

test("validId agrees with the core pattern on every sample id", () => {
  const core = coreRule();
  assert.equal(ID_PATTERN.source, core.source);
  for (const id of [...BAD, ...GOOD]) {
    assert.equal(validId(id), core.test(id) && !coreReserved().includes(id), JSON.stringify(id));
  }
  assert.deepEqual([...RESERVED_IDS], coreReserved());
});

test("tapeVar names the label color of the slot", () => {
  for (const slot of TAPE_SLOTS) assert.equal(tapeVar({ tape: slot }), `var(--tape-${slot})`);
});

test("tapeVar falls back to label 1 for a slot outside 1 to 4", () => {
  for (const tape of [0, 5, -1, 2.5, Number.NaN]) assert.equal(tapeVar({ tape }), "var(--tape-1)");
});

test("the owner has the highlight color, not a label slot", () => {
  assert.equal(OWNER_TAPE, "var(--pink-soft)");
});

test("a display name is the capitalized id", () => {
  assert.equal(capitalize("nana"), "Nana");
  assert.equal(displayName("nana-b"), "Nana-b");
  assert.equal(displayName("owner"), "Owner");
});
