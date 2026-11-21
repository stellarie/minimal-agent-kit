import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { bannerFor, type UpdateState } from "./update.ts";

const SRC = resolve(import.meta.dirname, "..");
const source = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

const state = (patch: Partial<UpdateState>): UpdateState => ({ state: "none", current: "0.9.0", ...patch });

test("c7_1: available state shows Download", () => {
  assert.deepEqual(bannerFor(state({ state: "available", version: "0.10.0" })), {
    text: "Update 0.10.0 available",
    action: "download",
    label: "Download",
  });
});

test("c7_1: downloading state shows progress and no button", () => {
  assert.deepEqual(bannerFor(state({ state: "downloading", version: "0.10.0" })), {
    text: "Downloading update 0.10.0",
    action: null,
    label: null,
  });
});

test("c7_1: ready state shows Restart to update", () => {
  assert.deepEqual(bannerFor(state({ state: "ready", version: "0.10.0" })), {
    text: "Update 0.10.0 is ready",
    action: "apply",
    label: "Restart to update",
  });
});

test("c7_1: none, off, and error states show no action", () => {
  assert.equal(bannerFor(state({ state: "none" })), null);
  assert.equal(bannerFor(state({ state: "off" })), null);
  assert.equal(bannerFor(null), null);
  assert.deepEqual(bannerFor(state({ state: "error", reason: "http 403" })), {
    text: "Update failed: http 403",
    action: null,
    label: null,
  });
});

test("c7_2: the banner calls the api only from its button click", () => {
  const banner = source("components/UpdateBanner.svelte");
  assert.equal(banner.match(/onclick=/g)?.length, 1);
  assert.doesNotMatch(banner, /\$effect|onMount|fetch\(|client/);
  const app = source("App.svelte");
  for (const call of ["client.downloadUpdate(", "client.applyUpdate("]) {
    assert.equal(app.split(call).length - 1, 1, call);
  }
  assert.equal(app.match(/<UpdateBanner[^>]*onAction=\{updateAction\}/g)?.length, 1);
  assert.match(app, /async function updateAction\(action: "download" \| "apply"\)/);
});
