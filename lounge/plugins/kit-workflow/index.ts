import { execFileSync } from "node:child_process";

export default function setup(): void {
  for (const [cmd, ...args] of [["python3"], ["python"], ["py", "-3"]]) {
    try {
      if (/^Python 3\./.test(execFileSync(cmd!, [...args, "--version"], { timeout: 5_000, windowsHide: true }).toString())) return;
    } catch {
      // Missing, or a store stub: try the next.
    }
  }
  throw new Error("kit workflow needs Python 3 on the PATH");
}
