import type { DatabaseSync } from "node:sqlite";
import { readSetting, writeSetting } from "../db/settings.ts";
import type { Roster } from "./roster.ts";

// One setting per row: a row applies at most once.
export const PLUGINS_MARK = "migrated.plugins-enabled";

// Runtimes that live in plugins with the same id.
const PLUGIN_RUNTIMES: readonly string[] = ["claude-code", "codex"];

export interface MigrateDeps {
  db: DatabaseSync;
  roster: Pick<Roster, "active">;
  // Writes the setting only. The plugins load later.
  enablePlugins(ids: string[]): void;
  log(line: string): void;
}

function inTransaction(db: DatabaseSync, change: () => void): void {
  db.exec("BEGIN");
  try {
    change();
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// A runtime that moved into a plugin needs that plugin.
function enableUsedPlugins(deps: MigrateDeps): void {
  if (readSetting(deps.db, PLUGINS_MARK) !== undefined) return;
  const used = new Set<string>();
  for (const entry of deps.roster.active()) {
    if (PLUGIN_RUNTIMES.includes(entry.runtime)) used.add(entry.runtime);
  }
  inTransaction(deps.db, () => {
    if (used.size > 0) deps.enablePlugins([...used].sort());
    writeSetting(deps.db, PLUGINS_MARK, "1");
  });
  if (used.size > 0) deps.log(`migration: enabled plugins ${[...used].sort().join(", ")}`);
}

// A failed row leaves its setting unwritten and the start goes on.
export function migrateRuntimes(deps: MigrateDeps): void {
  for (const row of [enableUsedPlugins]) {
    try {
      row(deps);
    } catch (err) {
      deps.log(`migration failed: ${(err as Error).message}`);
    }
  }
}
