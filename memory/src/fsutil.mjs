import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const LOCK_TIMEOUT_MS = 30_000;
const LOCK_ORPHAN_MS = 120_000;
const RENAME_BUDGET_MS = 5_000;
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retrying(fn) {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      // Windows refuses a rename or a delete while another handle is open.
      if (!RETRY_CODES.has(err.code) || Date.now() - started > RENAME_BUDGET_MS) throw err;
      sleepSync(Math.min(5 + attempt * 5, 100));
    }
  }
}

export function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  try {
    retrying(() => fs.renameSync(tmp, file));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function readText(file) {
  return retrying(() => fs.readFileSync(file, "utf8")).replace(/^﻿/, "");
}

export function readJson(file, fallback) {
  let text;
  try {
    text = readText(file);
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
  return JSON.parse(text);
}

function ownerFile(lockDir) {
  return path.join(lockDir, "owner.json");
}

function readOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(lockDir), "utf8"));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// A lock is stale only when its owner process is gone.
// A lock dir with no owner file is a crash between mkdir and write.
function isStale(lockDir) {
  const owner = readOwner(lockDir);
  if (owner) return !processAlive(owner.pid);
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_ORPHAN_MS;
  } catch {
    return false;
  }
}

function breakStaleLock(lockDir) {
  const judged = readOwner(lockDir);
  const tomb = `${lockDir}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockDir, tomb);
  } catch {
    return;
  }
  const taken = readOwner(tomb);
  if (judged && taken && taken.token !== judged.token) {
    // Another waiter replaced the stale lock first. Give it back.
    try {
      fs.renameSync(tomb, lockDir);
      return;
    } catch {
      // A third writer holds the lock now. The moved lock is lost.
    }
  }
  try {
    fs.rmSync(tomb, { recursive: true, force: true });
  } catch {
    // A leftover tomb is harmless.
  }
}

export function acquireLock(lockDir, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const token = crypto.randomBytes(8).toString("hex");
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile(lockDir), JSON.stringify({ pid: process.pid, token }));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (isStale(lockDir)) breakStaleLock(lockDir);
      if (Date.now() - started > timeoutMs) {
        throw new Error(`memory store is locked: ${lockDir}`);
      }
      sleepSync(15 + Math.floor(Math.random() * 25));
    }
  }
  return () => {
    if (readOwner(lockDir)?.token === token) {
      retrying(() => fs.rmSync(lockDir, { recursive: true, force: true }));
    }
  };
}

export function withLock(lockDir, fn, options) {
  const release = acquireLock(lockDir, options);
  try {
    return fn();
  } finally {
    release();
  }
}
