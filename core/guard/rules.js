// Guard rules shared by the kit hook (guard.js) and the lounge core.
// Plain JavaScript, so the hook runs with Node alone. The rules read
// command text, so they stop accidents. They do not stop a program that
// hides what it does.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { win32 } from "node:path";

const RANK = { allow: 0, ask: 1, block: 2 };
const SCRATCH = new Set([
  "tmp", ".scratch", "target", "node_modules", "dist", "build", "out", "coverage", ".next", ".svelte-kit",
  ".turbo", ".cache", ".parcel-cache", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv",
]);

// $null, $args, and $matches are set on purpose in normal scripts.
const AUTO_VARS = [
  "$", "?", "^", "_", "consolehost", "error", "event", "eventargs", "eventsubscriber",
  "executioncontext", "false", "foreach", "home", "host", "input", "iscoreclr", "islinux", "ismacos",
  "iswindows", "lastexitcode", "myinvocation", "nestedpromptlevel", "pid", "profile",
  "psboundparameters", "pscmdlet", "pscommandpath", "psculture", "psdebugcontext", "psedition", "pshome",
  "psitem", "psscriptroot", "pssenderinfo", "psuiculture", "psversiontable", "pwd", "sender", "shellid",
  "stacktrace", "switch", "this", "true",
];
const WORD_VARS = AUTO_VARS.filter((v) => /^\w+$/.test(v)).join("|");
const AUTO_ASSIGN = new RegExp(`\\$\\{?(${WORD_VARS})\\}?(?![\\w:])\\s*[-+*/%]?=(?!=)`, "i");
const AUTO_SET = new RegExp(`\\b(set-variable|new-variable|sv|nv)\\s+(-name\\s+)?['"]?(${WORD_VARS})['"]?(?![\\w])`, "i");
const AUTO_LOOP = new RegExp(`\\bforeach\\s*\\(\\s*\\$(${WORD_VARS})\\s+in\\b`, "i");
const HOME_ASSIGN = /(^|[\s;&|])(export\s+)?(HOME|USERPROFILE)=/;

// Tested on the text outside quotes. A nested shell is judged again.
const HIDDEN = [
  [/\b(pwsh|powershell)(\.exe)?\b[^;&|]*\s-(e|ec|en|enc|enco|encodedcommand)\b/i, "runs an encoded command"],
  [/\b(invoke-expression|iex)\b/i, "runs text as code"],
  [/\[scriptblock\]::create/i, "runs text as code"],
  [/frombase64string/i, "decodes hidden text"],
  [/\|\s*(ba|z|da)?sh\b/i, "pipes text into a shell"],
];

