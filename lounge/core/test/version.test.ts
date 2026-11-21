import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coreVersion } from "../src/version.ts";

test("c1_2: coreVersion reads lounge/core/package.json", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
  assert.equal(coreVersion(), manifest.version);
});
