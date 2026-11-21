import { execFileSync } from "node:child_process";

const CHECK_MS = 5_000;
const COMMANDS: [string, string[]][] =
  process.platform === "win32" ? [["python", []], ["py", ["-3"]]] : [["python3", []], ["python", []]];

function hasPython3(): boolean {
  for (const [command, args] of COMMANDS) {
    try {
      const out = execFileSync(command, [...args, "--version"], {
        encoding: "utf8",
        timeout: CHECK_MS,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (/^Python 3\./.test(out)) return true;
    } catch {
      // This command is missing, or it is a stub that opens a store page.
    }
  }
  return false;
}

export default function setup(): void {
  if (!hasPython3()) throw new Error("kit workflow needs Python 3 on the PATH");
}
