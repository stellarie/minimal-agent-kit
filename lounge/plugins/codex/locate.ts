import { readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { findCodex } from "../../core/src/api/codex-login.ts";

export const CODEX_NOT_FOUND = "codex not found";

// Only the real binary: a .cmd shim would need a shell, and hook values hold ^ and ".
function onPath(env: NodeJS.ProcessEnv): string | undefined {
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const path = env.PATH ?? env.Path ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try {
      const hit = readdirSync(dir).find((f) => f.toLowerCase() === name);
      if (hit) return join(dir, hit);
    } catch {
      // A PATH folder that does not exist.
    }
  }
  return undefined;
}

// codex on the PATH, else the newest app install, else an error.
// A command with a path, or any other name, stays as it is.
export function locateCodex(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!/^codex(\.exe)?$/i.test(command)) return command;
  const found = onPath(env) ?? findCodex(command, env);
  if (found === command) throw new Error(CODEX_NOT_FOUND);
  return found;
}
