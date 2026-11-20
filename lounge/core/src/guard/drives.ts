import { existsSync } from "node:fs";

// Every mounted drive root, for --add-dir.
export function driveRoots(exists: (p: string) => boolean = existsSync): string[] {
  if (process.platform !== "win32") return ["/"];
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (exists(root)) out.push(root);
    } catch {
      // An empty card reader throws; skip it.
    }
  }
  return out;
}
