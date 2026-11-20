import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

// Resolve the target and require it to sit strictly inside {home}/tmp.
function insideTmp(home: string, target: string): string {
  const tmp = resolve(join(home, "tmp"));
  const full = resolve(target);
  if (!full.startsWith(tmp + sep)) {
    throw new Error(`refusing to delete outside ${tmp}: ${full}`);
  }
  return full;
}

function removeInsideTmp(home: string, target: string): void {
  try {
    rmSync(insideTmp(home, target), { recursive: true, force: false });
  } catch (err) {
    console.error(`failed to delete ${target}:`, err);
  }
}

// A crashed turn leaves its folder behind: empty {home}/tmp at start-up.
export function sweepTurnFolders(home: string): void {
  const tmp = resolve(join(home, "tmp"));
  if (!existsSync(tmp)) return;
  // A linked tmp would point the sweep elsewhere.
  if (lstatSync(tmp).isSymbolicLink()) {
    console.error(`refusing to sweep ${tmp}: it is a link`);
    return;
  }
  for (const entry of readdirSync(tmp)) {
    removeInsideTmp(home, join(tmp, entry));
  }
}
