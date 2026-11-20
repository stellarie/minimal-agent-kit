import { spawn } from "node:child_process";
import { join } from "node:path";
import { HttpError } from "../api/http-error.ts";

type Run = typeof spawn;

// Shows one file in its folder, selected.
export function revealDefault(platform: string = process.platform, run: Run = spawn): (path: string) => Promise<void> {
  return (path) => {
    if (platform !== "win32") {
      return Promise.reject(new HttpError(501, "unsupported", "reveal needs Windows"));
    }
    return new Promise<void>((resolve, reject) => {
      // A Windows path holds no quote, so one quoted argument is safe.
      // A bare name could start a planted explorer.exe.
      const explorer = join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
      const child = run(explorer, [`/select,"${path}"`], {
        shell: false,
        windowsVerbatimArguments: true,
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      // Explorer exits with 1 on success, so read no exit code.
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  };
}
