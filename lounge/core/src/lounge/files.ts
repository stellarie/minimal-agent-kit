import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_ATTACHMENT, mimeOf } from "./attachments.ts";
import { LoungeError } from "./room.ts";

// Names that hold secrets. Matched per path segment, any case.
const SECRET_NAMES = [
  /^\.ssh$/,
  /^\.gnupg$/,
  /^\.aws$/,
  /^\.azure$/,
  /^\.kube$/,
  /^\.docker$/,
  /^\.env(\..*)?$/,
  /^\.netrc$/,
  /^_netrc$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.git-credentials$/,
  /^tokens\.json$/,
  /^endpoint\.json$/,
  /^\.credentials\.json$/,
  /credential/,
  /secret/,
  /password/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /\.(pem|key|p12|pfx|kdbx|keystore|jks|ppk|gpg|asc)$/,
  /^(cookies|login data|web data|local state)$/,
  /^wallet/,
];

const MAX_ENTRIES = 500;
const MAX_TEXT_PREVIEW = 20_000;

export interface FileEntry {
  name: string;
  dir: boolean;
  size?: number;
  modified?: string;
}

export function isSecret(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_NAMES.some((re) => re.test(lower));
}

export class ProfileFiles {
  readonly #root: string;
  // Extra folders to hide, such as the lounge home.
  readonly #hidden: string[];

  constructor(opts: { root?: string; hidden?: string[] } = {}) {
    this.#root = realpathSync(resolve(opts.root ?? homedir()));
    this.#hidden = (opts.hidden ?? []).map((p) => resolve(p).toLowerCase());
  }

  root(): string {
    return this.#root;
  }

  // Real path inside the root, with no secret segment.
  check(raw: unknown): string {
    if (raw !== undefined && typeof raw !== "string") throw new LoungeError("bad_path", "path must be a string");
    const given = !raw ? this.#root : isAbsolute(raw) ? raw : join(this.#root, raw);
    let real: string;
    try {
      // Links resolve first, so a link cannot leave the root.
      real = realpathSync(resolve(given));
    } catch {
      throw new LoungeError("bad_path", `no such file or folder: ${given}`);
    }
    const rel = relative(this.#root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new LoungeError("forbidden", `only files under ${this.#root} are allowed`);
    }
    if (rel && rel.split(sep).some(isSecret)) throw new LoungeError("forbidden", "that path may hold secrets");
    const lower = real.toLowerCase();
    if (this.#hidden.some((h) => lower === h || lower.startsWith(h + sep))) {
      throw new LoungeError("forbidden", "that folder is private to the lounge");
    }
    return real;
  }

  browse(raw?: unknown): { path: string; entries: FileEntry[]; more: boolean } {
    const path = this.check(raw);
    if (!statSync(path).isDirectory()) throw new LoungeError("bad_path", `not a folder: ${path}`);
    const entries: FileEntry[] = [];
    let more = false;
    for (const dirent of readdirSync(path, { withFileTypes: true })) {
      if (isSecret(dirent.name)) continue;
      if (entries.length >= MAX_ENTRIES) {
        more = true;
        break;
      }
      const entry: FileEntry = { name: dirent.name, dir: dirent.isDirectory() };
      try {
        const st = statSync(join(path, dirent.name));
        entry.dir = st.isDirectory();
        if (!entry.dir) entry.size = st.size;
        entry.modified = st.mtime.toISOString();
      } catch {
        // A locked file still lists by name.
      }
      entries.push(entry);
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    return { path, entries, more };
  }

  read(raw: unknown): { path: string; name: string; mime: string; data: Buffer } {
    const path = this.check(raw);
    const st = statSync(path);
    if (!st.isFile()) throw new LoungeError("bad_path", `not a file: ${path}`);
    if (st.size > MAX_ATTACHMENT) {
      throw new LoungeError("bad_attachment", `a file has at most ${MAX_ATTACHMENT / 1024 / 1024} MB`);
    }
    const name = basename(path);
    return { path, name, mime: mimeOf(name), data: readFileSync(path) };
  }
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json";
}

// A short text view, so the agent can judge before it sends.
export function textPreview(mime: string, data: Buffer): string | undefined {
  if (!isTextMime(mime)) return undefined;
  const head = data.subarray(0, MAX_TEXT_PREVIEW).toString("utf8");
  return data.length > MAX_TEXT_PREVIEW ? `${head}\n[cut at ${MAX_TEXT_PREVIEW} bytes]` : head;
}
