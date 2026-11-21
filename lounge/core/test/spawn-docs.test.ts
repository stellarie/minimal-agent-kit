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

test("c10_1: architecture.md and the lounge-workflow skill say the same", () => {
  for (const file of ["docs/architecture.md", "skills/lounge-workflow/SKILL.md"]) {
    assert.match(readFileSync(resolve(LOUNGE, file), "utf8"), RULE, file);
  }
});
