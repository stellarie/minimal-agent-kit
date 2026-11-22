import type { DatabaseSync } from "node:sqlite";
import { readSetting, writeSetting } from "../db/settings.ts";

export type GuardMode = "normal" | "auto" | "bypass";
export const GUARD_MODES: readonly GuardMode[] = ["normal", "auto", "bypass"];
export const GUARD_MODE_KEY = "guard.mode";

export function isGuardMode(value: unknown): value is GuardMode {
  return typeof value === "string" && (GUARD_MODES as readonly string[]).includes(value);
}

// One mode for the whole lounge. Auto is saved. Bypass lives in this process only.
export class GuardModeStore {
  #db: DatabaseSync;
  #live: GuardMode;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#live = readSetting(db, GUARD_MODE_KEY) === "auto" ? "auto" : "normal";
  }

  get(): GuardMode {
    return this.#live;
  }

  set(mode: GuardMode): void {
    if (!isGuardMode(mode)) throw new Error(`unknown guard mode: ${String(mode)}`);
    writeSetting(this.#db, GUARD_MODE_KEY, mode === "auto" ? "auto" : "normal");
    this.#live = mode;
  }
}
