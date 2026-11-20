import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownHtml } from "./markdown.ts";

test("markdown renders emphasis, code, and line breaks", () => {
  const html = markdownHtml("**hi** and `x`\nnext");
  assert.match(html, /<strong>hi<\/strong>/);
  assert.match(html, /<code>x<\/code>/);
  assert.match(html, /<br>/);
});

test("a task list keeps a visible box", () => {
  const html = markdownHtml("- [x] done\n- [ ] todo");
  assert.match(html, /☑ done/);
  assert.match(html, /☐ todo/);
  assert.doesNotMatch(html, /<input/);
});

test("a plain list item carries no box", () => {
  const html = markdownHtml("- plain");
  assert.match(html, /<li>plain<\/li>/);
  assert.doesNotMatch(html, /☑|☐/);
});

test("raw HTML in a message stays text", () => {
  const html = markdownHtml("<script>alert(1)</script>");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&#60;script&#62;/);
});
