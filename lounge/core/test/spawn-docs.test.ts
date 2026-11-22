import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import spawnTool from "../src/mcp/tools/lounge_spawn.ts";

const LOUNGE = resolve(import.meta.dirname, "..", "..");
const RULE = /end your turn.*(do not|never) poll/is;

test("c10_1: the lounge_spawn description says to end the turn and not to poll", () => {
  assert.match(spawnTool.description, RULE);
});

test("c10_1: architecture.md says to end the turn and not to poll", () => {
  assert.match(readFileSync(resolve(LOUNGE, "docs/architecture.md"), "utf8"), RULE);
});
