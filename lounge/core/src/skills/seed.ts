import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Skills } from "./skills.ts";

// lounge/skills in a checkout. A release ships the same folder beside the program.
export const BUNDLED_SKILLS = join(import.meta.dirname, "..", "..", "..", "skills");

// Copies each bundled skill folder into the skill store when that folder is absent.
// A folder the owner edited, or broke, is never touched. Returns the names it copied.
export function seedSkills(store: Pick<Skills, "root">, bundled: string = BUNDLED_SKILLS): string[] {
  if (!existsSync(bundled)) return [];
  const seeded: string[] = [];
  for (const entry of readdirSync(bundled, { withFileTypes: true })) {
    const target = join(store.root, entry.name);
    if (!entry.isDirectory() || existsSync(target)) continue;
    cpSync(join(bundled, entry.name), target, { recursive: true, errorOnExist: true });
    seeded.push(entry.name);
  }
  return seeded;
}
