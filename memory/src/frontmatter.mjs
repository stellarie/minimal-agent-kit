export const MEMORY_TYPES = Object.freeze(["user", "feedback", "project", "reference"]);

const KEYS = [
  "id",
  "title",
  "type",
  "tags",
  "pinned",
  "valid",
  "invalid_reason",
  "author",
  "created",
  "updated",
];

export function oneLine(value) {
  return String(value ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export function serializeMemory(memory) {
  const lines = ["---"];
  for (const key of KEYS) {
    // A type this version does not know stays in the file as written.
    let value = key === "type" ? memory.type_raw || memory.type : memory[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value = value.join(", ");
    lines.push(`${key}: ${oneLine(value)}`);
  }
  lines.push("---", "", String(memory.body ?? "").trim(), "");
  return lines.join("\n");
}

export function parseMemory(text) {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error("memory file has no frontmatter");
  const fields = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return {
    id: fields.id,
    title: fields.title ?? "",
    type: MEMORY_TYPES.includes((fields.type ?? "").toLowerCase()) ? fields.type.toLowerCase() : "",
    type_raw: fields.type ?? "",
    tags: splitTags(fields.tags),
    pinned: /^true$/i.test(fields.pinned ?? ""),
    valid: !/^false$/i.test(fields.valid ?? ""),
    invalid_reason: fields.invalid_reason ?? "",
    author: fields.author ?? "",
    created: fields.created ?? "",
    updated: fields.updated ?? "",
    body: match[2].trim(),
  };
}

export function splitTags(value) {
  if (Array.isArray(value)) return value.map(oneLine).filter(Boolean);
  return String(value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}