// Folder deletes written in another language. A bare name counts as a call: a
// "(" follows, or a quote, "$", or word follows after a space (Ruby, Perl).
const CODE_DELETE =
  /\b(rmSync|rmdirSync|rmtree|removedirs|remove_dir_all|DeleteDirectory|rm_rf|emptyDirSync|emptyDir)\b(?=\s*\(|\s+['"$\w])|\bfs(\.promises)?\.(rm|rmdir)\s*\(|\[(system\.)?io\.directory\]::delete\s*\(|\.delete\s*\(\s*\$true\s*\)/i;
// A root, home, or system path inside code text.
const CODE_ROOT =
  /\b[a-z]:[\\/]+(users|windows|program|projects)?\b|['"`][a-z]:[\\/]*['"`]|homedir\s*\(|userprofile|expanduser|Path\.home|\$HOME|['"`]~[\\/'"`]|['"`]\/['"`]/i;
const CODE_FILE = /\.(m?js|cjs|ts|mts|cts|py|rb|pl)$/i;
const CODE_RUNNERS = new Set(["node", "deno", "bun", "tsx", "ts-node", "python", "python3", "py", "ruby", "perl"]);

// Verb, a test on the arguments, and the reason.
const SYSTEM = [
  [/^format$/, /(^|\s)[a-z]:/i, "formats a drive"],
  [/^(diskpart|bcdedit|mkfs(\.\w+)?)$/, null, "changes disks or boot settings"],
  [/^(format-volume|clear-disk|remove-partition|initialize-disk|set-partition)$/, null, "changes disks"],
  [/^(vssadmin|wbadmin)$/, /\bdelete\b/i, "deletes backups"],
  [/^cipher$/, /(^|\s)\/w\b/i, "wipes free space"],
  [/^reg$/, /^delete\b/i, "deletes registry keys"],
  [/^(remove-item|remove-itemproperty|ri|rm|del)$/, /\bhk(lm|cr|cu|u):/i, "deletes registry keys"],
  [/^(shutdown|stop-computer|restart-computer)$/, null, "shuts down the PC"],
  [/^dd$/, /\bof=\/dev\//, "writes a raw device"],
  [/^(takeown|icacls)$/, /(^|\s)\/t\b/i, "changes owners or rights on a tree"],
];

// A redirect, or a write, move, copy, or delete verb, that names a guard file.
// Reading and running the guard stay allowed.
const GUARD_FILE = String.raw`guard[\\/]+(guard|rules)\.js\b`;
const GUARD_WRITE = new RegExp(
  `>\\s*\\S*${GUARD_FILE}` +
    `|\\b(rm|del|erase|remove-item|ri|rmdir|mv|move|move-item|rename-item|ren|cp|copy|copy-item|set-content|add-content|out-file|tee)\\b[^;|&\\n]*${GUARD_FILE}` +
    `|\\bsed\\b[^;|&\\n]*\\s-\\w*i[^;|&\\n]*${GUARD_FILE}`,
  "i",
);

// A shell that names the relax marker folder asks, so an agent cannot relax itself.
// The name is caught after a cd too.
const RELAX_DIR_TEXT = /\.agent-kit[\\/]+guard-relax\b/i;

// Tested on the text with quotes and string joins removed.
// A true fourth value keeps the entry for a read-only shell. "ask" keeps it at ask.
const GUARD_TEXT = [
  [/\/api\/+guard\b/i, "block", "calls the guard approval API", "ask"],
  [/\.claude[\\/]+settings[\w.-]*\.json/i, "ask", "touches Claude settings, where the guard hook lives"],
  [/\.agent-lounge(?![\\/]+attachments\b(?![^\s;|&]*[\\/]\.\.))/i, "ask", "touches the lounge home", true],
  [GUARD_WRITE, "ask", "writes to or deletes the guard code", true],
  [RELAX_DIR_TEXT, "ask", "touches the guard relax markers"],
  [/[\\/][^\\/\s]{1,6}~\d/, "ask", "uses a short 8.3 path name", true],
];

// Bash drops a backslash before a character. Windows shells read it as a path mark.
// Every text rule checks both readings.
function bashRead(text) {
  return String(text).replace(/\\([\s\S])/g, "$1");
}

function readings(text) {
  const t = String(text);
  return [...new Set([t, t.replace(/\\/g, "/"), bashRead(t)])];
}

// Files that hold secrets. Tested on a path, a glob, or shell text.
const SEP = "[/\\s'\"=:(,;|&<>]";
const END = "(?=$|[/\\s;|&),<>'\":])";
const SENSITIVE = [
  new RegExp(`(^|${SEP})\\.(ssh|gnupg|azure)${END}`, "i"),
  new RegExp(`(^|${SEP})\\.config/gcloud${END}`, "i"),
  new RegExp(`(^|${SEP})\\.aws/(credentials|config)${END}`, "i"),
  new RegExp(`(^|${SEP})\\.kube/config${END}`, "i"),
  new RegExp(`(^|${SEP})\\.docker/config\\.json${END}`, "i"),
  new RegExp(`(^|${SEP})id_(rsa|dsa|ecdsa|ed25519)`, "i"),
  new RegExp(`(^|${SEP})(\\.npmrc|\\.pypirc|\\.netrc|_netrc|\\.git-credentials|credentials\\.json)${END}`, "i"),
  new RegExp(`\\.(pem|key|pfx|p12|kdbx)${END}`, "i"),
  /cordis[\w.-]*\.ya?ml/i,
];
const ENV_FILE = new RegExp(`(^|${SEP})\\.env([.*?\\[][^/\\s;|&),<>'"]*)?${END}`, "gi");
const SAMPLE_SUFFIX = /\.(example|sample|template|dist)$/i;
const WILD = /[*?[]/;
// A wildcard leaf in one of these folders can match a secret file.
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".azure", ".aws", ".kube", ".docker"]);

// Sensitive names, as path segments, for the test of a glob against them.
// "zz" stands for any file name.
const GLOB_NAMES = [
  ".env", ".env.local", ".ssh", ".gnupg", ".azure", ".ssh/id_rsa", ".ssh/zz", ".gnupg/zz", ".azure/zz",
  ".config/gcloud/zz", ".aws/credentials", ".aws/config", ".kube/config", ".docker/config.json", "id_rsa",
  "id_dsa", "id_ecdsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", "_netrc", ".git-credentials",
  "credentials.json", "zz.pem", "zz.key", "zz.pfx", "zz.p12", "zz.kdbx", "cordis.yml", "cordis.yaml",
].map((n) => n.split("/"));
// The 8.3 short names of the dotted names. A content verb reads them through a wildcard.
const SHORT_GLOB_NAMES = [
  "ENV~1", "SSH~1", "GNUPG~1", "AZURE~1", "AWS~1", "KUBE~1", "DOCKER~1", "NPMRC~1", "PYPIRC~1", "NETRC~1",
  "GIT-CR~1", "CONFIG~1",
].map((n) => [n]);
// A wildcard that stands for more characters than this is a broad glob, such as *.json.
const GLOB_REACH = 4;

function globParts(segment) {
  let source = "";
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    const close = c === "[" ? segment.indexOf("]", i + 1) : -1;
    if (c === "*") source += "([^/]*)";
    else if (c === "?") source += "([^/])";
    else if (close > i) {
      source += "([^/])";
      i = close;
    } else source += c.replace(/[.+^${}()|\\\]\[]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

// One or more slashes are one slash, and a . segment is no segment: ~/.aws//./credentials.
function cleanPath(text) {
  return text.replace(/[\\/]+/g, "/").replace(/\/\.(?=\/)/g, "");
}

// Each choice of a {a,b} group, up to a limit.
function expandBraces(text, limit = 32) {
  const m = /\{([^{}]*)\}/.exec(text);
  if (!m) return [text];
  const out = [];
  for (const choice of m[1].split(",")) {
    const next = text.slice(0, m.index) + choice + text.slice(m.index + m[0].length);
    for (const variant of expandBraces(next, limit)) {
      out.push(variant);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// True when a glob can match a sensitive name with a few wildcard characters.
// A broad test has no reach limit and needs no letter: a content verb reads what the glob matches.
function globSensitive(word, broad = false) {
  const segs = word.split("/").filter((s) => s !== "");
  // A wildcard in a hidden name can match .env or .ssh.
  if (segs.some((s) => s.startsWith(".") && WILD.test(s))) return word;
  for (let i = 0; i < segs.length - 1; i++) {
    const dir = segs[i].toLowerCase();
    const secret = SECRET_DIRS.has(dir) || (dir === "gcloud" && segs[i - 1]?.toLowerCase() === ".config");
    if (secret && segs.slice(i + 1).some((s) => WILD.test(s))) return word;
  }
  for (const name of broad ? [...GLOB_NAMES, ...SHORT_GLOB_NAMES] : GLOB_NAMES) {
    if (segs.length < name.length) continue;
    const tail = segs.slice(-name.length);
    if (!tail.some((s) => WILD.test(s))) continue;
    if (!broad && !tail.some((s) => /\w/.test(s.replace(/\[[^\]]*\]|[*?]/g, "")))) continue;
    let reach = 0;
    const fits = tail.every((s, i) => {
      const m = globParts(s).exec(name[i]);
      if (m) reach += m.slice(1).join("").length;
      return m !== null;
    });
    if (fits && (broad || reach <= GLOB_REACH)) return word;
  }
  return undefined;
}

// The first sensitive name in the text, else undefined.
function sensitiveText(text) {
  for (const variant of expandBraces(String(text))) {
    const t = cleanPath(variant);
    for (const re of SENSITIVE) {
      const m = re.exec(t);
      if (m) return m[0].replace(new RegExp(`^${SEP}`), "");
    }
    for (const m of t.matchAll(ENV_FILE)) {
      if (!SAMPLE_SUFFIX.test(m[2] ?? "")) return m[0].replace(new RegExp(`^${SEP}`), "");
    }
    for (const word of t.split(/[\s;|&(),<>'"=]+/)) {
      for (const piece of [word, optionOperand(word)]) {
        if (piece && WILD.test(piece)) {
          const hit = globSensitive(piece);
          if (hit) return hit;
        }
      }
    }
  }
  return undefined;
}

const ENV_TEXT = [
  /\$\{?env:/i,
  /\[(system\.)?environment\]::getenvironmentvariable/i,
  /environment::/i,
  /\/proc\/[^\s]*\/env/i,
  /\bprintenv\b/i,
  /expandenvironmentvariables|win32_environment/i,
  // HKCU:Envi* and similar short forms of the Environment key.
  /\bhk(cu|lm):[\\/]*env/i,
];
const ENV_HIVE = /\bhk(cu|lm)\b|hkey_(current_user|local_machine)/i;
// A word such as env:PATH reaches the environment drive of PowerShell.
const ENV_WORD = /(^|[^\w-])env:/i;
// A verb that runs the next verb.
const WRAPPERS = new Set([
  "sudo", "doas", "xargs", "command", "exec", "nohup", "time", "nice", "ionice", "stdbuf", "timeout", "setsid",
  "busybox", "builtin", "call", "start", "start-process", "saps", "cmd", "wsl", "bash", "sh", "zsh", "dash",
  "pwsh", "powershell",
]);
const LISTERS = new Set(["export", "declare", "typeset"]);

function envSegment(all) {
  // The text of a nested "cmd /c set" holds the switch first.
  let start = 0;
  while (start < all.length && /^\/[a-z]$/i.test(all[start].text)) start++;
  const rest = all.slice(start);
  if (rest.length === 0) return false;
  if (rest.some((w) => ENV_WORD.test(w.text))) return true;
  const verb = verbOf(rest[0]);
  if (verb === "env") return true;
  if (WRAPPERS.has(verb) && rest.slice(1).some((w) => verbOf(w) === "env")) return true;
  if (verb === "set") return rest.length === 1 || (rest.length === 2 && !rest[1].text.includes("=") && !/^[/+-]/.test(rest[1].text));
  if (LISTERS.has(verb)) return rest.slice(1).every((w) => /^-[px]+$/.test(w.text));
  return verb === "jq" && rest.some((w) => /\benv\b/i.test(w.text));
}

// A shell reads variables with env, printenv, set, export, jq, the registry, or its text.
// A pwsh $env:NAME = value sets one variable. It is not a read. == is a test, so it stays.
const ENV_ASSIGN = /^\$\{?env:\w+\}?\s*=(?!=)/i;

// Removes $env:NAME = at the start of a statement. In echo "$env:KEY=" the = is text and the read stays.
function stripEnvAssign(src) {
  let out = "";
  let quote = "";
  let start = true;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = "";
      out += c;
      continue;
    }
    if (start) {
      const m = ENV_ASSIGN.exec(src.slice(i));
      if (m) {
        out += " ";
        i += m[0].length - 1;
        start = false;
        continue;
      }
    }
    if (c === "'" || c === '"') quote = c;
    if (c === ";" || c === "\n" || c === "&" || c === "|" || c === "(" || c === "{") start = true;
    else if (c !== " " && c !== "\t") start = false;
    out += c;
  }
  return out;
}

// cmd.exe words that take a command next, and words with a condition before the command.
const CMD_NEXT = new Set(["call", "do", "/c", "/k", "/r"]);
const CMD_ANY = new Set(["if", "start", "else"]);

// The segment as the shell reads the command name, and each command that follows a starter.
function commandLists(words) {
  const first = firstWord(words);
  const lists = [first];
  first.forEach((w, k) => {
    const t = w.text.toLowerCase();
    if (CMD_NEXT.has(t)) lists.push(firstWord(first.slice(k + 1)));
    else if (CMD_ANY.has(t)) for (let j = k + 1; j < first.length; j++) lists.push(firstWord(first.slice(j)));
  });
  return lists;
}

const envLists = (words) => commandLists(words).some(envSegment);

function readsEnvironment(source) {
  const src = stripEnvAssign(source);
  for (const text of [src, bashRead(src)]) {
    const t = text.replace(/\\/g, "/");
    if (ENV_TEXT.some((re) => re.test(t)) || (ENV_HIVE.test(t) && /environment/i.test(t))) return true;
    if (tokenize(text).some(envLists)) return true;
    // A backtick or a string join hides the name: Env`: and ('En'+'v:').
    if (tokenize(unquote(text)).some(envLists)) return true;
  }
  return false;
}
const TOKEN_TEXT = /(tokens|secrets)[\w.*-]*\.json/i;
// The stem agent-lo also catches a glob of the folder name, as in .agent-lo*.
const LOUNGE_TEXT = /agent-lo|~\d/i;

const DELETE_VERBS = new Set(["remove-item", "rm", "ri", "del", "erase", "rd", "rmdir", "rimraf"]);
const ALWAYS_RECURSIVE = new Set(["rimraf"]);
const CMD_VERBS = new Set(["del", "erase", "rd", "rmdir"]);
// cmd.exe runs these when a switch or path touches the name, as in rd/s/q.
const CMD_BUILTINS = new Set([
  "cd", "chdir", "pushd", "popd", "rd", "rmdir", "del", "erase", "md", "mkdir", "type", "dir", "copy", "move",
  "ren", "rename", "echo", "set", "findstr", "find", "more", "start", "cmd",
]);
const CD_VERBS = new Set(["cd", "chdir", "set-location", "sl", "pushd", "push-location"]);
const POP_VERBS = new Set(["popd", "pop-location"]);
const MOVE_VERBS = new Set(["mv", "move", "move-item", "mi", "rename-item", "ren", "rni", "rename"]);
const WRITE_VERBS = new Set([
  "set-content", "sc", "add-content", "ac", "out-file", "clear-content", "clc", "copy-item", "copy", "cpi",
  "cp", "new-item", "ni", "tee", "tee-object", "xcopy", "install", "ln", "new-symlink",
]);
const SKIP_VALUE =
  /^-(filter|include|exclude|credential|stream|depth|erroraction|ea|errorvariable|ev|warningaction|wa|warningvariable|wv|informationaction|infa|outvariable|ov|value|encoding|itemtype|type)$/i;
const SCRIPT = /\.(ps1|psm1|sh|bash|bat|cmd)$/i;
const MAX_SCRIPT = 256 * 1024;
const SHELLS = new Set(["pwsh", "powershell", "bash", "sh", "zsh", "dash", "cmd", "wsl", "start-process", "saps", "start"]);
const DYNAMIC = /[$`%@()]/;

/** Map a runtime tool call to a guard action. */
export function toAction(tool, input, cwd) {
  const args = input && typeof input === "object" ? input : {};
  const str = (k) => (typeof args[k] === "string" ? args[k] : undefined);
  const base = { tool: String(tool), input: args };
  if (cwd) base.cwd = cwd;
  switch (tool) {
    case "Bash":
    case "PowerShell":
    case "pwsh":
    case "bash":
      return { ...base, kind: "shell", command: str("command") ?? "" };
    case "terminal_send":
      return { ...base, kind: "shell", command: str("text") ?? "" };
    case "Write":
      return { ...base, kind: "write", path: str("file_path") ?? "", content: str("content") ?? "" };
    case "Edit":
      return { ...base, kind: "write", path: str("file_path") ?? "", content: str("new_string") ?? "" };
    case "MultiEdit": {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const content = edits.map((e) => (e && typeof e.new_string === "string" ? e.new_string : "")).join("\n");
      return { ...base, kind: "write", path: str("file_path") ?? "", content };
    }
    case "NotebookEdit":
      return { ...base, kind: "write", path: str("notebook_path") ?? "" };
    case "apply_patch": {
      const texts = [str("input"), str("patch")].filter((t) => t !== undefined);
      const header = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
      const paths = [...new Set(texts.flatMap((t) => [...t.matchAll(header)].map((m) => m[1].trim())))];
      // Two different texts: which one runs?
      const known = /^\s*\*\*\* (?:(?:Add|Update|Delete) File|Move to): |^\s*\*\*\* (?:Begin Patch|End Patch|End of File)\s*$/;
      // An odd *** line may name a path we miss.
      const odd = texts.some((t) => t.split(/\r?\n/).some((l) => /^\s*\*\*\*/.test(l) && !known.test(l)));
      const split = new Set(texts).size > 1 || odd;
      return { ...base, kind: "patch", paths, content: texts[0] ?? "", ...(split ? { ambiguous: true } : {}) };
    }
    case "write":
    case "edit":
    case "str_replace_editor": {
      const content = str("content") ?? str("file_text") ?? str("new_str") ?? "";
      return { ...base, kind: "write", path: str("path") ?? str("file_path") ?? "", content };
    }
    case "Read":
    case "read":
    case "read_image":
      return { ...base, kind: "read", path: str("file_path") ?? str("path") ?? "" };
    case "Glob":
    case "Grep": {
      const glob = [str("pattern"), str("glob")].filter(Boolean).join(" ");
      return { ...base, kind: "read", path: str("path") ?? "", glob };
    }
    default:
      return { ...base, kind: "other" };
  }
}

function options(opts = {}) {
  const home = opts.home ?? homedir();
  const tmp = opts.tmp ?? tmpdir();
  return {
    home,
    tmp,
    projectsRoot: opts.projectsRoot ?? home,
    loungeHome: opts.loungeHome ?? win32.join(home, ".agent-lounge"),
    driveExists: opts.driveExists ?? defaultDriveExists,
    // Counts the cmd.exe deletes the rules read, for the backstop.
    deletesJudged: 0,  };
}

/** The stronger of two verdicts. */
export function stronger(a, b) {
  // A floor block beats an askable block.
  if (a.verdict === "block" && b.verdict === "block" && Boolean(a.askable) !== Boolean(b.askable)) {
    return a.askable ? b : a;
  }
  return RANK[b.verdict] > RANK[a.verdict] ? b : a;
}

// An askable block waits for a floor block.
const settled = (v) => v.verdict === "block" && !v.askable;

// Shell text is never askable.
// Only a file tool path is parsed fully.
function sealed(v) {
  if (!v.askable) return v;
  const { askable, ...floor } = v;
  return floor;
}

// A reassigned variable loses its value.
function taintVars(src, o) {
  o.taint ??= new Set();
  for (const [re, group] of [[AUTO_ASSIGN, 1], [AUTO_SET, 3], [AUTO_LOOP, 1]]) {
    for (const m of src.matchAll(new RegExp(re.source, "gi"))) o.taint.add(m[group].toLowerCase());
  }
}

const ALLOW = Object.freeze({ verdict: "allow" });

/** Judge one action. */
export function judge(action, opts) {
  const o = options(opts);
  if (!action || typeof action !== "object") return { verdict: "block", reason: "the guard got no action" };
  if (action.kind === "shell") return sealed(judgeShell(String(action.command ?? ""), action.cwd, o, 0));
  if (action.kind === "write") {
    return judgeWrite(String(action.path ?? ""), String(action.content ?? ""), action.cwd, o);
  }
  if (action.kind === "patch") {
    let out = ALLOW;
    // An unresolved path may hide a floor write.
    let unsure = action.ambiguous === true;
    for (const p of Array.isArray(action.paths) ? action.paths : []) {
      const w = judgeWrite(String(p), "", action.cwd, o);
      if (w.verdict === "ask") unsure = true;
      out = stronger(out, w);
    }
    return unsure ? sealed(out) : out;
  }
  if (action.kind === "read") {
    return judgeRead(String(action.path ?? ""), String(action.glob ?? ""), action.cwd, o, action.glob !== undefined);
  }
  return ALLOW;
}

// ---- paths ----

// Short names and links point to the real folder.
function realPrefix(full) {
  let head = full;
  const tail = [];
  while (head.length > 3 && !existsSync(head)) {
    tail.unshift(win32.basename(head));
    head = win32.dirname(head);
  }
  try {
    const real = realpathSync.native(head);
    return tail.length ? win32.join(real, ...tail) : real;
  } catch {
    return full;
  }
}

// Windows form, lower case, no trailing slash.
export function normPath(raw, cwd, home, tmp) {
  let p = String(raw).trim().replace(/^(['"])(.*)\1$/, "$2");
  // The PowerShell provider prefix names the same file as the plain path.
  p = p.replace(/^(microsoft\.powershell\.core[\\/])?filesystem::/i, "");
  if (p === "") return undefined;
  // A device prefix goes only before a drive letter.
  // A UNC or other device path has no drive form to judge.
  p = p.replace(/^[\\/]{2}[?.][\\/](?=[a-zA-Z]:)/, "");
  if (/^[\\/]{2}/.test(p)) return undefined;
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = (home ?? homedir()) + p.slice(1);
  const tmpMount = /^\/tmp(\/|$)(.*)$/.exec(p);
  if (tmpMount) p = `${tmp ?? tmpdir()}\\${tmpMount[2] ?? ""}`;
  const mount = /^\/mnt\/([a-zA-Z])(\/|$)(.*)$/.exec(p) ?? /^\/([a-zA-Z])(\/|$)(.*)$/.exec(p);
  if (mount) p = `${mount[1]}:\\${mount[3] ?? ""}`;
  if (p === "/") p = "C:\\";
  if (/^[a-zA-Z]:$/.test(p)) p += "\\";
  p = p.replace(/\//g, "\\");
  if (!win32.isAbsolute(p) || /^\\[^\\]/.test(p)) {
    if (!cwd) return undefined;
    p = win32.resolve(normPath(cwd, undefined, home, tmp) ?? cwd, p);
  }
  // Windows drops trailing dots and spaces.
  let full = win32
    .resolve(p)
    .split("\\")
    .map((seg, i) => (i === 0 || seg === "." || seg === ".." ? seg : seg.replace(/[. ]+$/, "")))
    .join("\\");
  full = realPrefix(win32.resolve(full)).toLowerCase();
  if (full.length > 3) full = full.replace(/\\+$/, "");
  return full;
}

function inside(child, parent) {
  if (child === parent) return true;
  const base = parent.endsWith("\\") ? parent : parent + "\\";
  return child.startsWith(base);
}

function norm(raw, cwd, o) {
  return normPath(raw, cwd, o.home, o.tmp);
}

function protectedRoots(o) {
  return [
    norm(o.home, undefined, o),
    "c:\\users",
    "c:\\windows",
    "c:\\program files",
    "c:\\program files (x86)",
    "c:\\programdata",
    norm(o.projectsRoot, undefined, o),
    norm(o.loungeHome, undefined, o),
  ].filter(Boolean);
}

function isDriveRoot(p) {
  return /^[a-z]:\\?$/.test(p);
}

function hardTarget(p, o) {
  if (isDriveRoot(p)) return "a drive root";
  for (const root of protectedRoots(o)) {
    if (inside(root, p)) return root;
  }
  return undefined;
}

function inScratch(p, o) {
  const tmp = norm(o.tmp, undefined, o);
  if (tmp && inside(p, tmp) && p !== tmp) return true;
  return p.split("\\").slice(1).some((seg) => SCRATCH.has(seg));
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Known variables become literal paths.
function expandVars(text, o) {
  const vars = {
    home: o.home,
    userprofile: o.home,
    temp: o.tmp,
    tmp: o.tmp,
    tmpdir: o.tmp,
    systemdrive: "C:",
    homedrive: "C:",
    windir: "C:\\Windows",
    systemroot: "C:\\Windows",
    programfiles: "C:\\Program Files",
    programdata: "C:\\ProgramData",
    appdata: win32.join(o.home, "AppData", "Roaming"),
    localappdata: win32.join(o.home, "AppData", "Local"),
  };
  const sub = (whole, name) => (o.taint?.has(name.toLowerCase()) ? whole : (vars[name.toLowerCase()] ?? whole));
  return text
    .replace(/\$\{(?:env:)?(\w+)\}/gi, sub)
    .replace(/\$(?:env:)?(\w+)/gi, sub)
    .replace(/%(\w+)%/g, sub);
}

// ---- shell ----

function stripQuoted(src) {
  return src.replace(/'[^']*'|"(?:[^"\\`]|[\\`].)*"/g, " ");
}

function unquote(src) {
  return src.replace(/['"`^]/g, "").replace(/\s*\+\s*/g, "");
}

function tokenize(src) {
  const segments = [];
  let words = [];
  let word = "";
  let started = false;
  let dynamic = false;
  // A comma outside quotes makes a PowerShell array. A comma inside quotes is text.
  let comma = false;
  let quote = "";
  const endWord = () => {
    if (started) words.push({ text: word, dynamic, comma });
    word = "";
    started = false;
    dynamic = false;
    comma = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote) {
        quote = "";
        continue;
      }
      if (quote === '"' && (c === "$" || c === "`")) dynamic = true;
      word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      const end = src.indexOf("}", i);
      if (end > i) {
        word += src.slice(i, end + 1);
        dynamic = true;
        started = true;
        i = end;
        continue;
      }
    }
    // Blocks and groups hold commands of their own.
    if (c === "\n" || c === "\r" || c === ";" || c === "|" || c === "&" || "{}()".includes(c)) {
      if (c === "(" || c === "{") dynamic = dynamic || started;
      endSeg();
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === "$" || c === "`" || c === "%" || c === "@") dynamic = true;
    if (c === ",") comma = true;
    word += c;
    started = true;
  }
  endSeg();
  return segments;
}

function verbOf(token) {
  return win32.basename(token.text.replace(/\//g, "\\")).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

const LEAD_WORDS = new Set([".", "&", "@", "builtin", "command"]);
const BUILTIN_HEAD = /^([A-Za-z]+)(?:\.(?:exe|com|bat|cmd))?([\\/.].*)$/;
const PROGRAM_EXT = /^\.(exe|com|bat|cmd|ps1|psm1|sh|bash)$/i;
const PLAIN_WORD = /^[\w.\\/:-]+$/;
// The word before a command in cmd.exe: a run switch, or a keyword that takes a command.
const CMD_STARTERS = /^(\/[ckr]|do|else|call)$/i;

// rd/s/q is the word rd and the switches /s/q. A path such as ./rd/x stays one word.
function splitBuiltin(word) {
  // A script path such as dir/x.sh runs as a script.
  if (SCRIPT.test(word.text)) return [word];
  const m = BUILTIN_HEAD.exec(word.text);
  if (!m ||!CMD_BUILTINS.has(m[1].toLowerCase())) return [word];
  if (PROGRAM_EXT.test(m[2]) || /^[\\/]+$/.test(m[2])) return [word];
  return [{ text: m[1], dynamic: false }, { text: m[2], dynamic: word.dynamic }];
}

// /crd is the switch /c and the command rd. Any quote around the command goes.
function splitRunSwitch(word) {
  const m = /^\/([ckr])(.+)$/i.exec(word.text);
  if (!m) return [word];
  return [{ text: `/${m[1]}`, dynamic: false }, { text: m[2].replace(/^"|"$/g, ""), dynamic: word.dynamic }];
}

// The words of a segment as the shell reads the command name.
function firstWord(words) {
  let rest = words;
  while (rest.length > 0) {
    const head = rest[0];
    if (LEAD_WORDS.has(head.text.toLowerCase())) {
      rest = rest.slice(1);
    } else if (head.text.length > 1 && head.text.startsWith("@")) {
      const text = head.text.slice(1);
      rest = [{ text, dynamic: head.dynamic && !PLAIN_WORD.test(text) }, ...rest.slice(1)];
    } else {
      return [...splitBuiltin(head), ...rest.slice(1)];
    }
  }
  return rest;
}

const RECURSE = /^-r(e(c(u(r(s(e)?)?)?)?)?)?(:\$?true)?$/i;

function isRecurseFlag(text, cmdStyle) {
  if (/^--recursive$/i.test(text) || RECURSE.test(text)) return true;
  if (/^-[rRfvidI]+$/.test(text) && /[rR]/.test(text)) return true;
  return cmdStyle && /^(\/[sqfap])+$/i.test(text) && /\/s/i.test(text);
}

function judgeScript(word, cwd, o, depth) {
  if (word.dynamic) return { verdict: "ask", reason: `it runs a script from a variable: ${word.text}` };
  const p = norm(word.text, cwd, o);
  if (!p) return { verdict: "ask", reason: `it runs a script the guard cannot find: ${word.text}` };
  let text;
  try {
    if (statSync(p).size > MAX_SCRIPT) return { verdict: "ask", reason: `it runs a script too large to read: ${p}` };
    text = readFileSync(p, "utf8");
  } catch (err) {
    // A shell script may be written earlier in this command.
    // Code text is checked by CODE_DELETE instead.
    if (err && err.code === "ENOENT") {
      if (CODE_FILE.test(p)) return ALLOW;
      return { verdict: "ask", reason: `it runs a script that does not exist yet: ${p}` };
    }
    return { verdict: "ask", reason: `it runs a script the guard cannot read: ${p}` };
  }
  if (CODE_FILE.test(p)) return judgeCode(text, p);
  const v = judgeShell(text, win32.dirname(p), o, depth + 1);
  return v.verdict === "allow" ? v : { verdict: v.verdict, reason: `script ${p}: ${v.reason}` };
}

function judgeCode(text, where) {
  if (CODE_DELETE.test(text) && CODE_ROOT.test(text)) {
    return { verdict: "ask", reason: `${where} deletes folders near a root or home path` };
  }
  return ALLOW;
}

// Literal targets, with variables expanded and lists split.
function literal(word, o) {
  const text = word.dynamic ? expandVars(word.text, o) : word.text;
  return { text, dynamic: DYNAMIC.test(text) };
}

function splitList(words) {
  const out = [];
  for (const w of words) {
    for (const part of w.text.split(",")) if (part !== "") out.push({ text: part, dynamic: w.dynamic });
  }
  return out;
}

function judgeDeleteTargets(targets, cwd, o, what, recursive) {
  let out = ALLOW;
  if (recursive && targets.length === 0) {
    o.unseen = true;
    return { verdict: "ask", reason: `${what} with no literal target` };
  }
  for (const t0 of splitList(targets)) {
    const t = literal(t0, o);
    if (t.dynamic) {
      o.unseen = true;
      if (recursive) out = stronger(out, { verdict: "ask", reason: `${what} with a variable target: ${t0.text}` });
      continue;
    }
    let raw = t.text.replace(/^[\\/]{2}[?.][\\/]/, "");
    const wild = /[*?[\]]/;
    const parts = raw.replace(/\//g, "\\").split("\\");
    const wildLeaf = wild.test(parts.at(-1) ?? "");
    if (parts.slice(0, -1).some((s) => wild.test(s))) {
      o.unseen = true;
      if (recursive) out = stronger(out, { verdict: "ask", reason: `${what} with a wildcard folder: ${raw}` });
      continue;
    }
    if (wildLeaf) {
      const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
      raw = cut < 0 ? "." : cut === 0 ? raw[0] : raw.slice(0, cut);
    }
    const p = norm(raw, cwd, o);
    if (!p) {
      o.unseen = true;
      if (recursive) out = stronger(out, { verdict: "ask", reason: `${what} of a relative path with no known folder: ${t.text}` });
      continue;
    }
    const hard = hardTarget(p, o);
    if (hard && (recursive || wildLeaf)) {
      const verdict = recursive ? "block" : "ask";
      out = stronger(out, { verdict, reason: `${what} of ${t.text} would remove ${hard}` });
      if (verdict === "block") return out;
      continue;
    }
    const w = judgeWrite(p, "", undefined, o);
    if (w.verdict !== "allow") {
      out = stronger(out, viaWrite(w, what));
      continue;
    }
    if (recursive && !inScratch(p, o) && !isFile(p)) {
      out = stronger(out, { verdict: "ask", reason: `${what} outside a scratch folder: ${p}` });
    }
  }
  return out;
}

// Flags drop out; the rest are targets.
function operands(rest, cmdStyle) {
  let recursive = false;
  const targets = [];
  let ended = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (!ended && w.text === "--") {
      ended = true;
      continue;
    }
    if (!ended && /^-[\w-]+(:.*)?$/.test(w.text)) {
      if (isRecurseFlag(w.text, cmdStyle)) recursive = true;
      else if (SKIP_VALUE.test(w.text)) i++;
      continue;
    }
    if (cmdStyle && /^(\/[sqfap])+$/i.test(w.text)) {
      if (isRecurseFlag(w.text, true)) recursive = true;
      continue;
    }
    if (/^\/\w$/.test(w.text) && cmdStyle) continue;
    targets.push(w);
  }
  return { recursive, targets };
}

const PUSH_RISKY = ["force", "force-with-lease", "force-if-includes", "mirror", "delete"];
const PROTECTED_BRANCH = /^(main|master)$/i;
// A database CLI that is given a drop of a whole database or schema.
const DB_CLIS = new Set(["psql", "mysql", "sqlite3", "sqlcmd"]);
const DROP_DATABASE = /\bdrop\s+(database|schema)\b/i;
const branchOf = (ref) => ref.replace(/^refs\/heads\//i, "");

// A long option may be cut short while it stays unique, as in --forc.
const longOption = (text, names) => {
  const name = text.split("=")[0].slice(2);
  return text.startsWith("--") && name.length >= 2 && names.some((full) => full.startsWith(name));
};

// Pushes and branch edits that touch main or master.
function gatedGit(sub, args) {
  const words = args.filter((w) => w.text !== "--");
  const flags = words.filter((w) => w.text.startsWith("-") && w.text !== "-");
  const operands = words.filter((w) => !flags.includes(w));
  if (sub === "push") {
    const risky = flags.some((w) => longOption(w.text, PUSH_RISKY) || /^-[a-z]*[fd][a-z]*$/i.test(w.text));
    if (risky) return { verdict: "block", reason: "git push forces, mirrors, or deletes refs" };
    const specs = operands.slice(1).map((w) => w.text);
    if (specs.some((s) => s.startsWith("+"))) return { verdict: "block", reason: "git push forces a refspec" };
    if (specs.some((s) => PROTECTED_BRANCH.test(branchOf(s.slice(s.lastIndexOf(":") + 1))))) {
      return { verdict: "block", reason: "git push targets main or master" };
    }
  }
  if (sub === "reset" && flags.some((w) => longOption(w.text, ["hard"]))) {
    return { verdict: "block", reason: "git reset --hard discards work" };
  }
  if (sub === "branch") {
    const edits = flags.some((w) => longOption(w.text, ["delete", "move"]) || /^-[a-z]*[dm][a-z]*$/i.test(w.text));
    if (edits && operands.some((w) => PROTECTED_BRANCH.test(branchOf(w.text)))) {
      return { verdict: "block", reason: "git branch deletes or renames main or master" };
    }
  }
  return undefined;
}

function judgeGit(rest, cwd, o) {
  let here = cwd;
  let i = 0;
  for (; i < rest.length; i++) {
    const t = rest[i].text;
    if (t === "-C" && rest[i + 1]) {
      here = rest[i + 1].dynamic ? undefined : norm(rest[i + 1].text, here, o);
      i++;
    } else if (t === "-c" || t === "--git-dir" || t === "--work-tree") i++;
    else if (!t.startsWith("-")) break;
  }
  const sub = rest[i]?.text.toLowerCase();
  const args = rest.slice(i + 1);
  const gated = gatedGit(sub, args);
  if (gated) return gated;
  if (sub !== "clean" || !args.some((w) => /^-\w*f/.test(w.text) || w.text === "--force")) return ALLOW;
  if (here && inScratch(here, o)) return ALLOW;
  if (here && hardTarget(here, o) === "a drive root") return { verdict: "ask", reason: "git clean at a drive root" };
  return { verdict: "ask", reason: "git clean deletes untracked files" };
}

// The command that starts at words[0].
function judgeCommand(words, cwd, o, depth, start) {
  const verb = verbOf(words[0]);
  // cmd /crd and cmd /c"rd ..." glue the command to the switch.
  const isCmd = verb === "cmd" || verb === "%comspec%";
  const rest = isCmd ? words.slice(1).flatMap(splitRunSwitch) : words.slice(1);
  if (start && SCRIPT.test(words[0].text)) return judgeScript(words[0], cwd, o, depth);
  const args = rest.map((w) => w.text).join(" ");
  for (const [verbRe, argRe, reason] of SYSTEM) {
    if (verbRe.test(verb) && (!argRe || argRe.test(args))) return { verdict: "ask", reason: `it ${reason}` };
  }
  if (SHELLS.has(verb) || isCmd) {
    if (rest.length === 0) return ALLOW;
    const file = rest.findIndex((w) => /^-(f|fi|fil|file)$/i.test(w.text));
    if (file >= 0 && rest[file + 1]) return judgeScript(rest[file + 1], cwd, o, depth);
    const first = rest.find((w) => !/^[-/]/.test(w.text));
    if (first && SCRIPT.test(first.text) && !/\s/.test(first.text)) return judgeScript(first, cwd, o, depth);
    return judgeShell(args, cwd, o, depth + 1);
  }
  if (CODE_RUNNERS.has(verb)) {
    if (CODE_DELETE.test(args)) return { verdict: "ask", reason: "it deletes folders through code" };
    const file = rest.find((w) => CODE_FILE.test(w.text));
    return file ? judgeScript(file, cwd, o, depth) : ALLOW;
  }
  if (verb === "git") return judgeGit(rest, cwd, o);
  if (DB_CLIS.has(verb) && DROP_DATABASE.test(args)) return { verdict: "block", reason: "it drops a database" };
  if (verb === "robocopy" && rest.some((w) => /^\/(mir|purge|move|mov)$/i.test(w.text))) {
    const paths = rest.filter((w) => !w.text.startsWith("/"));
    const moved = rest.some((w) => /^\/(move|mov)$/i.test(w.text));
    const target = moved ? paths[0] : paths[1];
    return judgeDeleteTargets(target ? [target] : [], cwd, o, moved ? "robocopy move" : "robocopy mirror", true);
  }
  if (verb === "find" && rest.some((w) => w.text === "-delete" || /^-exec(dir)?$/.test(w.text))) {
    const exec = rest.findIndex((w) => /^-exec(dir)?$/.test(w.text));
    if (rest.some((w) => w.text === "-delete") || (exec >= 0 && DELETE_VERBS.has(verbOf(rest[exec + 1] ?? { text: "" })))) {
      const start = rest.find((w) => !w.text.startsWith("-"));
      return judgeDeleteTargets(start ? [start] : [], cwd, o, "find delete", true);
    }
    return ALLOW;
  }
  if (MOVE_VERBS.has(verb)) {
    // move /y and ren have cmd.exe switches. mv has none.
    const { targets } = operands(rest, verb === "move" || verb === "ren" || verb === "rename");
    let out = ALLOW;
    for (const t0 of splitList(targets)) {
      const t = literal(t0, o);
      const p = t.dynamic ? undefined : norm(t.text, cwd, o);
      if (!p) {
        o.unseen = true;
        continue;
      }
      const hard = hardTarget(p, o);
      if (hard) return { verdict: "block", reason: `a move of ${t.text} would remove ${hard}` };
      const w = judgeWrite(p, "", undefined, o);
      if (w.verdict !== "allow") out = stronger(out, viaWrite(w, "a move"));
    }
    return out;
  }
  if (WRITE_VERBS.has(verb)) return judgeShellWrites(operands(rest, false).targets, cwd, o, verb);
  if (!DELETE_VERBS.has(verb)) return ALLOW;
  const cmdStyle = CMD_VERBS.has(verb);
  if (cmdStyle) o.deletesJudged += 1;
  const { recursive, targets } = operands(rest, cmdStyle);
  return judgeDeleteTargets(targets, cwd, o, recursive || ALWAYS_RECURSIVE.has(verb) ? "recursive delete" : "delete", recursive || ALWAYS_RECURSIVE.has(verb));
}

function judgeShellWrites(targets, cwd, o, what) {
  let out = ALLOW;
  for (const t0 of splitList(targets)) {
    const t = literal(t0, o);
    const p = t.dynamic ? undefined : norm(t.text, cwd, o);
    if (!p) {
      o.unseen = true;
      continue;
    }
    const w = judgeWrite(p, "", undefined, o);
    if (w.verdict !== "allow") out = stronger(out, viaWrite(w, what));
  }
  return out;
}

// Redirect targets are writes.
function splitRedirects(words) {
  const kept = [];
  const targets = [];
  for (let i = 0; i < words.length; i++) {
    const m = /^(\d|\*)?>>?(.*)$/.exec(words[i].text);
    if (!m) {
      kept.push(words[i]);
      continue;
    }
    let target = m[2] ? { text: m[2], dynamic: words[i].dynamic } : words[i + 1];
    if (!m[2]) i++;
    if (target && !/^(&\d|\$null|nul|\/dev\/null)$/i.test(target.text)) targets.push(target);
  }
  return { kept, targets };
}

const READ_VERBS = new Set([
  "ls", "dir", "gci", "get-childitem", "cat", "type", "gc", "get-content", "head", "tail", "wc", "grep", "rg",
  "select-string", "sls", "findstr", "pwd", "get-location", "test-path", "resolve-path", "get-item", "gi", "stat",
  "du", "tree", "echo", "write-output", "sort", "uniq", "cut", "diff", "select-object", "measure-object",
  "get-command", "which", "jq", "find", "sed", "git", "tr", "more", "select",
]);
const SED_FLAG = /^-[nErsz]+$/;
// An address, then one print or delete command or one plain substitution.
const SED_SCRIPT = /^(\d+|\$)?(,(\d+|\$))?([pdqQlP=]|s\/[^/;{}\\]*\/[^/;{}\\]*\/[gpiI0-9]*)$/;

function sedReadOnly(args) {
  let script = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-e") {
      if (args[i + 1] === undefined || !SED_SCRIPT.test(args[i + 1])) return false;
      script = true;
      i++;
    } else if (a !== "-" && a.startsWith("-")) {
      if (!SED_FLAG.test(a)) return false;
    } else if (!script) {
      if (!SED_SCRIPT.test(a)) return false;
      script = true;
    }
  }
  return script;
}

// ---- the option allowlist ----
//
// A read-only command uses only options that are on this list. A list of unsafe options cannot be
// complete, so any option that is not here makes the command not read-only.
//
// letters    single-dash flags, as a cluster: -la. Every letter must be on the list.
// valued     single-dash letters with a value: a separate word (-n 5) or attached digits (-n5).
// digits     -<digits> is allowed (head -5).
// attached   a letter with attached digits only (git -U3).
// long       exact long flags. longValue: --name=value.
// words      PowerShell flags (-Recurse), any case. wordValue: PowerShell options with a value word.
// switches   cmd switches, one letter each (/b). switchValue: findstr /c:text.
// dashdash   a -- ends the options. maxOperands, noOperands, noWildcard limit the operands.
const GCI_OPTIONS = {
  words: ["name", "file", "directory", "recurse", "force"],
  wordValue: ["filter", "depth"],
};
// dir keeps the cmd switches. It is read-only only when the root folder \s does not exist.
const DIR_OPTIONS = { ...GCI_OPTIONS, switches: "bsaw" };
const GREP_VALUED = "eABCm";
const LOG_OPTIONS = {
  letters: "ps",
  valued: "n",
  digits: true,
  long: ["--oneline", "--stat", "--graph", "--decorate", "--all"],
  longValue: ["--format", "--pretty", "--since", "--until", "--author"],
  dashdash: true,
};
const OPTIONS = {
  ls: { letters: "1aAlhtrSdFR", long: ["--color"] },
  dir: DIR_OPTIONS,
  gci: GCI_OPTIONS,
  "get-childitem": GCI_OPTIONS,
  cat: { letters: "n" },
  type: { letters: "n" },
  gc: { words: ["raw"], wordValue: ["totalcount", "head", "tail"] },
  "get-content": { words: ["raw"], wordValue: ["totalcount", "head", "tail"] },
  head: { valued: "nc", digits: true },
  tail: { valued: "nc", digits: true },
  wc: { letters: "lwcm" },
  grep: { letters: "EFinlvcwxhHoqs", valued: GREP_VALUED, long: ["--color"] },
  rg: { letters: "inlvcwFSsxo", valued: GREP_VALUED, long: ["--files", "--no-heading", "--color"] },
  "select-string": { words: ["simplematch", "casesensitive", "notmatch", "list"], wordValue: ["pattern", "context"] },
  sls: { words: ["simplematch", "casesensitive", "notmatch", "list"], wordValue: ["pattern", "context"] },
  findstr: { switches: "invlrbexm", switchValue: true },
  pwd: {},
  "get-location": {},
  stat: {},
  which: {},
  "get-command": {},
  "test-path": {},
  "resolve-path": {},
  "get-item": {},
  gi: {},
  echo: {},
  "write-output": {},
  more: {},
  du: { letters: "sh", valued: "d" },
  tree: { switches: "fa" },
  sort: { letters: "rnuf" },
  uniq: { letters: "cdui", maxOperands: 1 },
  cut: { valued: "dfc" },
  tr: { letters: "dsc" },
  diff: { letters: "uqiwb", long: ["--color"] },
  "select-object": { wordValue: ["first", "last", "skip"] },
  select: { wordValue: ["first", "last", "skip"] },
  "measure-object": { words: ["line", "word", "character"] },
  jq: { letters: "rcSe" },
  find: {
    words: ["print"],
    wordValue: ["name", "iname", "type", "maxdepth", "mindepth", "path", "size", "mtime"],
    noWildcard: true,
  },
};
const GIT_SUBCOMMANDS = {
  status: { letters: "sb", long: ["--short", "--branch", "--porcelain"] },
  log: LOG_OPTIONS,
  shortlog: LOG_OPTIONS,
  diff: {
    letters: "s",
    attached: "U",
    long: ["--stat", "--name-only", "--name-status", "--cached", "--staged"],
    longValue: ["--format"],
    dashdash: true,
  },
  show: {
    letters: "s",
    attached: "U",
    long: ["--stat", "--name-only", "--name-status", "--cached", "--staged"],
    longValue: ["--format"],
    dashdash: true,
  },
  "rev-parse": { long: ["--show-toplevel", "--abbrev-ref", "--short", "--git-dir"] },
  "ls-files": { letters: "moc", long: ["--exclude-standard"] },
  blame: {},
  "merge-base": {},
  describe: { long: ["--tags"] },
  "cat-file": { letters: "pts" },
  branch: { letters: "arv", long: ["--show-current", "--list"], noOperands: true },
  remote: { letters: "v", noOperands: true },
  tag: { letters: "l", long: ["--list"], noOperands: true },
  "rev-list": { long: ["--count"] },
};

// The operands of a command whose options are all on the spec's list, else null.
function parseOptions(spec, args) {
  const operands = [];
  const needValue = (i) => i + 1 < args.length;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--" && spec.dashdash) {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const known = eq < 0 ? spec.long?.includes(a) : spec.longValue?.includes(a.slice(0, eq));
      if (!known) return null;
      continue;
    }
    if (a.startsWith("/") && a.length > 1 && (spec.switches || spec.switchValue)) {
      const one = a.length === 2 && spec.switches?.includes(a[1].toLowerCase());
      if (!one && !(spec.switchValue && /^\/c:./i.test(a))) return null;
      continue;
    }
    if (a.startsWith("/") && a.length > 1) return null;
    if (!a.startsWith("-") || a === "-") {
      operands.push(a);
      continue;
    }
    const body = a.slice(1);
    const key = body.toLowerCase();
    if (spec.words?.includes(key)) continue;
    if (spec.wordValue?.includes(key)) {
      if (!needValue(i)) return null;
      i++;
      continue;
    }
    if (spec.digits && /^\d+$/.test(body)) continue;
    if (spec.attached && body[0] === spec.attached && /^\d+$/.test(body.slice(1))) continue;
    if (!spec.letters && !spec.valued) return null;
    for (let j = 0; j < body.length; j++) {
      const c = body[j];
      if (spec.letters?.includes(c)) continue;
      if (spec.valued?.includes(c)) {
        const rest = body.slice(j + 1);
        if (rest === "") {
          if (!needValue(i)) return null;
          i++;
        } else if (!/^\d+$/.test(rest)) return null;
        break;
      }
      return null;
    }
  }
  return operands;
}

// git: the global options --no-pager, -P, and -C dir, then a subcommand with its own list.
// The global options of git, its subcommand, and the words after it.
function gitContext(args) {
  const dirs = [];
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === "--no-pager" || args[i] === "-P") continue;
    if (args[i] === "-C" && args[i + 1] !== undefined) {
      dirs.push(args[++i]);
      continue;
    }
    break;
  }
  return { dirs, sub: String(args[i] ?? "").toLowerCase(), rest: args.slice(i + 1) };
}

// The folder git works in: the cwd, moved by each -C.
function gitBase(dirs, cwd, o) {
  let base = cwd;
  for (const d of dirs) base = base ? norm(d, base, o) : undefined;
  return base;
}

// True when a .git is in the folder or above it. Outside a work tree, git diff compares two paths.
function inWorkTree(dir) {
  let at = dir;
  while (at) {
    if (existsSync(win32.join(at, ".git"))) return true;
    const up = win32.dirname(at);
    if (up === at) return false;
    at = up;
  }
  return false;
}

function gitOperands(args) {
  const { sub, rest } = gitContext(args);
  const spec = GIT_SUBCOMMANDS[sub];
  // %G in a format runs gpg.
  if (!spec || args.some((a) => /%G/.test(a) || /%G/.test(bashRead(a)))) return null;
  const operands = parseOptions(spec, rest);
  if (!operands || (spec.noOperands && operands.length > 0)) return null;
  return operands;
}

// True when the verb, every option, and the operands of the command are on the allowlist.
function verbReadOnly(verb, args, cwd, o) {
  if (verb === "sed") return sedReadOnly(args);
  const operands = verb === "git" ? gitOperands(args) : OPTIONS[verb] ? parseOptions(OPTIONS[verb], args) : null;
  if (!operands) return false;
  if (verb === "git") {
    const g = gitContext(args);
    if (g.sub === "diff" && !inWorkTree(gitBase(g.dirs, cwd, o))) return false;
  }
  const spec = OPTIONS[verb];
  if (spec?.maxOperands !== undefined && operands.length > spec.maxOperands) return false;
  // find reads a folder walk, so a wildcard operand lists names the guard cannot see.
  if (spec?.noWildcard && operands.some((a) => /[*?[]/.test(a))) return false;
  // diff of two folders compares their top-level files, dotfiles included.
  if (verb === "diff") {
    return operands.every((a) => {
      const p = norm(a, cwd, o);
      return Boolean(p) && isFile(p);
    });
  }
  return true;
}

// Only these characters can appear in a read-only command. Every other character is a shell
// feature that tokenize does not read the way a real shell does.
// ^ is here for git revisions such as HEAD^. Another verb with a ^ is not read-only.
const SAFE_CHARS = /^[A-Za-z0-9 ._/\\:=,+@%*?'"|;&>~^-]*$/;
// The only redirects allowed. They send output to the terminal or to nothing.
const SAFE_REDIRECT = /(^|\s)(2>&1|>\/dev\/null|2>\/dev\/null)(?=\s|$|[|;])/g;
const CARET_REVISION = /^[\w./~-]+(\^\d*)+$/;

// A single quote is not a quote in cmd.exe, so a single-quoted body holds plain name characters only.
function quotesClosed(src) {
  let quote = "";
  let body = "";
  for (const c of src) {
    if (quote) {
      if (c !== quote) {
        body += c;
        continue;
      }
      if (quote === "'" && !/^[A-Za-z0-9._/*?-]*$/.test(body)) return false;
      quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
      body = "";
    }
  }
  return quote === "";
}

// The text before the first | and after each | outside quotes.
function pipeChunks(src) {
  const parts = [""];
  let quote = "";
  for (const c of src) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "|") {
      parts.push("");
      continue;
    }
    parts[parts.length - 1] += c;
  }
  return parts;
}

// A PowerShell pipe hands objects, and so paths, to the next command. After a pipe only a filter
// of text may follow. It cannot turn its input into a path and read that path.
const TEXT_FILTERS = new Set([
  "head", "tail", "sort", "uniq", "wc", "cut", "tr", "grep", "rg", "findstr", "sls", "select-string", "more",
]);

// A text filter, or Select-Object with only -First, -Last, -Skip, and counts.
function pipeFilter(words) {
  const verb = verbOf(words[0]);
  if (TEXT_FILTERS.has(verb)) return true;
  if (verb !== "select-object" && verb !== "select") return false;
  return words.slice(1).every((w) => /^-(first|last|skip)$/i.test(w.text) || /^\d+$/.test(w.text));
}

// A drive or a PowerShell provider names a place outside the working folder.
const PROVIDER = /^([A-Za-z]|hk(cu|lm|cr|u|cc)|env|temp|variable|function|alias|cert|wsman|registry|filesystem):/i;
// Only these verbs take a cmd switch such as /s. Git bash reads /c, /d, and /e as whole drives.
const SWITCH_VERBS = new Set(["findstr", "sort", "tree", "dir"]);
const FORMAT_OPTION = /^--(format|pretty|date)=/;
// %NAME% and %NAME:a=b% are cmd.exe variables. Git uses %h, %an, and %h:%s for its own fields.
const VAR_REF = /%[^%\s:=]+(:[^%]*[=~][^%]*)?%/;
const NUMBER_LIST = /^[\d,+-]*$/;

function defaultDriveExists(letter) {
  try {
    return existsSync(`${letter}:\\`);
  } catch {
    return false;
  }
}

// A bare /x is a drive in git bash when that drive exists. A switch with a value, /c:text, is not.
function isSwitch(text, verb, driveExists, rootHas) {
  const m = /^\/([A-Za-z])(:|$)/.exec(text);
  if (!m || !SWITCH_VERBS.has(verb)) return false;
  if (m[2] === ":") return verb === "findstr";
  // pwsh and bash read dir /s as the folder \s, when it exists.
  return !driveExists(m[1]) && !(verb === "dir" && rootHas(m[1]));
}

// True when a piece of a word can name a place outside the working folder.
function leavesCwd(piece, switchWord) {
  if (piece === "" || switchWord) return false;
  if (/^[\\/~]/.test(piece) || PROVIDER.test(piece)) return true;
  if (piece.includes("::")) return true;
  return piece.split(/[\\/]/).includes("..");
}

// A word, or the value of an option, that is not a plain relative path.
function wordLeavesCwd(word, verb, driveExists, rootHas) {
  const text = word.text;
  if (text.includes("%") && !(verb === "git" && FORMAT_OPTION.test(text) && !VAR_REF.test(text))) return true;
  // A comma outside quotes makes an array of paths. A list of numbers, such as 10,20, is fine.
  if (word.comma && !NUMBER_LIST.test(text.replace(/^-[^-]/, ""))) return true;
  const sw = isSwitch(text, verb, driveExists, rootHas);
  const pieces = [[text, sw]];
  if (text.indexOf("=") >= 0) pieces.push([text.slice(text.indexOf("=") + 1), false]);
  if ((text.startsWith("-") || sw) && text.indexOf(":") >= 0) pieces.push([text.slice(text.indexOf(":") + 1), false]);
  // A short option can hold its value: -f/c/x.
  if (/^-[^-]/.test(text)) pieces.push([text.slice(2), false]);
  return pieces.some(([piece, switchWord]) => leavesCwd(piece, switchWord));
}

// The operand of a pwsh option such as -Path:value, else undefined.
function optionOperand(text) {
  const m = /^-[\w-]+:(.*)$/.exec(text);
  return m ? m[1] : undefined;
}

// Verbs that can write a file when a wildcard hands them a name that looks like an option or a second operand.
const WILDCARD_WRITERS = new Set(["uniq", "sed", "sort", "git", "rg"]);

// The positions of the sed script words: the first operand, or the word after each -e.
function sedScriptIndexes(args) {
  const out = new Set();
  let found = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-e") {
      out.add(i + 1);
      found = true;
      i++;
    } else if (args[i] === "-" || !args[i].startsWith("-")) {
      if (!found) out.add(i);
      found = true;
    }
  }
  return out;
}

// The command works inside its folder: the folder is not the lounge home or a parent of it.
function cwdContained(cwd, loungeHome) {
  if (!cwd) return false;
  const o = options({ loungeHome });
  const here = norm(cwd, undefined, o);
  const lounge = norm(o.loungeHome, undefined, o);
  return Boolean(here && lounge && !inside(lounge, here));
}

/**
 * True when every segment of the command only reads, and it cannot reach a path outside its folder.
 * A missing folder gives false. The options can hold driveExists(letter) for a test.
 */
export function readOnlyShell(command, cwd, loungeHome, opts = {}) {
  if (!cwdContained(cwd, loungeHome)) return false;
  const o = options({ loungeHome });
  const driveExists = opts.driveExists ?? defaultDriveExists;
  // A folder named \x in the root of the cwd drive.
  const root = win32.parse(norm(cwd, undefined, o) ?? "").root;
  const rootHas = opts.rootHas ?? ((letter) => root !== "" && existsSync(win32.join(root, letter)));
  const raw = String(command ?? "");
  // A backslash next to a quote reads differently in bash and in Windows shells.
  if (/\\['"]|['"]\\/.test(raw) || /\^['"]|['"]\^/.test(raw)) return false;
  const src = raw.replace(SAFE_REDIRECT, "$1");
  if (!SAFE_CHARS.test(src) || src.includes(">") || src.replace(/&&/g, "").includes("&")) return false;
  if (!quotesClosed(src)) return false;
  for (const tail of pipeChunks(src).slice(1)) {
    if (tokenize(tail).some((words) => !pipeFilter(words))) return false;
  }
  const segments = tokenize(src);
  if (segments.length === 0) return false;
  for (const words of segments) {
    const verb = verbOf(words[0]);
    const scripts = verb === "sed" ? sedScriptIndexes(words.slice(1).map((w) => w.text)) : new Set();
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      // A splat, @name, expands to words the guard cannot see.
      if (w.text.startsWith("@")) return false;
      // A caret escapes in cmd.exe and could hide a character. Only a git revision, HEAD^, uses it.
      if (w.text.includes("^") && !(verb === "git" && CARET_REVISION.test(w.text))) return false;
      // The sed script holds commas and slashes of its own. verbReadOnly checks the script.
      if (scripts.has(i - 1)) {
        if (w.text.includes("%") || bashRead(w.text).includes("%")) return false;
      } else if (wordLeavesCwd(w, verb, driveExists, rootHas) || wordLeavesCwd({ ...w, text: bashRead(w.text) }, verb, driveExists, rootHas)) {
        return false;
      }
      // Bash expands a wildcard before the verb runs. A planted file named -i or --output=x becomes an option.
      if (i > 0 && !scripts.has(i - 1) && WILDCARD_WRITERS.has(verb) && /[*?[]/.test(w.text)) return false;
    }
    // A path or a script suffix may name a program in the working folder.
    if (/[\\/]|\.(cmd|bat|com|ps1|sh)$/i.test(words[0].text)) return false;
    if (!READ_VERBS.has(verb)) return false;
    if (!verbReadOnly(verb, words.slice(1).map((w) => w.text), cwd, o)) return false;
  }
  return true;
}

function judgeSegment(words, cwd, o, depth) {
  const { kept, targets } = splitRedirects(words);
  let out = judgeShellWrites(targets, cwd, o, "a redirect");
  // After an if, the condition has no fixed length, so any word can start the command.
  const afterIf = kept.length > 0 && verbOf(kept[0]) === "if";
  // A wrapper such as sudo, env, xargs, or if puts the verb later.
  for (let i = 0; i < kept.length; i++) {
    // A glued built-in splits only where cmd.exe starts a command: cmd /c rd/s/q.
    // An argument such as git checkout rd/main stays one word.
    const starts = i === 0 || afterIf || CMD_STARTERS.test(kept[i - 1].text);
    const from = starts ? firstWord(kept.slice(i)) : kept.slice(i);
    if (from.length === 0) continue;
    out = stronger(out, judgeCommand(from, cwd, o, depth, i === 0));
    if (settled(out)) return out;
  }
  return out;
}

// The text names the lounge home by the word, by its path, or by its folder name.
function namesLounge(plain, o) {
  if (LOUNGE_TEXT.test(plain)) return true;
  const text = plain.toLowerCase().replace(/\//g, "\\");
  const typed = String(o.loungeHome).toLowerCase().replace(/\//g, "\\");
  const real = norm(o.loungeHome, undefined, o);
  if (text.includes(typed) || (real && text.includes(real))) return true;
  const base = win32.basename(real ?? typed);
  return base !== "" && text.split(/[\\\s;|&(),=<>]+/).includes(base);
}

function judgeShellText(src, cwd, o, depth) {
  if (depth > 4) return { verdict: "ask", reason: "the command nests too many shells to read" };
  let out = ALLOW;
  if (AUTO_ASSIGN.test(src) || AUTO_SET.test(src) || AUTO_LOOP.test(src)) {
    out = { verdict: "block", reason: "it assigns a PowerShell automatic variable such as $home" };
    taintVars(src, o);
  }
  if (HOME_ASSIGN.test(src)) out = stronger(out, { verdict: "ask", reason: "it changes HOME or USERPROFILE" });
  const plain = unquote(src);
  const ro = readOnlyShell(src, cwd, o.loungeHome, o);
  // The text rules read the command as bash and as a Windows shell would.
  // cmd.exe reads an unquoted ; , = as a space and drops ^, so the text rules read that form too.
  const cmdText = cmdReading(src);
  const texts = [...new Set([...readings(plain), ...(cmdText === src ? [] : readings(unquote(cmdText)))])];
  for (const text of texts) {
    for (const [re, verdict, reason, keep] of GUARD_TEXT) {
      if (ro && keep !== true && keep !== "ask") continue;
      if (re.test(text)) out = stronger(out, { verdict: ro && keep === "ask" ? "ask" : verdict, reason: `it ${reason}` });
    }
    const secret = sensitiveText(text);
    if (secret) out = stronger(out, { verdict: "ask", reason: `it reads a sensitive file: ${secret}` });
  }
  // The words after firstWord: cmd.exe runs findstr/s and @type as the verb alone.
  const readWords = (text) => tokenize(text).map(firstWord).filter((words) => words.length > 0);
  const segments = readWords(src);
  const cmdSegments = cmdText === src ? [] : readWords(cmdText);
  const allSegments = [...segments, ...cmdSegments];
  if (readsEnvironment(src)) out = stronger(out, { verdict: "ask", reason: "it reads environment variables" });
  // A bare short name such as ENV~1 reaches .env. Git revisions such as HEAD~1 are not names.
  const shorts = (list) => list.some((words) => verbOf(words[0]) !== "git" && words.some((w) => SHORT_NAME.test(w.text) || SHORT_NAME.test(optionOperand(w.text) ?? "")));
  if (shorts(allSegments) || shorts(readWords(bashRead(src)))) {
    out = stronger(out, { verdict: "ask", reason: "it uses a short 8.3 path name" });
  }
  if (listsIntoSearch(src) || allSegments.some((words) => searchesHidden(words, cwd, o))) {
    out = stronger(out, { verdict: "ask", reason: "it searches hidden files such as .env" });
  }
  if (allSegments.some(readsBareWildcard)) {
    out = stronger(out, { verdict: "ask", reason: "it reads files by a wildcard that can match .env" });
  }
  if (texts.some((text) => TOKEN_TEXT.test(text) && namesLounge(text, o))) {
    return { verdict: "block", reason: "it touches the lounge tokens or keys" };
  }
  const bare = stripQuoted(src);
  for (const [re, reason] of HIDDEN) {
    if (re.test(bare)) out = stronger(out, { verdict: "ask", reason: `it ${reason}` });
  }
  if (CODE_DELETE.test(src)) out = stronger(out, { verdict: "ask", reason: "it deletes folders through code" });
  // A cd earlier in the command moves later targets.
  const lounge = norm(o.loungeHome, undefined, o);
  const reach = { lounge: false, search: false, glob: false, named: false };
  // A pipe hands paths to the next command. A ; or && does not.
  const piped = pipeChunks(src).length > 1;
  const multi = segments.length > 1;
  const step = newStep(cwd);
  for (const words of segments) {
    const before = foldersOf(step);
    if (followCd(words, step, o)) {
      // The cd segment gets the same lounge-home check as any other segment.
      for (const folder of before) loungeReach(words, folder, lounge, o, reach, piped, false);
      continue;
    }
    const text = words.map((w) => w.text).join(" ");
    if (step.lost && TOKEN_TEXT.test(text)) {
      out = stronger(out, { verdict: "ask", reason: "it reads a token file after a cd the guard cannot follow" });
    }
    for (const folder of foldersOf(step)) {
      loungeReach(words, folder, lounge, o, reach, piped, step.lost && multi);
      // A relative name inside the lounge home needs no word of the home path.
      const at = folder ? norm(folder, undefined, o) : undefined;
      if (lounge && at && inside(at, lounge) && readings(text).some((t) => TOKEN_TEXT.test(t))) {
        return { verdict: "block", reason: "it touches the lounge tokens or keys" };
      }
      out = stronger(out, judgeSegment(words, folder, o, depth));
      if (settled(out)) return out;
    }
  }
  // A read of one named file is fine. A search, a pipe, or a wildcard can reach the token files.
  if (reach.named || (reach.lounge && (multi || reach.search || reach.glob))) {
    out = stronger(out, { verdict: "ask", reason: "it searches or expands inside the lounge home, where the tokens live" });
  }
  // cmd.exe reads ; , = as spaces and drops ^, so a delete can differ from the segments.
  const reading = cmdReading(src);
  if (reading === src) return out;
  const again = newStep(cwd);
  const judged = o.deletesJudged;
  for (const raw of tokenize(reading)) {
    const words = firstWord(raw);
    if (words.length === 0 || followCd(words, again, o)) continue;
    if (!CMD_VERBS.has(verbOf(words[0]))) continue;
    for (const folder of foldersOf(again)) {
      out = stronger(out, judgeSegment(words, folder, o, depth));
      if (settled(out)) return out;
    }
  }
  // The second reading is not a second command.
  o.deletesJudged = judged;
  return out;
}

const DELETE_WORD = /^(rd|rmdir|del|erase)(?=$|[\\/])/i;

// A last look for a cmd.exe delete that sits in a form the rules did not read.
function backstop(src, judged) {
  const plain = src.replace(/["'^@]/g, "");
  const words = plain.split(/[\s;,=&|()]+/).filter((w) => DELETE_WORD.test(w));
  if (words.length === 0) return undefined;
  if (/\bfor\s+\/\w/i.test(plain)) {
    return { verdict: "ask", reason: "a for loop runs a delete the guard cannot follow" };
  }
  if (words.length > judged && /\bif\b|\bstart\s+\/|\/[ckr]\S/i.test(plain)) {
    return { verdict: "ask", reason: "a delete sits in a form the guard cannot read" };
  }
  return undefined;
}

function judgeShell(src, cwd, o, depth) {
  const before = o.deletesJudged;
  const out = judgeShellText(src, cwd, o, depth);
  if (out.verdict !== "allow") return out;
  return backstop(src, o.deletesJudged - before) ?? out;
}

// The tracked folder, a folder the shell may have gone to instead, and the pushd stack.
function newStep(cwd) {
  return { here: cwd, alt: undefined, lost: false, stack: [] };
}

function foldersOf(step) {
  return step.alt === undefined ? [step.here] : [step.here, step.alt];
}

// The command text with the unquoted ; , = that cmd.exe reads as argument spaces.
// A piece after a ; joins the delete when it is one word or holds a wildcard.
function cmdReading(src) {
  const pieces = [""];
  let quoted = false;
  for (const c of src) {
    if (c === '"') quoted = !quoted;
    if (!quoted && c === "^") continue;
    if (!quoted && c === ";") pieces.push("");
    else pieces[pieces.length - 1] += !quoted && (c === "," || c === "=") ? " " : c;
  }
  let out = pieces[0];
  for (const piece of pieces.slice(1)) {
    const joins = /^[^\s&|(){}<>"']+$/.test(piece.trim()) || /[*?]/.test(piece);
    out += joins ? ` ${piece}` : `;${piece}`;
  }
  return out;
}const SEARCH_VERBS = new Set(["rg", "grep", "findstr", "select-string", "sls"]);
const CONTENT_VERBS = new Set([...SEARCH_VERBS, "cat", "type", "gc", "get-content", "head", "tail", "more", "find"]);

// The words after the verb.
function operandWords(words) {
  // cmd find takes a wildcard after a -name word as a file, so find tests every word.
  return words.slice(1);
}

// ls | sls X lists .env and searches it. The pipe hands every listed file to the search.
const PIPE_LISTERS = new Set(["ls", "dir", "gci", "get-childitem", "get-item", "gi", "resolve-path"]);
function listsIntoSearch(src) {
  const chunks = pipeChunks(src).map((chunk) => tokenize(chunk).map(firstWord).filter((words) => words.length > 0));
  for (let k = 1; k < chunks.length; k++) {
    const searches = chunks[k].some((words) => ["sls", "select-string"].includes(verbOf(words[0])));
    if (searches && chunks.slice(0, k).some((segs) => segs.some((words) => PIPE_LISTERS.has(verbOf(words[0]))))) return true;
  }
  return false;
}

// A recursive search, or one that does not skip hidden files, reads .env. Plain rg skips them.
function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// grep goes into folders with -r, -R, -d recurse, --directories=recurse, or --dereference-recursive.
function grepRecurses(arg, next) {
  if (/^-[^-]*[rR]/.test(arg) || /^--(rec|der)/.test(arg)) return true;
  const long = /^--di[a-z]*(?:=(.*))?$/.exec(arg);
  const short = long ? null : /^-[A-Za-z]*d(.*)$/.exec(arg);
  if (!long && !short) return false;
  const value = long ? (long[1] ?? next) : short[1] !== "" ? short[1] : next;
  return value !== "read" && value !== "skip";
}

// rg shows hidden files with -u, --hidden, --no-ignore, --unrestricted, -., or a glob that matches them.
function rgHidden(arg, next) {
  if (/^-[^-]*[u.]/.test(arg) || /^--(hidden|no-ignore|unrestricted|type-add)/.test(arg)) return true;
  // The file types sh and all select .env and skip the hidden-file filter.
  const type = /^--type(?:=(.*))?$/.exec(arg);
  const shortType = type ? null : /^-[A-Za-z]*t(.*)$/.exec(arg);
  if (type || shortType) {
    const kind = type ? (type[1] ?? next) : shortType[1] !== "" ? shortType[1] : next;
    if (kind === "sh" || kind === "all") return true;
  }
  const long = /^--i?glob(?:=(.*))?$/.exec(arg);
  const short = long ? null : /^-[A-Za-z]*g(.*)$/.exec(arg);
  if (!long && !short) return false;
  const value = long ? (long[1] ?? next) : short[1] !== "" ? short[1] : next;
  if (value === undefined) return false;
  return !/[A-Za-z0-9]/.test(value) || globSensitive(cleanPath(value), true) !== undefined;
}

function searchesHidden(words, cwd, o) {
  const verb = verbOf(words[0]);
  const args = words.slice(1).map((w) => w.text);
  if (verb === "grep") return args.some((a, i) => grepRecurses(a, args[i + 1]));
  if (verb === "rg") return args.some((a, i) => rgHidden(a, args[i + 1]));
  if (verb === "findstr") return args.some((a) => /^\/s$/i.test(a));
  if (verb === "diff") {
    if (args.some((a) => /^-[^-]*r/.test(a) || /^--rec/.test(a))) return true;
    // Two folders are compared by their top-level files, dotfiles included. A name that does not resolve may be one.
    return args.filter((a) => !a.startsWith("-")).some((a) => {
      const p = cwd ? norm(a, cwd, o) : undefined;
      return !p || !isFile(p);
    });
  }
  if (verb === "git") {
    const g = gitContext(args);
    const base = gitBase(g.dirs, cwd, o);
    // Outside a work tree, git diff runs as git diff --no-index.
    const noIndex = args.some((a) => /^--no-i/.test(a)) || (g.sub === "diff" && !(base && inWorkTree(base)));
    if (!noIndex) return false;
    // A name that is not an existing file may be a folder, or a wildcard that matches one.
    return g.rest.filter((a) => !a.startsWith("-")).some((a) => {
      const p = base ? norm(a, base, o) : undefined;
      return !p || !isFile(p);
    });
  }
  return false;
}

// PowerShell and cmd.exe match .env with * or *.*, so a leaf wildcard with no letter or digit can read it.
function readsBareWildcard(words) {
  if (!CONTENT_VERBS.has(verbOf(words[0]))) return false;
  return operandWords(words).some((w) => {
    const text = optionOperand(w.text) ?? (w.text.startsWith("-") ? "" : w.text);
    const leaf = text.split(/[\\/]/).at(-1) ?? "";
    // /? is the cmd.exe help switch.
    if (w.text === "/?") return false;
    if (/[*?]/.test(leaf) && !/[A-Za-z0-9]/.test(leaf)) return true;
    return WILD.test(text) && expandBraces(text).some((v) => globSensitive(cleanPath(v), true) !== undefined);
  });
}
const WALK_VERBS = new Set(["find", "tree", "du"]);
const LIST_VERBS = new Set(["ls", "dir", "gci", "get-childitem"]);
const SHORT_NAME = /^[^\s\\/:]{1,6}~\d/;

// A search or a walk goes into every folder below its start.
// Copy and archive verbs read every file below a folder they are given.
const COPY_VERBS = new Set([
  "cp", "copy", "copy-item", "cpi", "robocopy", "xcopy", "tar", "rsync", "scp", "compress-archive", "zip",
]);

// find runs a program on each file it finds. for /r and forfiles /s walk a folder and run a command.
function runsOnFiles(verb, args) {
  if (verb === "find") return args.some((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
  if (verb === "for") return args.some((a) => /^\/r$/i.test(a));
  if (verb === "forfiles") return args.some((a) => /^\/s$/i.test(a));
  return false;
}

function walksDown(verb, args) {
  if (SEARCH_VERBS.has(verb) || WALK_VERBS.has(verb) || verb === "diff" || COPY_VERBS.has(verb)) return true;
  if (runsOnFiles(verb, args)) return true;
  if (verb === "git" && args.includes("--no-index")) return true;
  return LIST_VERBS.has(verb) && args.some((a) => /^-r|^-depth$|^-[a-z]*R|^\/s$/i.test(a));
}

// Notes whether a segment can reach a folder of the lounge home. This runs for every command.
// A folder above the home counts when the segment walks down from it, or when a pipe follows:
// a PowerShell pipe hands its paths to the next cmdlet, which can walk down from them.
function loungeReach(words, here, lounge, o, reach, piped, lost) {
  if (!lounge) return;
  const verb = verbOf(words[0]);
  const args = words.slice(1).map((w) => w.text);
  const deep = walksDown(verb, args) || piped;
  const within = (p) =>
    p && inside(p, lounge) && !inside(p, win32.join(lounge, "attachments")) && !inside(p, win32.join(lounge, "skills"));
  const above = (p) => p && p !== lounge && inside(lounge, p);
  const start = here ? norm(here, undefined, o) : undefined;
  // A folder the guard lost track of may be the home folder or above it.
  let touched = within(start) || (deep && above(start)) || Boolean(lost);
  for (const w of words.slice(1)) {
    let text = w.text;
    if (w.dynamic) {
      // A known variable such as $HOME becomes a path.
      const t = literal(w, o);
      if (t.dynamic) continue;
      text = t.text;
    }
    // The value of an option, --from-file=path or -Path:path, is a path.
    if (text.startsWith("-")) {
      const at = text.search(/[=:]/);
      if (at < 0) continue;
      text = text.slice(at + 1);
    }
    // A PowerShell array, a,b, holds several paths. Bash drops a backslash, so both forms count.
    for (const part0 of [...new Set([text, bashRead(text)])].flatMap((form) => form.split(","))) {
      // ~name is the home folder of another user: a sibling of this home.
      const part = part0.replace(/^~([^\\/]+)/, (_, name) => win32.join(win32.dirname(o.home), name));
      const star = part.search(/[*?[]/);
      const head = star < 0 ? part : part.slice(0, star);
      const cut = Math.max(head.lastIndexOf("/"), head.lastIndexOf("\\"));
      const dir = star < 0 ? part : cut < 0 ? "." : cut === 0 ? head[0] : head.slice(0, cut);
      const p = norm(dir, here, o);
      if (within(p)) {
        // cat ../notes.txt from attachments goes into the home folder.
        if (!within(start)) reach.named = true;
        if (star >= 0) reach.glob = true;
        if (star >= 0 || !isFile(p)) touched = true;
      } else if (above(p)) {
        // A wildcard in a folder name, such as ~/.imou*/t*, goes down too.
        const deepGlob = star >= 0 && /[\\/]/.test(part.slice(star));
        if (deepGlob) reach.glob = true;
        if (deep || deepGlob) touched = true;
      }
    }
  }
  if (!touched) return;
  reach.lounge = true;
  if (SEARCH_VERBS.has(verb) || verb === "diff" || COPY_VERBS.has(verb) || runsOnFiles(verb, args)) reach.search = true;
  if (verb === "git" && args.includes("--no-index")) reach.search = true;
}

// Move the tracked folder when the segment is a cd. Returns false for any other segment.
function followCd(words, step, o) {
  const r = cdTarget(words, step.here, o);
  if (!r.moved) return false;
  // A bare cd may stay or go home, so later segments are judged in both.
  if (r.alt !== undefined) {
    step.alt = r.alt;
    return true;
  }
  if (r.pop) {
    step.here = step.stack.pop();
  } else {
    if (r.push) step.stack.push(step.here);
    step.here = r.here;
  }
  step.alt = undefined;
  step.lost = step.here === undefined;
  return true;
}

// The folder after a cd, a drive switch, or a pop. An unknown folder is undefined.
function cdTarget(words, here, o) {
  const head = words[0].text;
  const drive = /^([A-Za-z]):$/.exec(head);
  if (drive && words.length === 1) return { moved: true, here: `${drive[1]}:\\` };
  const verb = verbOf(words[0]);
  if (POP_VERBS.has(verb)) return { moved: true, pop: true };
  if (!CD_VERBS.has(verb)) return { moved: false, here };
  const push = verb === "pushd" || verb === "push-location";
  // cd\ goes to the root of the current drive.
  if (/^[A-Za-z-]+[\\/]+$/.test(head)) {
    const at = here ? norm(here, undefined, o) : undefined;
    const root = at ? win32.parse(at).root : "";
    return { moved: true, push, here: root === "" ? undefined : root };
  }
  const targets = [];
  let switchD = false;
  for (const w of words.slice(1)) {
    if (/^(\d|\*)?[<>]/.test(w.text)) continue;
    if (w.text === "-") return { moved: true, push, here: undefined };
    // cd -Path:~\*-lounge names its target in the option.
    const named = /^-[\w-]+:(.+)$/.exec(w.text);
    if (named) {
      targets.push({ text: named[1], dynamic: w.dynamic });
      continue;
    }
    if (w.text.startsWith("-")) continue;
    if (/^\/d$/i.test(w.text)) {
      switchD = true;
      continue;
    }
    // cd /dC:\x is cd /d C:\x. A bash path such as /dev stays whole.
    const glued = /^\/d(?=[A-Za-z]:|[\\.~])/i.test(w.text);
    switchD = switchD || glued;
    targets.push({ text: glued ? w.text.slice(2) : w.text, dynamic: w.dynamic });
  }
  // A bare cd stays in cmd.exe and goes home in bash and PowerShell.
  if (targets.length === 0) return { moved: true, here, alt: o.home };
  // A name with spaces: the guard does not know where the shell went.
  if (targets.length !== 1) return { moved: true, push, here: undefined };
  const t = literal(targets[0], o);
  if (t.dynamic || /[*?[]/.test(t.text)) return { moved: true, push, here: undefined };
  const next = norm(t.text, here, o) ?? undefined;
  // cd and chdir in cmd.exe do not change the drive without /d.
  const cmdCd = verb === "cd" || verb === "chdir";
  if (cmdCd && !switchD && /^[A-Za-z]:/.test(t.text) && here && next) {
    const now = norm(here, undefined, o);
    if (now && now[0] !== next[0]) return { moved: true, push, here: undefined };
  }
  return { moved: true, push, here: next };}

// ---- files ----

// A shell write keeps the askable mark.
function viaWrite(w, what) {
  return { verdict: w.verdict, ...(w.askable ? { askable: true } : {}), reason: `${what}: ${w.reason}` };
}

// Home names that always block.
// They come from the core code:
// lounge.db, config.json, tokens.json,
// secrets.json, guard/, plugins/.
const FLOOR_TOP = /^(lounge\.db.*|guard|plugins)$/;
const FLOOR_ANY = /^(tokens|secrets|config|settings)(?![a-z0-9])/;

// A second link may reach a floor file.
function hardLinked(p) {
  try {
    const st = statSync(p);
    return st.isFile() && st.nlink > 1;
  } catch {
    return false;
  }
}

function loungeFloor(p, lounge) {
  if (p === lounge) return true;
  const rel = p.slice(lounge.length);
  if (sensitiveText(rel)) return true;
  // Windows ignores trailing dots, spaces,
  // and a stream suffix after a colon.
  const names = rel.slice(1).split("\\").map((seg) => seg.replace(/:.*$/, "").replace(/[. ]+$/, ""));
  // A wildcard may reach any floor name.
  if (names.some((n) => /[*?[]/.test(n) || /~\d/.test(n) || FLOOR_ANY.test(n))) return true;
  return FLOOR_TOP.test(names[0]) || hardLinked(p);
}

function judgeWrite(raw, content, cwd, o) {
  const p = norm(raw, cwd, o);
  if (!p) return { verdict: "ask", reason: `write to a path the guard cannot resolve: ${raw}` };
  const lounge = norm(o.loungeHome, undefined, o);
  if (lounge && inside(p, lounge)) {
    const out = { verdict: "block", reason: `write inside the lounge home: ${p}` };
    return loungeFloor(p, lounge) ? out : { ...out, askable: true };
  }
  if (/^[a-z]:\\[^\\]+$/.test(p)) return { verdict: "ask", reason: `write to a drive root: ${p}` };
  for (const root of ["c:\\windows", "c:\\program files", "c:\\program files (x86)", "c:\\programdata"]) {
    if (inside(p, root)) return { verdict: "ask", reason: `write to a system folder: ${p}` };
  }
  if (/\\\.claude\\settings[\w.-]*\.json$/.test(p)) {
    return { verdict: "ask", reason: `write to Claude settings, where the guard hook lives: ${p}` };
  }
  if (/\\guard\\(guard|rules)\.js$/.test(p)) return { verdict: "ask", reason: `write to the guard code: ${p}` };
  if (/\\\.agent-kit\\guard-relax(\\|$)/.test(p)) return { verdict: "ask", reason: `write to the guard relax markers: ${p}` };
  if (/\\profiles\\[^\\]+\\cordis[\w.-]*\.ya?ml$/.test(p)) return { verdict: "ask", reason: `write to a DSH profile: ${p}` };
  if (sensitiveText(p)) return { verdict: "ask", reason: `writes a sensitive file: ${p}` };
  if (/~\d/.test(p)) return { verdict: "ask", reason: `write through a short 8.3 name: ${p}` };
  // Judge a script when written, not only when run.
  if (SCRIPT.test(p) && content) {
    const v = judgeShell(content, win32.dirname(p), o, 1);
    if (v.verdict !== "allow") return { verdict: v.verdict, reason: `script ${p}: ${v.reason}` };
  }
  if (CODE_FILE.test(p) && content) return judgeCode(content, p);
  return ALLOW;
}

// A secret file asks in every mode. A lounge token still blocks first.
function judgeRead(raw, glob, cwd, o, search) {
  const lounge = judgeReadLounge(raw, glob, cwd, o, search);
  const named = [glob, raw, norm(raw, cwd, o)].map((t) => (t ? sensitiveText(t) : undefined)).find(Boolean);
  if (!named) return lounge;
  return stronger(lounge, { verdict: "ask", reason: `reads a sensitive file: ${named}` });
}

function judgeReadLounge(raw, glob, cwd, o, search) {
  if (glob && TOKEN_TEXT.test(glob)) return { verdict: "block", reason: `a search for token files: ${glob}` };
  // A search can reach the token files from the folder above them.
  if (search && glob && /\.agent-lounge/i.test(glob)) return { verdict: "ask", reason: `a search inside the lounge home: ${glob}` };
  const lounge = norm(o.loungeHome, undefined, o);
  // A search with no path starts at the working folder.
  const from = raw === "" ? (cwd ? norm(cwd, undefined, o) : undefined) : norm(raw, cwd, o);
  // A search from the home or from a folder above it reads the token files on its way down.
  const above = search && lounge && from && inside(lounge, from) && !inside(from, win32.join(lounge, "attachments"));
  if (raw === "") {
    return above ? { verdict: "ask", reason: `a search that starts at or above the lounge home: ${from}` } : ALLOW;
  }
  const p = from;
  if (!p) return { verdict: "ask", reason: `read of a path the guard cannot resolve: ${raw}` };
  if (/~\d/.test(p)) return { verdict: "ask", reason: `read through a short 8.3 name: ${p}` };
  if (above && !inside(p, lounge)) return { verdict: "ask", reason: `a search that starts above the lounge home: ${p}` };
  if (!lounge || !inside(p, lounge) || inside(p, win32.join(lounge, "attachments"))) return ALLOW;
  // Skills are text that the owner chose to share.
  if (inside(p, win32.join(lounge, "skills"))) return ALLOW;
  if (/\\(tokens|secrets)[\w.-]*$/.test(p)) return { verdict: "block", reason: `read of the lounge tokens or keys: ${p}` };
  // A search over the home folder reads the token files too.
  if (search && !isFile(p)) return { verdict: "ask", reason: `a search inside the lounge home: ${p}` };
  return ALLOW;
}
