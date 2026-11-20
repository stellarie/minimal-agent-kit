export type PreviewKind = "image" | "video" | "audio" | "markdown" | "text" | "pdf" | "none";

export const MAX_TEXT_PREVIEW = 1024 * 1024;

const IMAGE = /^image\/(png|jpeg|gif|webp|avif|bmp)$/;
const VIDEO = /^video\/(mp4|webm)$/;
const AUDIO = /^audio\/(mpeg|ogg|wav|mp4)$/;
// SVG and HTML can run script, so they show as text only.
const TEXT_MIME = new Set(["text/plain", "text/csv", "application/json", "image/svg+xml", "text/html"]);
const MARKDOWN_EXT = new Set([".md", ".markdown"]);
const TEXT_EXT = new Set([
  ".txt", ".log", ".csv", ".json", ".ts", ".js", ".mjs", ".svelte", ".rs", ".py",
  ".kt", ".toml", ".yml", ".yaml", ".ini", ".css", ".sh", ".ps1",
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

export function previewKind(mime: string, name: string): PreviewKind {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  if (IMAGE.test(type)) return "image";
  if (VIDEO.test(type)) return "video";
  if (AUDIO.test(type)) return "audio";
  if (type === "application/pdf") return "pdf";
  if (type === "text/markdown") return "markdown";
  if (TEXT_MIME.has(type)) return "text";
  if (type === "application/zip") return "none";
  const ext = extOf(name);
  if (MARKDOWN_EXT.has(ext)) return "markdown";
  return TEXT_EXT.has(ext) ? "text" : "none";
}

export type TextFormat = "json" | "csv" | "yaml" | "log" | "plain";

export interface TextPreview {
  format: TextFormat;
  summary: string;
  body: string;
}

// A log preview shows its end, so this is a tail limit.
export const MAX_PREVIEW_LINES = 200;

const FORMAT_EXT = new Map<string, TextFormat>([
  [".json", "json"],
  [".csv", "csv"],
  [".yaml", "yaml"],
  [".yml", "yaml"],
  [".log", "log"],
]);

const TOP_KEY = /^(?:"([^"]+)"|'([^']+)'|([^:#]+?))\s*:(\s|$)/;

export function textFormatOf(name: string): TextFormat {
  return FORMAT_EXT.get(extOf(name)) ?? "plain";
}

function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  // A closing newline does not start another line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function countOf(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Counts the commas that sit outside double quotes.
function columnsOf(line: string): number {
  let count = 1;
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) count++;
  }
  return count;
}

function topKeysOf(lines: string[]): string[] {
  const keys: string[] = [];
  for (const line of lines) {
    if (line === "---" || line === "..." || line.startsWith("#")) continue;
    if (/^\s/.test(line)) continue; // A nested key is not top level.
    const match = TOP_KEY.exec(line);
    if (match) keys.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return keys;
}

function jsonSummary(value: unknown, lineCount: number): string {
  if (Array.isArray(value)) {
    return `JSON: ${countOf(value.length, "item", "items")}, ${countOf(lineCount, "line", "lines")}.`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).length;
    return `JSON: ${countOf(keys, "key", "keys")}, ${countOf(lineCount, "line", "lines")}.`;
  }
  return `JSON: one value, ${countOf(lineCount, "line", "lines")}.`;
}

export function textPreview(name: string, text: string): TextPreview {
  const format = textFormatOf(name);
  if (text.trim() === "") return { format, summary: "Empty file.", body: "" };
  const lines = linesOf(text);

  if (format === "json") {
    try {
      const value: unknown = JSON.parse(text);
      const body = JSON.stringify(value, null, 2);
      return { format, summary: jsonSummary(value, linesOf(body).length), body };
    } catch {
      return { format, summary: "JSON did not parse. The text shows as it is.", body: text };
    }
  }
  if (format === "csv") {
    const columns = columnsOf(lines[0]!);
    const rows = Math.max(lines.length - 1, 0);
    const summary = `CSV: ${countOf(columns, "column", "columns")}, ${countOf(rows, "row", "rows")} after the header.`;
    return { format, summary, body: lines.join("\n") };
  }
  if (format === "yaml") {
    const keys = topKeysOf(lines);
    const summary = `YAML: ${countOf(keys.length, "top-level key", "top-level keys")}.`;
    return { format, summary, body: lines.join("\n") };
  }
  if (format === "log") {
    // Logs grow at the end, so the tail is the newest part.
    const total = lines.length;
    if (total <= MAX_PREVIEW_LINES) {
      return { format, summary: `Log: ${countOf(total, "line", "lines")}.`, body: lines.join("\n") };
    }
    const summary = `Log: ${total} lines. The last ${MAX_PREVIEW_LINES} show.`;
    return { format, summary, body: lines.slice(-MAX_PREVIEW_LINES).join("\n") };
  }
  return { format, summary: `Text: ${countOf(lines.length, "line", "lines")}.`, body: text };
}

// Reads at most max bytes, then cancels the rest of the download.
export async function readTextPrefix(
  body: ReadableStream<Uint8Array>,
  max: number = MAX_TEXT_PREVIEW,
): Promise<{ text: string; cut: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > max) {
        cut = true;
        break;
      }
      if (total === max) {
        // Only the next read shows whether the file ends here.
        cut = !(await reader.read()).done;
        break;
      }
    }
  } finally {
    if (cut) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const chunk of chunks) {
    const room = bytes.length - at;
    if (room <= 0) break;
    bytes.set(chunk.length > room ? chunk.subarray(0, room) : chunk, at);
    at += Math.min(chunk.length, room);
  }
  // A stream decode drops a character split by the cut.
  const text = new TextDecoder("utf-8").decode(bytes, { stream: cut });
  return { text, cut };
}
