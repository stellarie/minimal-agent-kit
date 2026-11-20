import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loungeHome } from "../src/config.ts";

const MAIN = resolve(import.meta.dirname, "..", "src", "main.ts");
const DROPPED = ["memory_days", "summaries", "external_links", "bookshelf_fts", "bookshelf_files"];

test("SC4: the home is AGENT_LOUNGE_HOME, else the .agent-lounge folder of the user profile", () => {
  assert.equal(loungeHome({ AGENT_LOUNGE_HOME: "X:\\lounge-here" }), "X:\\lounge-here");
  assert.equal(loungeHome({}), join(homedir(), ".agent-lounge"));
  assert.equal(loungeHome({ AGENT_LOUNGE_HOME: "" }), join(homedir(), ".agent-lounge"));
});

test("SC4: a fresh AGENT_LOUNGE_HOME gives a DB with agents and no dropped table", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agent-lounge-sc4-"));
  // Port 0 lets the OS pick a free port.
  writeFileSync(join(home, "config.json"), JSON.stringify({ port: 0 }));

  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, AGENT_LOUNGE_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let db: DatabaseSync | undefined;
  // One hook, in order: close the database, stop the core, remove the home.
  t.after(async () => {
    db?.close();
    if (child.exitCode === null) child.kill();
    await exited;
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const listening = await new Promise<string>((done, fail) => {
    let out = "";
    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (err += d));
    child.stdout.setEncoding("utf8");
    // The two startup lines arrive in separate writes, so wait for both.
    child.stdout.on("data", (d: string) => {
      out += d;
      if (/listening on http:\/\/127\.0\.0\.1:\d+/.test(out) && out.includes("tokens file:")) done(out);
    });
    void exited.then(() => fail(new Error(`core exited before it listened: ${err}`)));
  });
  assert.ok(listening.includes(join(home, "tokens.json")));
  assert.equal(existsSync(join(home, "lounge.db")), true);

  db = new DatabaseSync(join(home, "lounge.db"), { readOnly: true });
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  assert.ok(tables.includes("agents"), `tables: ${tables.join(", ")}`);
  assert.deepEqual(tables.filter((n) => DROPPED.some((d) => n === d || n.startsWith(`${d}_`))), []);
  assert.deepEqual(tables.filter((n) => n.endsWith("outos")), []);
  const seeded = db.prepare("SELECT id FROM agents ORDER BY position").all() as { id: string }[];
  assert.ok(seeded.length > 0, "the first start seeds the roster");
});
