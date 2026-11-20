import { test } from "node:test";
import assert from "node:assert/strict";
import { takeFragmentToken } from "./token.ts";

interface FakeLocation {
  href: string;
  hash: string;
  pathname: string;
  search: string;
}

interface FakeHistory {
  calls: { data: unknown; title: string; url?: string }[];
  replaceState(data: unknown, title: string, url?: string): void;
}

function fakeLocation(href: string): FakeLocation {
  const url = new URL(href);
  return { href, hash: url.hash, pathname: url.pathname, search: url.search };
}

function fakeHistory(): FakeHistory {
  const calls: FakeHistory["calls"] = [];
  return {
    calls,
    replaceState(data, title, url) {
      calls.push({ data, title, url });
    },
  };
}

test("takeFragmentToken reads the token from the fragment", () => {
  const loc = fakeLocation("http://127.0.0.1:47621/#token=abc");
  const hist = fakeHistory();
  assert.equal(takeFragmentToken(loc as unknown as Location, hist as unknown as History), "abc");
  assert.equal(hist.calls.length, 1);
  assert.deepEqual(hist.calls[0], { data: null, title: "", url: "/" });
});

test("takeFragmentToken keeps the path and the query when it clears the hash", () => {
  const loc = fakeLocation("http://127.0.0.1:47621/lounge?room=x#token=secret");
  const hist = fakeHistory();
  assert.equal(takeFragmentToken(loc as unknown as Location, hist as unknown as History), "secret");
  assert.equal(hist.calls[0].url, "/lounge?room=x");
});

test("takeFragmentToken returns null and leaves history alone without a token", () => {
  const loc = fakeLocation("http://127.0.0.1:47621/#/lounge");
  const hist = fakeHistory();
  assert.equal(takeFragmentToken(loc as unknown as Location, hist as unknown as History), null);
  assert.equal(hist.calls.length, 0);
});

test("takeFragmentToken returns null for an empty token", () => {
  const loc = fakeLocation("http://127.0.0.1:47621/#token=");
  const hist = fakeHistory();
  assert.equal(takeFragmentToken(loc as unknown as Location, hist as unknown as History), null);
  assert.equal(hist.calls.length, 0);
});
