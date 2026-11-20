import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { HOOK_FILE } from "../src/adapters/runtimes.ts";

const CORE = resolve(import.meta.dirname, "..");
const KIT = resolve(CORE, "..", "..");

// Each name is split, so this file holds none of them.
const BANNED = [
  ["chlo", "e"],
  ["sher", "ry"],
  ["yu", "u"],
  ["mo", "mo"],
  ["oniic", "han"],
  ["imou", "to"],
].map((parts) => parts.join(""));
const REAL_NAME = new RegExp(`\\b${["stel", "la"].join("")}\\b`, "i");

const SKIP = new Set(["node_modules", "dist"]);

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

const SOURCES = filesUnder(CORE).filter((f) => f.endsWith(".ts"));

test("c2_2: no persona name or old product name remains in lounge/core", () => {
  const hits: string[] = [];
  for (const file of filesUnder(CORE)) {
    const text = readFileSync(file, "utf8");
    const lower = text.toLowerCase();
    for (const name of BANNED) {
      if (lower.includes(name)) hits.push(`${relative(CORE, file)}: ${name}`);
    }
    if (REAL_NAME.test(text)) hits.push(`${relative(CORE, file)}: real name`);
    for (const name of BANNED) {
      if (relative(CORE, file).toLowerCase().includes(name)) hits.push(`${relative(CORE, file)}: path`);
    }
  }
  assert.deepEqual(hits, []);
});

test("c2_2: the roster table and its routes are named for agents", () => {
  const schema = readFileSync(join(CORE, "src", "db", "schema.sql"), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS agents \(/);
  const oldTable = ["imou", "tos"].join("");
  assert.equal(schema.includes(oldTable), false);
  const http = readFileSync(join(CORE, "src", "api", "http.ts"), "utf8");
  assert.match(http, /\/api\/agents\b/);
  assert.equal(http.includes(`/api/${oldTable}`), false);
});

test("c2_1: no dropped module file exists", () => {
  const dropped = [
    "src/personas",
    "src/api/personas.ts",
    "src/bookshelf",
    "src/memory",
    "src/native",
    "src/lounge/avatars.ts",
    "src/lounge/profiles.ts",
    "src/lounge/summaries.ts",
    "src/lounge/linkpreview.ts",
    "src/lounge/screenshot.ts",
    "src/lounge/promote.ts",
    "src/auth/external.ts",
    "src/guard/checker.ts",
  ];
  assert.deepEqual(dropped.filter((p) => existsSync(join(CORE, p))), []);
  assert.deepEqual(SOURCES.map((f) => relative(CORE, f)).filter((f) => /promote|dsh/i.test(f)), []);
});

test("c2_1: no dropped table is named in the schema or the source", () => {
  const tables = /\b(memory_days|summaries|external_links|bookshelf_fts|bookshelf_files)\b/;
  const hits = filesUnder(join(CORE, "src"))
    .filter((f) => tables.test(readFileSync(f, "utf8")))
    .map((f) => relative(CORE, f));
  assert.deepEqual([...new Set(hits)], []);
});

test("c2_1: every relative import resolves, and none reaches a dropped module", () => {
  const spec = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']*)["']/g;
  const broken: string[] = [];
  const outside = new Set<string>();
  for (const file of SOURCES) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(spec)) {
      const target = resolve(dirname(file), match[1]!);
      if (!existsSync(target)) broken.push(`${relative(CORE, file)} -> ${match[1]}`);
      // A test may import the plugins that ship with the lounge.
      const shipped = relative(CORE, file).startsWith("test") && relative(KIT, target).startsWith("lounge");
      if (relative(CORE, target).startsWith("..") && !shipped) outside.add(relative(KIT, target).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(broken, []);
  // The kit rules are the only code outside lounge/core that core imports.
  assert.deepEqual([...outside].sort(), ["core/guard/rules.js"]);
});

test("c2_1: the hook path the core hands to a runtime is the kit hook", () => {
  assert.equal(existsSync(HOOK_FILE), true, HOOK_FILE);
  assert.equal(resolve(HOOK_FILE), resolve(KIT, "core", "guard", "guard.js"));
});

test("c2_1: guard code imports judge from the kit rules, and no copy lives in lounge", () => {
  const guard = readFileSync(join(CORE, "src", "guard", "guard.ts"), "utf8");
  assert.match(guard, /import \{[^}]*\bjudge\b[^}]*\} from "(\.\.\/)+core\/guard\/rules\.js"/);
  assert.equal(filesUnder(CORE).some((f) => /[\\/]rules\.js$/.test(f)), false);
  assert.equal(existsSync(join(KIT, "lounge", "guard")), false);
});
