import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PREVIEW_LINES,
  MAX_TEXT_PREVIEW,
  previewKind,
  readTextPrefix,
  textFormatOf,
  textPreview,
  type PreviewKind,
} from "./preview.ts";

const CASES: [string, string, PreviewKind][] = [
  ["image/png", "a.png", "image"],
  ["image/jpeg", "a.jpg", "image"],
  ["image/gif", "a.gif", "image"],
  ["image/webp", "a.webp", "image"],
  ["image/avif", "a.avif", "image"],
  ["image/bmp", "a.bmp", "image"],
  ["video/mp4", "a.mp4", "video"],
  ["video/webm", "a.webm", "video"],
  ["audio/mpeg", "a.mp3", "audio"],
  ["audio/ogg", "a.ogg", "audio"],
  ["audio/wav", "a.wav", "audio"],
  ["audio/mp4", "a.m4a", "audio"],
  ["text/markdown", "a.md", "markdown"],
  ["text/plain", "a.txt", "text"],
  ["text/csv", "a.csv", "text"],
  ["application/json", "a.json", "text"],
  ["application/octet-stream", "a.ts", "text"],
  ["application/octet-stream", "a.rs", "text"],
  ["application/octet-stream", "a.py", "text"],
  ["application/octet-stream", "a.log", "text"],
  ["image/svg+xml", "a.svg", "text"],
  ["text/html", "a.html", "text"],
  ["application/pdf", "a.pdf", "pdf"],
  ["application/zip", "a.zip", "none"],
  ["application/octet-stream", "a.bin", "none"],
  ["application/vnd.ms-excel", "a.xlsx", "none"],
];

test("previewKind follows the table", () => {
  for (const [mime, name, kind] of CASES) assert.equal(previewKind(mime, name), kind, `${mime} ${name}`);
});

test("previewKind never renders script: svg and html stay text, whatever the name", () => {
  assert.equal(previewKind("image/svg+xml", "x.png"), "text");
  assert.equal(previewKind("text/html", "x.md"), "text");
  assert.equal(previewKind("TEXT/HTML; charset=utf-8", "x.html"), "text");
});

test("previewKind: a browser tags .ts as a video, so the name decides", () => {
  assert.equal(previewKind("video/mp2t", "main.ts"), "text");
  assert.equal(previewKind("video/mp2t", "clip.m2ts"), "none");
});

test("previewKind: a zip stays a card even with a text-like name", () => {
  assert.equal(previewKind("application/zip", "notes.log"), "none");
});

function counted(total: number, chunk: number) {
  const seen = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled >= total) {
          controller.close();
          return;
        }
        const size = Math.min(chunk, total - seen.pulled);
        controller.enqueue(new Uint8Array(size).fill(97));
        seen.pulled += size;
      },
      cancel() {
        seen.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, seen };
}

test("readTextPrefix cuts a 3 MiB stream at 1 MiB and cancels it", async () => {
  const { stream, seen } = counted(3 * 1024 * 1024, 64 * 1024);
  const out = await readTextPrefix(stream);
  assert.equal(out.cut, true);
  assert.equal(out.text.length, MAX_TEXT_PREVIEW);
  assert.equal(seen.cancelled, true);
  assert.ok(seen.pulled < 3 * 1024 * 1024, `pulled ${seen.pulled}`);
});

test("readTextPrefix cuts inside a chunk", async () => {
  const { stream, seen } = counted(5000, 5000);
  const out = await readTextPrefix(stream, 1000);
  assert.equal(out.text.length, 1000);
  assert.equal(out.cut, true);
  assert.equal(seen.cancelled, true);
});

test("readTextPrefix reads a 10 byte stream whole", async () => {
  const { stream, seen } = counted(10, 4);
  const out = await readTextPrefix(stream);
  assert.deepEqual(out, { text: "aaaaaaaaaa", cut: false });
  assert.equal(seen.cancelled, false);
});

test("readTextPrefix: a file of exactly max bytes is not cut", async () => {
  const { stream, seen } = counted(100, 30);
  const out = await readTextPrefix(stream, 100);
  assert.equal(out.text.length, 100);
  assert.equal(out.cut, false);
  assert.equal(seen.cancelled, false);
});

