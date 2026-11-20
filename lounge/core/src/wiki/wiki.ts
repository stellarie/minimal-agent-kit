import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HttpError } from "../api/http-error.ts";

export interface WikiFinding {
  id: string;
  check: string;
  level: string;
  file: string;
  line: number;
  detail: string;
}

export interface WikiSetup {
  // The project folder: the core's working folder unless a test sets it.
  project: string;
  // WIKI_ROOT and WIKI_NAME. A blank root counts as unset.
  root?: string | undefined;
  name?: string | undefined;
  // Tests swap the interpreter and the checker script.
  python?: string;
  script?: string;
}

export interface WikiSaved {
  name: string;
  findings: WikiFinding[];
  fail: boolean;
}

const CHECK_SCRIPT = resolve(import.meta.dirname, "..", "..", "..", "..", "core", "verify", "wiki_check.py");
const CHECK_MS = 20_000;
// One plain file name. A leading dot, a colon, and a path separator never match.
const PAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
// Windows opens these names as devices.
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i;

function isPlainName(name: string): boolean {
  return name !== "." && name !== ".." && !/[\\/]/.test(name) && !/^[A-Za-z]:/.test(name);
}

function expandHome(path: string): string {
  return /^~([\\/]|$)/.test(path) ? join(homedir(), path.slice(1)) : path;
}

/**
 * The wiki folder, as claude/hooks/session_start.py wiki_dir finds it.
 * Null when the name is a path or no name can be found.
 */
export function wikiDir(project: string, root?: string, name?: string): string | null {
  const base = (root ?? "").trim();
  if (!base) return join(project, "docs", "wiki");
  let folder = (name ?? "").trim();
  if (folder) {
    if (!isPlainName(folder)) return null;
  } else {
    folder = basename(project);
    if (!folder) return null;
  }
  return join(expandHome(base), folder);
}

function missing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// The real path of the nearest existing parent, plus the names below it.
function realish(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch (err) {
      const parent = dirname(at);
      if (!missing(err) || parent === at) throw err;
      rest.push(basename(at));
      at = parent;
    }
  }
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function checkName(name: string): void {
  if (!PAGE_NAME.test(name) || DEVICE_NAME.test(name)) {
    throw new HttpError(400, "bad_page", "a page name is one file name that ends in .md");
  }
}

function notRun(detail: string): { findings: WikiFinding[]; fail: false } {
  return { findings: [{ id: "wiki_check:not-run", check: "wiki_check", level: "not-run", file: "", line: 0, detail }], fail: false };
}

export class Wiki {
  readonly #setup: WikiSetup;

  constructor(setup: WikiSetup) {
    this.#setup = setup;
  }

  #folder(): string {
    const { project, root, name } = this.#setup;
    const folder = wikiDir(project, root, name);
    if (folder === null) throw new HttpError(400, "no_wiki", "the wiki name is not one folder name");
    return folder;
  }

  // The folder with its links resolved. It must stay inside the wiki root.
  #real(folder: string): string {
    const { project, root } = this.#setup;
    const base = (root ?? "").trim() ? expandHome((root ?? "").trim()) : project;
    const real = realish(folder);
    if (!within(realish(base), real)) {
      throw new HttpError(403, "forbidden", "the wiki folder is outside the wiki root");
    }
    return real;
  }

  // The file of a page. A link or a folder in its place is refused.
  #file(name: string): string {
    checkName(name);
    const file = join(this.#real(this.#folder()), name);
    try {
      const info = lstatSync(file);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new HttpError(403, "forbidden", `${name} is not a plain file`);
      }
    } catch (err) {
      if (!missing(err)) throw err;
    }
    return file;
  }

  list(): { folder: string; pages: string[] } {
    const folder = this.#folder();
    const real = this.#real(folder);
    try {
      const pages = readdirSync(real, { withFileTypes: true })
        .filter((e) => e.isFile() && PAGE_NAME.test(e.name))
        .map((e) => e.name)
        .sort();
      return { folder, pages };
    } catch (err) {
      if (!missing(err)) throw err;
      return { folder, pages: [] };
    }
  }

  read(name: string): string {
    const file = this.#file(name);
    try {
      return readFileSync(file, "utf8");
    } catch (err) {
      if (!missing(err)) throw err;
      throw new HttpError(404, "unknown_page", `no page ${name}`);
    }
  }

  write(name: string, text: string): WikiSaved {
    const file = this.#file(name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
    return { name, ...this.#check(dirname(file)) };
  }

  // Every finding comes back. Exit 1 marks a fail. Anything else that is not a clean run is not-run.
  #check(folder: string): { findings: WikiFinding[]; fail: boolean } {
    const python = this.#setup.python ?? "python";
    const run = spawnSync(python, [this.#setup.script ?? CHECK_SCRIPT, folder, "--json"], {
      encoding: "utf8",
      timeout: CHECK_MS,
      windowsHide: true,
    });
    if (run.error) return notRun(`${python} did not run: ${run.error.message}`);
    if (run.status !== 0 && run.status !== 1) {
      return notRun(`wiki_check exited with ${run.status}: ${run.stderr.trim().split("\n").pop() ?? ""}`);
    }
    let found: unknown;
    try {
      found = JSON.parse(run.stdout);
    } catch {
      return notRun("wiki_check printed no JSON");
    }
    if (!Array.isArray(found)) return notRun("wiki_check printed no JSON list");
    return { findings: found as WikiFinding[], fail: run.status === 1 };
  }
}
