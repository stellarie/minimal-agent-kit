import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { addToken, callerForToken, ensureTokens, revokeToken } from "../src/auth/tokens.ts";
import { RestrictedTokens } from "../src/auth/restricted.ts";
import { can, type Action } from "../src/auth/permissions.ts";
import { tempHome, SEED_CALLERS } from "./helpers.ts";

test("ensureTokens creates five distinct tokens", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  assert.deepEqual(Object.keys(tokens).sort(), [...SEED_CALLERS].sort());
  const values = Object.values(tokens);
  assert.equal(new Set(values).size, 5);
  for (const value of values) {
    assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  }
  const saved = JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8"));
  assert.deepEqual(saved, tokens);
});

test("ensureTokens is stable across calls", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const first = ensureTokens(home.dir, SEED_CALLERS);
  const second = ensureTokens(home.dir, SEED_CALLERS);
  assert.deepEqual(second, first);
});

test("callerForToken maps each token to its caller", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  for (const caller of SEED_CALLERS) {
    assert.equal(callerForToken(tokens, tokens[caller]), caller);
  }
});

test("callerForToken rejects unknown, empty, and undefined", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  assert.equal(callerForToken(tokens, "not-a-token"), null);
  assert.equal(callerForToken(tokens, ""), null);
  assert.equal(callerForToken(tokens, undefined), null);
});

test("callerForToken rejects a token prefix", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  assert.equal(callerForToken(tokens, tokens.ada.slice(0, 10)), null);
  assert.equal(callerForToken(tokens, tokens.ada + "x"), null);
});

test("every caller may use the lounge actions", () => {
  const actions: Action[] = ["lounge_read", "lounge_post", "lounge_who"];
  for (const caller of SEED_CALLERS) {
    for (const action of actions) {
      assert.equal(can({ caller, restricted: false }, action), true);
      assert.equal(can({ caller, restricted: true }, action), true);
    }
  }
});

test("a restricted token may not drive sessions", () => {
  const drive: Action[] = ["session_open", "session_message", "session_close"];
  const read: Action[] = ["session_list", "session_status"];
  for (const caller of SEED_CALLERS) {
    for (const action of drive) {
      assert.equal(can({ caller, restricted: true }, action), false);
      assert.equal(can({ caller, restricted: false }, action), true);
    }
    for (const action of read) {
      assert.equal(can({ caller, restricted: true }, action), true);
    }
  }
});

test("revokeFor drops every turn token of one agent and keeps the others", () => {
  const restricted = new RestrictedTokens();
  const gone: string[] = [];
  restricted.onRevoke((token) => gone.push(token));
  const a1 = restricted.mint("nana", "s1");
  const a2 = restricted.mint("nana", "s2");
  const b = restricted.mint("mika", "s3");
  restricted.revokeFor("nana");
  assert.equal(restricted.lookup(a1), null);
  assert.equal(restricted.lookup(a2), null);
  assert.equal(restricted.lookup(b)?.caller, "mika");
  assert.deepEqual(gone.sort(), [a1, a2].sort());
  assert.equal(restricted.size, 1);
});

test("addToken and revokeToken change the shared map in place and the file", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const same = tokens;
  const token = addToken(tokens, home.dir, "nana");
  assert.equal(same["nana"], token, "the map object is the same one");
  assert.equal(callerForToken(tokens, token), "nana");
  assert.deepEqual(JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")), tokens);
  assert.equal(addToken(tokens, home.dir, "nana"), token, "an existing token stays");

  revokeToken(tokens, home.dir, "nana");
  assert.equal(callerForToken(tokens, token), null);
  assert.equal("nana" in tokens, false);
  assert.equal("nana" in JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")), false);
  assert.deepEqual(readdirSync(home.dir).filter((name) => name.endsWith(".tmp")), [], "no temp file is left");
});

test("ensureTokens keeps saved tokens, adds missing ones, and drops other ids", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const first = ensureTokens(home.dir, ["owner", "nana", "mika"]);
  const second = ensureTokens(home.dir, ["owner", "nana", "rina"]);
  assert.equal(second["nana"], first["nana"]);
  assert.equal(second["owner"], first["owner"]);
  assert.notEqual(second["rina"], undefined);
  assert.equal("mika" in second, false);
  assert.deepEqual(JSON.parse(readFileSync(join(home.dir, "tokens.json"), "utf8")), second);
});

test("a token map ignores inherited keys such as constructor", (t) => {
  const home = tempHome();
  t.after(home.cleanup);
  const tokens = ensureTokens(home.dir, SEED_CALLERS);
  const token = addToken(tokens, home.dir, "constructor");
  assert.equal(typeof token, "string", "a new token, not Object.prototype.constructor");
  assert.equal(Object.hasOwn(tokens, "constructor"), true);
  revokeToken(tokens, home.dir, "constructor");
  assert.equal(Object.hasOwn(tokens, "constructor"), false);
  // The inherited key is no caller and no saved token.
  revokeToken(tokens, home.dir, "toString");
  assert.equal(callerForToken(tokens, "x".repeat(43)), null);
  const fresh = ensureTokens(home.dir, ["owner", "constructor"]);
  assert.equal(typeof fresh["constructor"], "string");
  assert.equal(Object.hasOwn(fresh, "constructor"), true);
});
