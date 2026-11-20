import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Caller } from "../config.ts";
import { LoungeError } from "./room.ts";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  // Set only in a turn: the local file to read.
  path?: string;
}

const EXT = /^\.[a-z0-9]{1,10}$/;
// Explorer follows icon paths in shortcuts and runs executables.
const NO_NAMED_EXT = new Set([
  ".url", ".lnk", ".scf", ".library-ms", ".searchconnector-ms", ".desktop",
  ".theme", ".themepack", ".website",
  ".exe", ".com", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse",
  ".wsf", ".wsh", ".hta", ".msi", ".scr", ".cpl", ".reg",
]);
const NAMED_COPY = /^[0-9a-f]{32}(\.[a-z0-9-]+)$/i;

export function attachmentDir(home: string): string {
  return resolve(join(home, "attachments"));
}

// Read tools pick the file type by extension.
export function attachmentPath(home: string, att: Attachment): string {
  if (!/^[0-9a-f]{32}$/.test(att.id)) throw new LoungeError("bad_attachment", `unknown attachment: ${att.id}`);
  const base = join(attachmentDir(home), att.id);
  const ext = extname(att.name).toLowerCase();
  if (!EXT.test(ext) || NO_NAMED_EXT.has(ext)) return base;
  const named = base + ext;
  if (!existsSync(named) && existsSync(base)) {
    try {
      linkSync(base, named);
    } catch {
      copyFileSync(base, named);
    }
  }
  return named;
}

export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_PER_MESSAGE = 10;
const MAX_NAME = 120;
const ID = /^[0-9a-f]{32}$/;
// Unposted uploads live one day.
const STAGED_MS = 24 * 3_600_000;

const BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".log": "text/plain",
  ".zip": "application/zip",
};

// The browser may show only these inline. SVG and HTML can run script.
export const INLINE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/mp4",
]);

export function mimeOf(name: string, given?: string): string {
  const clean = (given ?? "").split(";")[0]!.trim().toLowerCase();
  if (/^[a-z]+\/[a-z0-9.+-]+$/.test(clean) && clean !== "application/octet-stream") return clean;
  return BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function cleanName(raw: unknown): string {
  const name = basename(String(raw ?? "").replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, "_")
    .trim();
  return (name || "file").slice(0, MAX_NAME);
}

export interface RoomFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  author: string;
  messageId: number;
  createdAt: string;
}

const FILES_PAGE_ROWS = 60;
const FILES_PAGE_ITEMS = 50;

