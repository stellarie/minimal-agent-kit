import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

export interface AuditEntry {
  at: string;
  agent: string;
  tool: string;
  summary: string;
  // The verdict of the rules, before any tool mode.
  verdict: "allow" | "ask" | "block";
  outcome: "allowed" | "denied" | "blocked" | "timeout" | "auto-allowed";
  reason: string;
  // True for an askable block.
  danger?: boolean;
  // "rules", "plugin:{id}", "mode", or "classifier".
  source: string;
}

const KEEP = 500;
const MAX_BYTES = 1024 * 1024;
const MAX_SUMMARY = 500;

// Every ask, block, and mode decision, newest last on disk.
export class Audit {
  #file: string;
  #recent: AuditEntry[] = [];
  #listeners = new Set<(entry: AuditEntry) => void>();

  constructor(home: string) {
    const dir = join(home, "guard");
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, "audit.jsonl");
    this.#recent = this.#load();
  }

  add(entry: AuditEntry): void {
    const line: AuditEntry = { ...entry, summary: entry.summary.slice(0, MAX_SUMMARY) };
    this.#recent.push(line);
    if (this.#recent.length > KEEP) this.#recent.splice(0, this.#recent.length - KEEP);
    try {
      if (existsSync(this.#file) && statSync(this.#file).size > MAX_BYTES) {
        renameSync(this.#file, `${this.#file}.1`);
      }
      appendFileSync(this.#file, JSON.stringify(line) + "\n");
    } catch (err) {
      console.error("guard audit write failed:", (err as Error).message);
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(line);
      } catch (err) {
        console.error("guard audit listener failed:", err);
      }
    }
  }

  onAdd(listener: (entry: AuditEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // Newest first.
  recent(n = 200): AuditEntry[] {
    return this.#recent.slice(-n).reverse();
  }

  #load(): AuditEntry[] {
    if (!existsSync(this.#file)) return [];
    try {
      const lines = readFileSync(this.#file, "utf8").split("\n").filter(Boolean).slice(-KEEP);
      const out: AuditEntry[] = [];
      for (const line of lines) {
        try {
          out.push(JSON.parse(line) as AuditEntry);
        } catch {
          // Skip a torn line.
        }
      }
      return out;
    } catch (err) {
      console.error("guard audit read failed:", (err as Error).message);
      return [];
    }
  }
}
