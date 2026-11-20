import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const UI = resolve(import.meta.dirname, "..", "..");

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

// Text files only; fonts, images, and other binaries are skipped.
const TEXT = new Set([".ts", ".svelte", ".css", ".html", ".json", ".svg", ".js"]);
const SELF = basename(import.meta.filename);

function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

// Returns "file:line: word" for each persona word found in the given paths.
export function scanPersona(paths: string[], root: string = UI): string[] {
  const hits: string[] = [];
  for (const file of paths.flatMap(filesUnder)) {
    if (basename(file) === SELF || !TEXT.has(extname(file).toLowerCase())) continue;
    const where = relative(root, file).replaceAll("\\", "/");
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        const lower = line.toLowerCase();
        for (const name of BANNED) {
          if (lower.includes(name)) hits.push(`${where}:${i + 1}: ${name}`);
        }
        if (REAL_NAME.test(line)) hits.push(`${where}:${i + 1}: real name`);
      });
  }
  return hits;
}

test("c3_1: no persona word in lounge/ui/src or index.html", () => {
  assert.deepEqual(scanPersona([join(UI, "src"), join(UI, "index.html")]), []);
});