function parseList(raw: unknown): Pick<Attachment, "id" | "name" | "mime" | "size">[] | undefined {
  if (typeof raw !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const list: Pick<Attachment, "id" | "name" | "mime" | "size">[] = [];
  for (const item of value as Record<string, unknown>[]) {
    if (typeof item !== "object" || item === null) continue;
    if (typeof item.id !== "string" || typeof item.name !== "string") continue;
    list.push({
      id: item.id,
      name: item.name,
      mime: typeof item.mime === "string" ? item.mime : "application/octet-stream",
      size: typeof item.size === "number" ? item.size : 0,
    });
  }
  return list;
}

export class Attachments {
  readonly #db: DatabaseSync;
  readonly #dir: string;
  readonly #now: () => Date;

  constructor(opts: { db: DatabaseSync; home: string; now?: () => Date }) {
    this.#db = opts.db;
    this.#dir = resolve(join(opts.home, "attachments"));
    this.#now = opts.now ?? (() => new Date());
    mkdirSync(this.#dir, { recursive: true });
  }

  save(by: Caller, rawName: unknown, data: Buffer, given?: string): Attachment {
    if (data.length === 0) throw new LoungeError("bad_attachment", "the file is empty");
    if (data.length > MAX_ATTACHMENT) {
      throw new LoungeError("bad_attachment", `a file has at most ${MAX_ATTACHMENT / 1024 / 1024} MB`);
    }
    const name = cleanName(rawName);
    const att: Attachment = { id: randomBytes(16).toString("hex"), name, mime: mimeOf(name, given), size: data.length };
    writeFileSync(this.file(att.id), data, { mode: 0o600 });
    this.#db
      .prepare("INSERT INTO attachments (id, name, mime, size, created_by, created_at, posted) VALUES (?, ?, ?, ?, ?, ?, 0)")
      .run(att.id, att.name, att.mime, att.size, by, this.#now().toISOString());
    return att;
  }

  get(id: string): Attachment | undefined {
    if (!ID.test(id)) return undefined;
    const row = this.#db.prepare("SELECT id, name, mime, size FROM attachments WHERE id = ?").get(id);
    if (!row) return undefined;
    return { id: String(row.id), name: String(row.name), mime: String(row.mime), size: Number(row.size) };
  }

  file(id: string): string {
    if (!ID.test(id)) throw new LoungeError("bad_attachment", `unknown attachment: ${id}`);
    return join(this.#dir, id);
  }

  read(id: string): Buffer {
    return readFileSync(this.file(id));
  }

  // Ids for one message. Does not mark them posted.
  resolve(ids: unknown): Attachment[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids) || ids.length > MAX_PER_MESSAGE) {
      throw new LoungeError("bad_attachment", `attachments is a list of at most ${MAX_PER_MESSAGE} ids`);
    }
    return [...new Set(ids)].map((id) => {
      const att = typeof id === "string" ? this.get(id) : undefined;
      if (!att) throw new LoungeError("bad_attachment", `unknown attachment: ${String(id)}`);
      return att;
    });
  }

  markPosted(list: Attachment[]): void {
    for (const att of list) this.#db.prepare("UPDATE attachments SET posted = 1 WHERE id = ?").run(att.id);
  }

  rooms(id: string): string[] {
    if (!ID.test(id)) return [];
    const rows = this.#db
      .prepare("SELECT DISTINCT room_id, attachments FROM messages WHERE attachments LIKE ?")
      .all(`%${id}%`);
    const out = new Set<string>();
    for (const row of rows) {
      if (parseList(row.attachments)?.some((att) => att.id === id)) out.add(String(row.room_id));
    }
    return [...out];
  }

  // Newest message first. Whole messages only.
  roomFiles(roomId: string, before?: number): { files: RoomFile[]; next: number | null } {
    if (!this.#db.prepare("SELECT 1 FROM rooms WHERE id = ?").get(roomId)) {
      throw new LoungeError("unknown_room", `unknown room: ${roomId}`);
    }
    const rows = this.#db
      .prepare(
        "SELECT id, author, created_at, attachments FROM messages " +
          "WHERE room_id = ? AND attachments IS NOT NULL AND id < ? ORDER BY id DESC LIMIT ?",
      )
      .all(roomId, before ?? Number.MAX_SAFE_INTEGER, FILES_PAGE_ROWS);
    const files: RoomFile[] = [];
    let last: number | null = null;
    let cut = false;
    for (const row of rows) {
      const list = parseList(row.attachments) ?? [];
      if (files.length > 0 && files.length + list.length > FILES_PAGE_ITEMS) {
        cut = true;
        break;
      }
      last = Number(row.id);
      for (const att of list) {
        files.push({ ...att, author: String(row.author), messageId: last, createdAt: String(row.created_at) });
      }
    }
    return { files, next: cut || rows.length >= FILES_PAGE_ROWS ? last : null };
  }

  // Removes uploads that no message used.
  sweep(): number {
    // Old named copies of risky types.
    for (const name of readdirSync(this.#dir)) {
      const ext = NAMED_COPY.exec(name)?.[1]?.toLowerCase();
      if (!ext || !NO_NAMED_EXT.has(ext)) continue;
      try {
        rmSync(join(this.#dir, name), { force: true });
      } catch (err) {
        console.error(`failed to delete named copy ${name}:`, err);
      }
    }
    const cutoff = new Date(this.#now().getTime() - STAGED_MS).toISOString();
    const rows = this.#db.prepare("SELECT id FROM attachments WHERE posted = 0 AND created_at < ?").all(cutoff);
    for (const row of rows) {
      const file = this.file(String(row.id));
      // Delete only inside the attachments folder.
      if (!resolve(file).startsWith(this.#dir + sep)) continue;
      try {
        if (existsSync(file)) rmSync(file);
        for (const name of readdirSync(this.#dir)) {
          if (name.startsWith(`${String(row.id)}.`)) rmSync(join(this.#dir, name));
        }
        this.#db.prepare("DELETE FROM attachments WHERE id = ?").run(String(row.id));
      } catch (err) {
        console.error(`failed to delete attachment ${String(row.id)}:`, err);
      }
    }
    return rows.length;
  }
}
