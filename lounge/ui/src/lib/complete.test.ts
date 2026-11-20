import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ITEMS, filter, insert, trigger, type Item } from "./complete.ts";

test("trigger finds an @ query before the caret", () => {
  assert.deepEqual(trigger("hi @na", 6), { kind: "@", query: "na", start: 3 });
  assert.deepEqual(trigger("@", 1), { kind: "@", query: "", start: 0 });
  assert.deepEqual(trigger("ask @do-cs", 10), { kind: "@", query: "do-cs", start: 4 });
  assert.deepEqual(trigger("a\n@n", 4), { kind: "@", query: "n", start: 2 });
});

test("trigger reads only up to the caret", () => {
  assert.deepEqual(trigger("hi @nana there", 6), { kind: "@", query: "na", start: 3 });
  assert.equal(trigger("hi @nana there", 11), null);
});

test("trigger needs the text start or a space before it", () => {
  assert.equal(trigger("a@b", 3), null);
  assert.equal(trigger("mail me at a@b", 14), null);
  assert.equal(trigger("x#docs", 6), null);
  assert.equal(trigger("(@na", 4), null);
  assert.equal(trigger("use $docs", 9), null);
});

test("trigger needs a letter to start a query", () => {
  assert.equal(trigger("@-x", 3), null);
  assert.equal(trigger("@9a", 3), null);
  assert.deepEqual(trigger("@a5", 3), { kind: "@", query: "a5", start: 0 });
});

test("trigger is null with no trigger character, a bad caret, or a space in the word", () => {
  assert.equal(trigger("hello", 5), null);
  assert.equal(trigger("", 0), null);
  assert.equal(trigger("hi @na there", 12), null);
  assert.equal(trigger("@na ", 4), null);
  assert.deepEqual(trigger("@na", 99), { kind: "@", query: "na", start: 0 });
  assert.equal(trigger("@na", -3), null);
});

const people: Item[] = [
  { value: "@nana", label: "Nana" },
  { value: "@hanami", label: "Hanami" },
  { value: "@anna", label: "Anna" },
  { value: "@mina", label: "Mina" },
];

test("filter puts prefix matches before substring matches", () => {
  assert.deepEqual(filter(people, "na").map((i) => i.value), ["@nana", "@hanami", "@anna", "@mina"]);
  assert.deepEqual(filter(people, "an").map((i) => i.value), ["@anna", "@nana", "@hanami"]);
});

test("filter matches the label and ignores case and the trigger character", () => {
  const items: Item[] = [{ value: "#docs", label: "docs", detail: "Write docs" }, { value: "@ada", label: "Whale" }];
  assert.deepEqual(filter(items, "WHA").map((i) => i.value), ["@ada"]);
  assert.deepEqual(filter(items, "DOC").map((i) => i.value), ["#docs"]);
  assert.deepEqual(filter(items, "@"), []);
  assert.deepEqual(filter(items, "zzz"), []);
});

test("filter returns at most 8 items, and all of them for an empty query", () => {
  const many: Item[] = Array.from({ length: 20 }, (_, n) => ({ value: `@n${n}`, label: `N${n}` }));
  assert.equal(MAX_ITEMS, 8);
  assert.equal(filter(many, "").length, 8);
  assert.equal(filter(many, "n").length, 8);
  assert.deepEqual(filter(many, "").map((i) => i.value), many.slice(0, 8).map((i) => i.value));
  // Prefix matches fill the cap before substring matches.
  const mixed: Item[] = [
    ...Array.from({ length: 5 }, (_, n) => ({ value: `@xa${n}`, label: `Xa${n}` })),
    ...Array.from({ length: 9 }, (_, n) => ({ value: `@a${n}`, label: `A${n}` })),
  ];
  const got = filter(mixed, "a").map((i) => i.value);
  assert.equal(got.length, 8);
  assert.deepEqual(got.slice(0, 8), mixed.slice(5, 13).map((i) => i.value));
});

const channels: Item[] = [
  { value: "#general", label: "general" },
  { value: "#work-stuff", label: "work-stuff" },
  { value: "#9logs", label: "9logs" },
];

test("trigger finds a # channel query before the caret", () => {
  assert.deepEqual(trigger("see #wor", 9), { kind: "#", query: "wor", start: 4 });
  assert.deepEqual(trigger("#", 1), { kind: "#", query: "", start: 0 });
  assert.deepEqual(trigger("a\n#gen", 6), { kind: "#", query: "gen", start: 2 });
  // A channel id can start with a digit.
  assert.deepEqual(trigger("#9lo", 4), { kind: "#", query: "9lo", start: 0 });
});

test("a # needs the text start or a space, and a markdown heading is no trigger", () => {
  assert.equal(trigger("a#b", 3), null);
  assert.equal(trigger("##hea", 5), null);
  assert.equal(trigger("issue ##12", 10), null);
});

test("filter lists channels by id and by name", () => {
  assert.deepEqual(filter(channels, "work").map((i) => i.value), ["#work-stuff"]);
  assert.deepEqual(filter(channels, "9").map((i) => i.value), ["#9logs"]);
  assert.deepEqual(filter(channels, "#"), []);
  assert.deepEqual(filter(channels, "").map((i) => i.value), [
    "#general",
    "#work-stuff",
    "#9logs",
  ]);
});

test("insert completes a channel name with one space after it", () => {
  assert.deepEqual(insert("#wor", 4, 0, "#work-stuff"), { text: "#work-stuff ", caret: 12 });
  // A space at the caret stays, as it does for @.
  assert.deepEqual(insert("hi #ge and more", 6, 3, "#general"), {
    text: "hi #general  and more",
    caret: 12,
  });
});

test("insert replaces the trigger and the query with the value and one space", () => {
  assert.deepEqual(insert("hi @na", 6, 3, "@nana"), { text: "hi @nana ", caret: 9 });
  assert.deepEqual(insert("@", 1, 0, "@ada"), { text: "@ada ", caret: 5 });
  assert.deepEqual(insert("ask @do and more", 7, 4, "@docs"), { text: "ask @docs  and more", caret: 10 });
});
