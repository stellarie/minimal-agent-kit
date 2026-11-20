import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_FILE } from "../src/adapters/runtimes.ts";
import { claudeIsolationArgs, isolationSettings } from "../../plugins/claude-code/isolate.ts";
import { tempHome } from "./helpers.ts";

const enabled = process.env.LOUNGE_SMOKE_CLAUDE === "1";

interface Init {
  skills?: string[];
  slash_commands?: string[];
  mcp_servers?: unknown[];
  plugins?: { path: string }[];
}

// Real claude CLI; opt in with LOUNGE_SMOKE_CLAUDE=1. One short haiku call.
test(
  "SC19: a user skill in ~/.claude/skills is not visible in a lounge turn",
  { skip: enabled ? false : "set LOUNGE_SMOKE_CLAUDE=1 to run", timeout: 180_000 },
  (t) => {
    const home = tempHome();
    t.after(() => home.cleanup());
    const dir = mkdtempSync(join(home.dir, "sc19-"));
    const work = join(dir, "work");
    mkdirSync(work);
    const mcpPath = join(dir, "mcp.json");
    const settingsPath = join(dir, "settings.json");
    writeFileSync(mcpPath, JSON.stringify({ mcpServers: {} }));
    writeFileSync(settingsPath, JSON.stringify(isolationSettings(HOOK_FILE)));
    const iso = claudeIsolationArgs({ mcpPath, settingsPath });
    const run = spawnSync("claude", [...iso.args, "--output-format", "stream-json", "--verbose", "--model", "haiku"], {
      cwd: work,
      input: "Reply with the single word ok.",
      encoding: "utf8",
      env: { ...process.env, ...iso.env },
      timeout: 150_000,
    });
    const events = run.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; subtype?: string; is_error?: boolean; result?: string } & Init);
    const init = events.find((e) => e.type === "system" && e.subtype === "init");
    assert.ok(init, run.stderr);
    // The user has skills, plugins, and slash commands. None reaches the turn.
    assert.deepEqual(init.skills, []);
    assert.deepEqual(init.slash_commands, []);
    assert.deepEqual(init.mcp_servers, []);
    assert.ok((init.plugins ?? []).every((p) => p.path === "builtin"), JSON.stringify(init.plugins));
    // OAuth still works: the turn answers.
    const result = events.find((e) => e.type === "result");
    assert.equal(result?.is_error, false);
  },
);
