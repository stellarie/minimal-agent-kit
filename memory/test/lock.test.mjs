import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { withLock } from "../src/fsutil.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amem-l-"));
}

function deadPid() {
  return spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  }).stdout;
}

function plantLock(lockDir, pid, ageMs = 0) {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: Number(pid), token: "old" }));
  if (ageMs) {
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(lockDir, t, t);
  }
}

test("a lock held by a live process is never broken, however old", () => {
  const lockDir = path.join(tempRoot(), ".lock");
  plantLock(lockDir, process.pid, 3_600_000);
  assert.throws(() => withLock(lockDir, () => 1, { timeoutMs: 300 }), /locked/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"))).token, "old");
});

test("a lock left by a dead process is broken", () => {
  const lockDir = path.join(tempRoot(), ".lock");
  plantLock(lockDir, deadPid());
  assert.equal(withLock(lockDir, () => 42, { timeoutMs: 2_000 }), 42);
  assert.equal(fs.existsSync(lockDir), false);
});

test("release never removes a lock that another writer owns", () => {
  const lockDir = path.join(tempRoot(), ".lock");
  withLock(lockDir, () => {
    fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, token: "other" }));
  });
  assert.equal(fs.existsSync(lockDir), true);
});

test("racing writers after a crash never overlap", async () => {
  const root = tempRoot();
  const lockDir = path.join(root, ".lock");
  const log = path.join(root, "log.txt");
  plantLock(lockDir, deadPid());
  const fsutil = new URL("../src/fsutil.mjs", import.meta.url).href;
  const script =
    `const { withLock, sleepSync } = await import(${JSON.stringify(fsutil)});` +
    `const fs = await import("node:fs");` +
    `for (let i = 0; i < 10; i++) withLock(${JSON.stringify(lockDir)}, () => {` +
    `fs.appendFileSync(${JSON.stringify(log)}, "in " + process.pid + "\\n");` +
    `sleepSync(3);` +
    `fs.appendFileSync(${JSON.stringify(log)}, "out " + process.pid + "\\n"); });`;
  const runs = Array.from({ length: 8 }, () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script]);
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, err }));
    }),
  );
  for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.err);
  const lines = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 160);
  for (let i = 0; i < lines.length; i += 2) {
    const [a, pa] = lines[i].split(" ");
    const [b, pb] = lines[i + 1].split(" ");
    assert.deepEqual([a, b, pa], ["in", "out", pb], `overlap at line ${i + 1}`);
  }
});