test("readTextPrefix decodes UTF-8 and drops a character split by the cut", async () => {
  const bytes = new TextEncoder().encode("abあい");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const out = await readTextPrefix(stream, 4);
  assert.equal(out.text, "ab");
  assert.equal(out.cut, true);
  const whole = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  assert.deepEqual(await readTextPrefix(whole), { text: "abあい", cut: false });
});

test("readTextPrefix on an empty stream", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  assert.deepEqual(await readTextPrefix(stream), { text: "", cut: false });
});

test("textFormatOf reads the name, and an unknown name is plain", () => {
  assert.equal(textFormatOf("a.log"), "log");
  assert.equal(textFormatOf("A.LOG"), "log");
  assert.equal(textFormatOf("a.json"), "json");
  assert.equal(textFormatOf("a.csv"), "csv");
  assert.equal(textFormatOf("a.yaml"), "yaml");
  assert.equal(textFormatOf("a.yml"), "yaml");
  assert.equal(textFormatOf("a.txt"), "plain");
  assert.equal(textFormatOf("noext"), "plain");
});

test("textPreview on JSON pretty-prints and counts the keys", () => {
  const out = textPreview("a.json", '{"a":1,"b":[2,3]}');
  assert.equal(out.format, "json");
  assert.equal(out.body, '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
  assert.equal(out.summary, "JSON: 2 keys, 7 lines.");
});

test("textPreview on a JSON array counts the items", () => {
  const out = textPreview("a.json", "[1,2,3]");
  assert.equal(out.summary, "JSON: 3 items, 5 lines.");
  assert.equal(out.body, "[\n  1,\n  2,\n  3\n]");
});

test("textPreview on bad JSON keeps the text and says so", () => {
  const out = textPreview("a.json", "{a: 1}");
  assert.equal(out.format, "json");
  assert.equal(out.body, "{a: 1}");
  assert.equal(out.summary, "JSON did not parse. The text shows as it is.");
});

test("textPreview on CSV counts the header columns and the rows after it", () => {
  const out = textPreview("a.csv", 'name,note\na,"x,y"\nb,"z"\n');
  assert.equal(out.format, "csv");
  assert.equal(out.summary, "CSV: 2 columns, 2 rows after the header.");
  assert.equal(out.body, 'name,note\na,"x,y"\nb,"z"');
});

test("textPreview on CSV reads a CRLF file and a single column", () => {
  const out = textPreview("a.csv", "only\r\n1\r\n");
  assert.equal(out.summary, "CSV: 1 column, 1 row after the header.");
  assert.equal(out.body, "only\n1");
});

test("textPreview on YAML counts only the top-level keys", () => {
  const text = "# a comment\n---\nname: lounge\nnested:\n  inner: 1\n  deeper:\n    k: 2\n\"quoted key\": yes\n";
  const out = textPreview("a.yml", text);
  assert.equal(out.format, "yaml");
  assert.equal(out.summary, "YAML: 3 top-level keys.");
  assert.equal(out.body, text.slice(0, -1));
});

test("textPreview on a short log shows every line", () => {
  const out = textPreview("a.log", "one\ntwo\nthree\n");
  assert.equal(out.format, "log");
  assert.equal(out.summary, "Log: 3 lines.");
  assert.equal(out.body, "one\ntwo\nthree");
});

test("textPreview on a long log shows the last lines only", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = textPreview("a.log", text);
  assert.equal(out.summary, "Log: 500 lines. The last 200 show.");
  const body = out.body.split("\n");
  assert.equal(body.length, MAX_PREVIEW_LINES);
  assert.equal(body[0], "line 301");
  assert.equal(body[body.length - 1], "line 500");
});

test("textPreview on an empty file says so, whatever the format", () => {
  for (const name of ["a.log", "a.json", "a.csv", "a.yaml"]) {
    assert.deepEqual(textPreview(name, ""), { format: textFormatOf(name), summary: "Empty file.", body: "" });
    assert.equal(textPreview(name, "\n\n").summary, "Empty file.");
  }
});

test("textPreview on a plain text file reports the line count", () => {
  const out = textPreview("a.txt", "a\nb");
  assert.equal(out.format, "plain");
  assert.equal(out.summary, "Text: 2 lines.");
  assert.equal(out.body, "a\nb");
});
