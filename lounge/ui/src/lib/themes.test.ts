import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COLOR_KEYS,
  HIGH_CONTRAST,
  MIN_CONTRAST,
  MIN_HIGH_CONTRAST,
  PAIRS,
  PATTERNS,
  SAMPLES,
  contrastRatio,
  exportThemes,
  importThemes,
  lowContrast,
  minContrast,
  newThemeId,
  parseCustom,
  themeVars,
  type Theme,
} from "./themes.ts";
import { DEFAULT_FONT, FONTS, fontById, fontStack } from "./fonts.ts";

const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

// The custom properties of the first block that follows the marker.
function block(marker: string): Record<string, string> {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `theme.css has ${marker}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function theme(id: string): Theme {
  const found = SAMPLES.find((t) => t.id === id);
  assert.ok(found, `theme ${id} exists`);
  return found;
}

test("C3_2 the theme list is Ledger first, then six more", () => {
  assert.deepEqual(
    SAMPLES.map((t) => t.name),
    ["Ledger", "Ledger Night", "Blueprint", "Harbor", "Terracotta", "Graphite", "High contrast"],
  );
  assert.deepEqual(
    SAMPLES.map((t) => t.id),
    ["ledger", "ledger-night", "blueprint", "harbor", "terracotta", "graphite", "high-contrast"],
  );
  assert.equal(SAMPLES[0].dark, false);
  assert.equal(SAMPLES[1].dark, true);
});

test("C3_2 each theme sets one pattern, and all five patterns are in use", () => {
  assert.deepEqual([...PATTERNS], ["rules", "grid", "contour", "dots", "none"]);
  for (const t of SAMPLES) assert.ok(PATTERNS.includes(t.pattern), `${t.id}: ${t.pattern}`);
  assert.deepEqual(new Set(SAMPLES.map((t) => t.pattern)), new Set(PATTERNS));
});

test("C3_2 every PAIRS row reaches 4.5:1, and High contrast reaches 7:1", () => {
  assert.equal(MIN_CONTRAST, 4.5);
  assert.equal(MIN_HIGH_CONTRAST, 7);
  assert.equal(HIGH_CONTRAST, "high-contrast");
  for (const t of SAMPLES) {
    const floor = t.id === HIGH_CONTRAST ? 7 : 4.5;
    assert.equal(minContrast(t), floor, t.id);
    for (const [text, surface, label] of PAIRS) {
      const ratio = contrastRatio(t.colors[text], t.colors[surface]);
      assert.ok(ratio >= floor, `${t.id}: ${label} is ${ratio.toFixed(2)}, needs ${floor}`);
    }
    assert.deepEqual(lowContrast(t), [], t.id);
  }
});

test("C3_2 PAIRS names every text and surface pair the UI draws", () => {
  const labels = PAIRS.map((p) => p[2]);
  assert.equal(new Set(labels).size, labels.length);
  for (const n of [1, 2, 3, 4]) assert.ok(PAIRS.some((p) => p[0] === "ink" && p[1] === `tape-${n}`), `tape-${n}`);
  // Borders are not text: the line color is the only key with no pair.
  for (const key of COLOR_KEYS.filter((k) => k !== "line")) {
    assert.ok(PAIRS.some((p) => p[0] === key || p[1] === key), `${key} is in a pair`);
  }
});

test("C3_2 the base CSS has 6px radii and no notch", () => {
  const root = block(":root {");
  for (const name of ["--r-sm", "--r", "--r-lg"]) assert.equal(root[name], "6px", name);
  assert.ok(!/corner-shape/.test(css), "no corner-shape");
  for (const m of css.matchAll(/--r(?:-sm|-lg)?:\s*([^;]+);/g)) assert.equal(m[1].trim(), "6px");
});

test("C3_2 the CSS colors are Ledger, and Ledger Night under a dark system", () => {
  const light = block(":root {");
  const dark = block(':root:not([data-theme="light"])');
  const forced = block(':root[data-theme="dark"]');
  for (const [vars, id] of [[light, "ledger"], [dark, "ledger-night"], [forced, "ledger-night"]] as const) {
    const want = themeVars(theme(id));
    for (const key of COLOR_KEYS) assert.equal(vars[`--${key}`], theme(id).colors[key], `${id} ${key}`);
    assert.equal(vars["--shadow"], want["--shadow"], `${id} shadow`);
    assert.equal(vars["--pattern"], want["--pattern"], `${id} pattern`);
  }
});

test("C3_2 the default font is IBM Plex Sans with Plex Mono, bundled", () => {
  assert.equal(DEFAULT_FONT, "ibm-plex-sans");
  assert.equal(fontById(null).family, "IBM Plex Sans");
  assert.equal(FONTS[0].id, DEFAULT_FONT);
  assert.match(fontStack(fontById(null)), /^"IBM Plex Sans"/);
  const root = block(":root {");
  assert.match(root["--font"], /^"IBM Plex Sans"/);
  assert.match(root["--font-mono"], /^"IBM Plex Mono"/);
  assert.match(main, /@fontsource\/ibm-plex-sans\//);
  assert.match(main, /@fontsource\/ibm-plex-mono\//);
  // The only URL is the SVG namespace inside a data URI.
  for (const text of [css, main, page]) assert.ok(!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(text), "no network URL");
});

test("every sample sets every color as hex", () => {
  for (const t of SAMPLES) {
    for (const key of COLOR_KEYS) assert.match(t.colors[key], /^#[0-9a-f]{6}$/i, `${t.id} ${key}`);
  }
  assert.equal(new Set(SAMPLES.map((t) => t.id)).size, SAMPLES.length);
});

test("parseCustom keeps valid themes and drops the rest", () => {
  const good = { id: "custom-1", name: "Mine", dark: true, pattern: "grid", colors: SAMPLES[0].colors };
  const odd = { id: "custom-3", name: "Odd", pattern: "hearts", colors: SAMPLES[0].colors };
  const bad = { id: "custom-2", name: "Bad", colors: { ...SAMPLES[0].colors, bg: "red; x" } };
  const parsed = parseCustom(JSON.stringify([good, odd, bad, null, 5]));
  assert.deepEqual(parsed, [
    { ...good, custom: true },
    { id: "custom-3", name: "Odd", dark: false, pattern: "none", colors: SAMPLES[0].colors, custom: true },
  ]);
  assert.deepEqual(parseCustom("{"), []);
  assert.deepEqual(parseCustom(null), []);
});

test("newThemeId skips taken ids", () => {
  const taken = [{ ...SAMPLES[0], id: "custom-2" }];
  assert.equal(newThemeId(taken), "custom-3");
  assert.equal(newThemeId([]), "custom-1");
});

test("contrastRatio matches the WCAG reference values", () => {
  assert.equal(contrastRatio("#000000", "#ffffff"), 21);
  assert.equal(contrastRatio("#ffffff", "#000000"), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
  // #767676 on white is the classic 4.54:1 pass.
  assert.ok(Math.abs(contrastRatio("#767676", "#ffffff") - 4.54) < 0.01);
});

test("lowContrast names the pair that fails", () => {
  const worse = { ...SAMPLES[0], colors: { ...SAMPLES[0].colors, ink: "#eeeeee" } };
  const low = lowContrast(worse);
  assert.ok(low.some((x) => x.label === "Text on background" && x.ratio < 4.5));
  assert.deepEqual(lowContrast(SAMPLES[1]).filter((x) => x.label === "Text on panels"), []);
});

test("a custom theme gets the 4.5:1 floor, even with the id of High contrast", () => {
  const custom = { ...theme("graphite"), custom: true as const };
  assert.equal(minContrast(custom), 4.5);
  assert.equal(minContrast({ ...theme("high-contrast"), custom: true }), 4.5);
});

test("themeVars sets colors, shadow, and the pattern", () => {
  const vars = themeVars(theme("harbor"));
  assert.equal(vars["--pink"], theme("harbor").colors.pink);
  assert.match(vars["--shadow"], /^0 1px 2px /);
  assert.match(vars["--pattern"], /^url\("data:image\/svg\+xml,/);
  assert.equal(themeVars(theme("graphite"))["--pattern"], "none");
  assert.equal(Object.keys(vars).length, COLOR_KEYS.length + 2);
});

function sample(id: string, over: Partial<Theme> = {}): Theme {
  return { id, name: `Theme ${id}`, dark: false, pattern: "grid", colors: SAMPLES[0].colors, custom: true, ...over };
}

test("c11_1: one theme object imports as one custom theme", () => {
  const { custom, ...plain } = sample("mine");
  const got = importThemes(JSON.stringify(plain), []);
  assert.deepEqual(got, { ok: true, themes: [{ ...plain, custom: true }] });
});

test("c11_1: an array imports each valid theme, and a taken id gets a new one", () => {
  const saved = [sample("custom-1"), sample("custom-2")];
  const text = JSON.stringify([sample("custom-1", { name: "Clash" }), { id: "x", name: "Bad" }, sample("ledger", { name: "Sample id" })]);
  const got = importThemes(text, saved);
  assert.ok(got.ok);
  assert.deepEqual(got.themes.map((t) => [t.id, t.name]), [
    ["custom-1", "Theme custom-1"],
    ["custom-2", "Theme custom-2"],
    ["custom-3", "Clash"],
    ["custom-4", "Sample id"],
  ]);
});

test("c11_1: invalid JSON gives an error and no change", () => {
  const got = importThemes("{ nope", [sample("a")]);
  assert.deepEqual(got, { ok: false, error: "The text is not JSON." });
});

test("c11_1: input with no valid theme gives an error", () => {
  assert.deepEqual(importThemes("[]", []), { ok: false, error: "No valid theme in the text." });
  assert.deepEqual(importThemes('{"id":"a","name":"x","colors":{}}', []), { ok: false, error: "No valid theme in the text." });
  assert.deepEqual(importThemes("5", []), { ok: false, error: "No valid theme in the text." });
});

test("c11_1: an import past 30 themes gives an error and no change", () => {
  const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => sample(`t${from + i}`));
  const error = { ok: false, error: "At most 30 custom themes." };
  assert.deepEqual(importThemes(JSON.stringify(many(2)), many(29, 100)), error);
  assert.deepEqual(importThemes(JSON.stringify(many(31)), []), error);
  const fits = importThemes(JSON.stringify(many(1)), many(29, 100));
  assert.ok(fits.ok && fits.themes.length === 30);
});

test("c11_2: exportThemes gives JSON without the custom flag that importThemes reads back", () => {
  const saved = [sample("a"), sample("b", { dark: true })];
  const text = exportThemes(saved);
  assert.ok(!text.includes("custom"));
  assert.deepEqual(JSON.parse(text).map((t: Theme) => t.id), ["a", "b"]);
  const back = importThemes(text, []);
  assert.deepEqual(back, { ok: true, themes: saved });
});
