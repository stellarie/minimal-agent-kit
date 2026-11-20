import { test } from "node:test";
import assert from "node:assert/strict";
import { RestrictedTokens } from "../src/auth/restricted.ts";
import { Slots } from "../src/sessions/slots.ts";
import { FakeTimers } from "./helpers.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("slots: the fourth acquire waits for a release", async () => {
  const timers = new FakeTimers();
  const slots = new Slots(3, 1000, timers);
  const releases = await Promise.all([slots.acquire(), slots.acquire(), slots.acquire()]);
  let fourth: (() => void) | undefined;
  void slots.acquire().then((release) => {
    fourth = release;
  });
  await tick();
  assert.equal(fourth, undefined);
  assert.equal(slots.waiting, 1);
  releases[0]!();
  await tick();
  assert.equal(typeof fourth, "function");
  assert.equal(slots.running, 3);
  assert.equal(timers.pending.size, 0);
});

test("slots: waiters start in FIFO order", async () => {
  const slots = new Slots(1, 1000, new FakeTimers());
  const first = await slots.acquire();
  const order: string[] = [];
  const a = slots.acquire().then((r) => (order.push("a"), r));
  const b = slots.acquire().then((r) => (order.push("b"), r));
  first();
  (await a)();
  (await b)();
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(slots.running, 0);
});

test("slots: release is idempotent", async () => {
  const slots = new Slots(1, 1000, new FakeTimers());
  const release = await slots.acquire();
  release();
  release();
  assert.equal(slots.running, 0);
  const again = await slots.acquire();
  assert.equal(slots.running, 1);
  again();
});

test("slots: a waiter past the timeout rejects with queue timeout", async () => {
  const timers = new FakeTimers();
  const slots = new Slots(1, 1000, timers);
  const held = await slots.acquire();
  const waiting = slots.acquire();
  timers.fireAll();
  await assert.rejects(waiting, /queue timeout/);
  assert.equal(slots.waiting, 0);
  held();
  assert.equal(slots.running, 0);
});

test("slots: an abort removes the waiter", async () => {
  const timers = new FakeTimers();
  const slots = new Slots(1, 1000, timers);
  const held = await slots.acquire();
  const controller = new AbortController();
  const waiting = slots.acquire(controller.signal);
  controller.abort();
  await assert.rejects(waiting, /aborted/);
  assert.equal(slots.waiting, 0);
  assert.equal(timers.pending.size, 0);
  held();
  assert.equal(slots.running, 0);
});

test("restricted tokens: mint, lookup, revoke", () => {
  const tokens = new RestrictedTokens();
  const revoked: string[] = [];
  tokens.onRevoke((token) => revoked.push(token));
  const token = tokens.mint("ada", "s1");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(tokens.lookup(token), { caller: "ada", sessionId: "s1" });
  assert.equal(tokens.lookup(undefined), null);
  assert.equal(tokens.lookup("nope"), null);
  tokens.revoke(token);
  tokens.revoke(token);
  assert.equal(tokens.lookup(token), null);
  assert.deepEqual(revoked, [token]);
});
