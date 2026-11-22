import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { DEFAULT_HOST, loadConfig, type Caller } from "../config.ts";
import {
  MAX_HEALTH_CHALLENGE,
  addToken,
  callerForToken,
  ensureTokens,
  healthProof,
  revokeToken,
} from "../auth/tokens.ts";
import { openDb } from "../db/db.ts";
import { presence } from "../lounge/presence.ts";
import { Reachability } from "../lounge/reachability.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { LoungeError, Room, cleanNickname } from "../lounge/room.ts";
import { Events, eventText } from "../lounge/events.ts";
import { Threads } from "../lounge/threads.ts";
import { Children } from "../threads/children.ts";
import { Attachments, INLINE, MAX_ATTACHMENT, attachmentPath } from "../lounge/attachments.ts";
import { ProfileFiles } from "../lounge/files.ts";
import { readBoard } from "../blackboard/blackboard.ts";
import { bearerToken, createMcpHandler, reachableCallers } from "../mcp/server.ts";
import { sessionLog } from "../mcp/session-log.ts";
import { contentType, serveStatic } from "./static.ts";
import { HttpError } from "./http-error.ts";
import { revealDefault } from "../lounge/reveal.ts";
import { existsSync, readFileSync } from "node:fs";
import { Approvals } from "../guard/approvals.ts";
import { Gates } from "../gates/gates.ts";
import { Audit } from "../guard/audit.ts";
import { classify, classifyBudget, readModels } from "../guard/classifier.ts";
import { Guard } from "../guard/guard.ts";
import { GuardModeStore, isGuardMode } from "../guard/guardMode.ts";
import { DEFAULT_JUDGE, readJudge, writeJudge, type JudgeConfig } from "../guard/judge.ts";
import { rosterMode } from "../guard/modes.ts";
import { Plugins } from "../plugins/plugins.ts";
import { RestrictedTokens } from "../auth/restricted.ts";
import { AdapterPool } from "../adapters/index.ts";
import { HOOK_FILE, coreKinds, mergeKinds } from "../adapters/runtimes.ts";
import { chatPrompt, isPass, systemText, turnText } from "../adapters/prompt.ts";
import { claudeToolLines, lineSplitter, toolLine } from "../adapters/activity.ts";
import { Sessions } from "../sessions/sessions.ts";
import { seedSkills } from "../skills/seed.ts";
import { Skills, withSkills } from "../skills/skills.ts";
import { CodexLogin } from "./codex-login.ts";
import { Grants } from "../auth/grants.ts";
import { readSetting, writeSetting } from "../db/settings.ts";
import { Roster } from "../roster/roster.ts";
import { migrateRuntimes } from "../roster/migrate.ts";
import { seedDrift } from "../roster/seed.ts";
import { type AgentEntry, type RuntimeContext, type RuntimeKind } from "../roster/types.ts";
import { Wiki, wikiDir, type WikiSetup } from "../wiki/wiki.ts";
import { buildContext } from "../adapters/context.ts";
import { UpdateService, type UpdateOptions } from "../update/service.ts";
import { coreVersion } from "../version.ts";
import type { ChatTurnInput } from "../adapters/types.ts";

export interface CoreHandle {
  url: string;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;
const LOUNGE_RULES_KEY = "lounge.rules";
const RULE_ASKS_KEY = "guard.ruleAsks";
const BLOCK_ASKS_KEY = "guard.blockAsks";
const MAX_RULES_BYTES = 16 * 1024;
// Control characters grow sixfold in JSON.
const RULES_BODY = MAX_RULES_BYTES * 6 + 1024;
// A skill file may be 64 KiB before JSON escapes.
const MAX_SKILL_BODY = 256 * 1024;
const SKILL_PATH = /^\/api\/skills\/([^/]+)$/;
const MESSAGES_PATH = /^\/api\/rooms\/([^/]+)\/messages$/;
const FILES_PATH = /^\/api\/rooms\/([^/]+)\/files$/;
const ROOM_PATH = /^\/api\/rooms\/([^/]+)$/;
const EVENT_PATH = /^\/api\/events\/(\d+)$/;
const THREAD_STOP_PATH = /^\/api\/threads\/([^/]+)\/stop$/;
const THREAD_BOARD_PATH = /^\/api\/threads\/([^/]+)\/blackboard$/;
const THREAD_TREE_PATH = /^\/api\/threads\/([^/]+)\/tree$/;
const GRANTS_PATH = /^\/api\/grants\/([^/]+)$/;
const APPROVAL_PATH = /^\/api\/guard\/approvals\/([^/]+)$/;
const GATE_DECIDE_PATH = /^\/api\/gates\/([^/]+)\/decide$/;
const PLUGIN_PATH = /^\/api\/plugins\/([a-z0-9-]+)$/;
const PLUGIN_FILE_PATH = /^\/plugins\/([a-z0-9-]+)\/(.+)$/;
const CATEGORY_PATH = /^\/api\/categories\/([^/]+)$/;
const AGENT_PATH = /^\/api\/agents\/([^/]+)$/;
const WIKI_PAGE_PATH = /^\/api\/wiki\/pages\/([^/]+)$/;
const RUNTIME_EFFORTS_PATH =/^\/api\/runtimes\/([^/]+)\/efforts$/;
const REVEAL_PATH = /^\/api\/attachments\/([0-9a-f]{32})\/reveal$/;
// The name segment is for downloads only.
const ATTACHMENT_PATH = /^\/api\/attachments\/([0-9a-f]{32})(?:\/[^/]*)?$/;

const LOUNGE_STATUS: Partial<Record<string, number>> = {
  unknown_room: 404,
  unknown_attachment: 404,
  unknown_event: 404,
  unknown_category: 404,
  unknown_plugin: 404,
  unknown_agent: 404,
  unknown_skill: 404,
  unknown_gate: 404,
  skill_exists: 409,
  conflict: 409,
  channel_exists: 409,
  forbidden: 403,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", "request body is too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "request body is not valid JSON");
  }
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "too_large", `a file has at most ${limit / 1024 / 1024} MB`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  if (!/^-?\d+$/.test(raw)) throw new HttpError(400, "bad_query", `${name} must be an integer`);
  return Number(raw);
}

function decodeRoomId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "bad_path", "path segment is not valid");
  }
}

function listen(server: ReturnType<typeof createServer>, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(new Error(`port ${port} on ${host} is already in use`));
      } else {
        reject(new Error(`cannot listen on ${host}:${port}: ${err.message}`));
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

// A prompt that adds the instruction file and the project files of the agent to each system text.
// Both are read on every call, so an edit shows at once.
function withContext(prompt: RuntimeContext["prompt"], roster: Roster, setup: WikiSetup): RuntimeContext["prompt"] {
  const extend = (input: ChatTurnInput): ChatTurnInput => ({
    ...input,
    projectContext: buildContext({
      agent: roster.get(input.agent)?.options ?? {},
      projectDir: setup.project,
      wikiDir: wikiDir(setup.project, setup.root, setup.name),
    }),
  });
  return {
    ...prompt,
    systemText: (input) => prompt.systemText(extend(input)),
    chatPrompt: (input) => prompt.chatPrompt(extend(input)),
  };
}

function isStaticPath(pathname: string): boolean {
  return (
    pathname !== "/health" &&
    pathname !== "/mcp" &&
    pathname !== "/ws" &&
    !pathname.startsWith("/api/")
  );
}

export async function startCore(opts: {
  home: string;
  port?: number;
  uiDist?: string;
  now?: () => Date;
  // Tests swap in fake runtimes.
  // A kind replaces a core kind with its id.
  runtimes?: RuntimeKind[];
  // Runtime probe interval; unset means no probes.
  probeMs?: number;
  // Off in tests: turns spawn real runtimes.
  schedule?: boolean;
  // Tests point this at a folder of their own.
  bundledPlugins?: string;
  // Seed skills to copy into <home>/skills at start; unset copies none.
  bundledSkills?: string;
  // Fire scheduled events without the scheduler.
  events?: boolean;
  profileRoot?: string;
  // Tests shorten the approval wait.
  approvalMs?: number;
  // Tests must not start Explorer.
  reveal?: (path: string) => Promise<void>;
  // Replaces the project and the WIKI_ROOT and WIKI_NAME variables; tests never read the real wiki.
  wiki?: WikiSetup;
  // Unset in tests: no release check runs.
  update?: UpdateOptions;
}): Promise<CoreHandle> {
  const config = loadConfig(opts.home);
  const updates = new UpdateService({
    home: opts.home,
    current: coreVersion(),
    enabled: config.update.check,
    update: opts.update,
  });
  if (config.host !== DEFAULT_HOST) {
    throw new Error(`refusing to bind to host ${config.host}: the core binds to ${DEFAULT_HOST} only`);
  }
  const port = opts.port ?? config.port;
  const uiDist = opts.uiDist ?? join(import.meta.dirname, "..", "..", "..", "ui", "dist");
  const db = openDb(join(opts.home, "lounge.db"));
  const core = coreKinds();
  const plugins = new Plugins({
    home: opts.home,
    db,
    log: (line) => console.log(line),
    bundledDir: opts.bundledPlugins,
    coreRuntimes: () => core.map((k) => k.id),
  });
  // A test kind replaces a core or plugin kind with its id.
  const kinds = () => mergeKinds([...core, ...plugins.runtimes()], opts.runtimes);
  // Every group starts off, plugin groups too.
  const groupIds = () => grants.groups().map((g) => g.id);
  // The first start seeds from config.json.
  const roster = new Roster(db, config.adapters, kinds, groupIds, (runtime) => plugins.runtimeOwner(runtime));
  for (const line of seedDrift(roster, config.adapters)) console.log(line);
  // Before the plugins load: the setting it writes decides what loads.
  migrateRuntimes({
    db,
    roster,
    enablePlugins: (ids) => plugins.addEnabled(ids),
    log: (line) => console.log(line),
  });
  const tokens = ensureTokens(opts.home, ["owner", ...roster.active().map((e) => e.id)]);
  const room = new Room(db, undefined, () => [...roster.active().map((e) => e.id), "owner"]);
  const restricted = new RestrictedTokens();
  // The bound port is known only after listen.
  let mcpUrl = "";
  const getUrl = () => mcpUrl;
  await plugins.load();
  const grants: Grants = new Grants(db, () => plugins.grantGroups());
  const approvals = new Approvals({ now: opts.now, timeoutMs: opts.approvalMs });
  const audit = new Audit(opts.home);
  // Commands the classifier found safe.
  const safeCalls = new Set<string>();
  const guardMode = new GuardModeStore(db);
  const guard = new Guard({
    home: opts.home,
    approvals,
    audit,
    plugins: () => plugins.guards(),
    secrets: () => Object.values(tokens),
    now: opts.now,
    mode: rosterMode(roster),
    ruleAsks: () => readSetting(db, RULE_ASKS_KEY) !== "false",
    blockAsks: () => readSetting(db, BLOCK_ASKS_KEY) === "true",
    // The model list is read on every call, so a change applies at once.
    classify: (_id, request, signal) => classify(request, signal, { models: () => readModels(db), cache: safeCalls }),
    classifyMs: () => classifyBudget(readModels(db).length),
    guardMode: () => guardMode.get(),
    // The judge is read on every call and has no cache, so a policy change applies at once.
    judge: (_id, request, signal) => {
      const cfg = readJudge(db);
      return classify(request, signal, { models: () => [cfg.model], effort: cfg.effort });
    },
    judgePolicy: () => readJudge(db).policy,
  });
  const skills = new Skills({ home: opts.home, now: opts.now, extra: () => plugins.skillSources() });
  if (opts.bundledSkills !== undefined) seedSkills(skills, opts.bundledSkills);
  // The command of the first agent on the codex runtime.
  const codexLogin = new CodexLogin({
    home: opts.home,
    cli: () => {
      const options = roster.active().find((e) => e.runtime === "codex")?.options;
      return { command: options?.command ?? "codex", commandArgs: options?.commandArgs ?? [] };
    },
  });
  const wikiSetup = opts.wiki ?? { project: process.cwd(), root: process.env.WIKI_ROOT, name: process.env.WIKI_NAME };
  const ctx: RuntimeContext = {
    home: opts.home,
    hookFile: HOOK_FILE,
    mcpUrl: getUrl,
    guard,
    secrets: () => Object.values(tokens),
    prompt: withContext(withSkills({ systemText, turnText, chatPrompt, isPass }, skills), roster, wikiSetup),
    activity: { claudeToolLines, lineSplitter, toolLine },
    log: (line) => console.log(line),
  };
  const adapters = new AdapterPool(roster, kinds, ctx);
  // Read once; PUT keeps this copy current.
  let loungeRules = readSetting(db, LOUNGE_RULES_KEY) ?? "";
  const wiki = new Wiki(wikiSetup);
  const sessions = new Sessions({
    db,
    room,
    home: opts.home,
    config,
    adapters,
    roster,
    restricted,
    grants,
    runtimeInfo: (entry) => {
      const kind = roster.kind(entry.runtime);
      // A model hint is a hint: an empty model means the runtime's own default.
      return { label: kind?.label ?? entry.runtime, model: entry.model || "default model" };
    },
    loungeRules: () => loungeRules,
    guardMode: () => guardMode.get(),
    // Threads is made below; turns run later.
    nearThreads: (roomId) => threads.near(roomId),
    now: opts.now,
  });
  const reach = new Reachability({
    adapters,
    roster,
    intervalMs: opts.probeMs ?? 0,
    log: (line) => console.log(line),
  });
  const scheduler = new Scheduler({
    db,
    room,
    turns: sessions,
    config,
    roster,
    // Without probes, the turn itself checks.
    reachable: opts.probeMs === undefined ? undefined : () => reach.reachable(),
    now: opts.now,
    log: (line) => console.log(line),
  });
  const events = new Events({ db, room, now: opts.now });
  events.onFire((e) => scheduler.announce(e.roomId, eventText(e)));
  const threads = new Threads({
    db,
    room,
    home: opts.home,
    roster,
    turns: sessions,
    now: opts.now,
    log: (line) => console.log(line),
    gate: (id, from) => children.mayStart(id, from),
    onTurnEnd: (id, agent, end) => children.turnEnded(id, agent, end),
  });
  const gates = new Gates({ db, room, threads, now: opts.now });
  // Gate cards wait in the same stack as guard cards, oldest first.
  const queue = () => [...approvals.pending(), ...gates.cards()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A stopped child's open gate must not post its decision as a live owner post.
  const children = new Children({ db, room, threads, onStop: (id) => gates.stopRoom(id) });
  const attachments = new Attachments({ db, home: opts.home, now: opts.now });
  const reveal = opts.reveal ?? revealDefault();
  attachments.sweep();
  // The lounge home holds the tokens: keep it out.
  const files = new ProfileFiles({ root: opts.profileRoot, hidden: [opts.home] });
  const mcp = createMcpHandler(
    {
      room,
      events,
      threads,
      attachments,
      files,
      tokens,
      roster,
      sessions,
      restricted,
      grants,
      plugins,
      skills,
      children,
      gates,
      reachable: () => reach.reachable(),
    },
    { log: sessionLog(join(opts.home, "mcp-session.log")) },
  );

  // Change the shared token map in place.
  // A failed step skips no other step.
  const offRoster = roster.onChange((id, kind) => {
    const steps: [string, () => void][] =
      kind === "add"
        ? [
            ["token", () => void addToken(tokens, opts.home, id)],
          ]
        : kind === "retire"
          ? [
              ["turn tokens", () => restricted.revokeFor(id)],
              ["sessions", () => sessions.retire(id)],
              ["token", () => revokeToken(tokens, opts.home, id)],
            ]
          : [];
    for (const [label, step] of steps) {
      try {
        step();
      } catch (err) {
        console.error(`roster ${kind} ${id}: ${label} failed:`, err);
      }
    }
  });

  const rosterView = (entry: AgentEntry) => {
    const kind = roster.kind(entry.runtime);
    const reason = roster.runtimeReason(entry.id);
    return {
      ...entry,
      efforts: kind?.efforts(entry) ?? [],
      models: kind?.models(entry) ?? [],
      available: reason === undefined,
      ...(reason === undefined ? {} : { reason }),
    };
  };

  // The model and effort choices of a runtime, for an entry that may be a draft.
  const choicesOf = (kind: RuntimeKind, draft: Record<string, unknown> = {}) => {
    const entry = {
      id: "",
      model: "",
      effort: "",
      enabled: true,
      tape: 1,
      options: {},
      position: 0,
      retired: false,
      ...draft,
      runtime: kind.id,
    } as AgentEntry;
    return { efforts: kind.efforts(entry), models: kind.models(entry) };
  };

  const requireOwner = (req: IncomingMessage): Caller => {
    const caller = callerForToken(tokens, bearerToken(req));
    if (!caller) throw new HttpError(401, "unauthorized", "missing or invalid token");
    if (caller !== "owner") throw new HttpError(403, "forbidden", "the API needs the owner token");
    room.touch(caller);
    return caller;
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${DEFAULT_HOST}`);
    const method = req.method ?? "GET";

    if (url.pathname === "/health") {
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      const challenge = url.searchParams.get("challenge");
      if (challenge === null) {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (challenge.length === 0 || challenge.length > MAX_HEALTH_CHALLENGE) {
        throw new HttpError(400, "bad_challenge", `challenge must be 1 to ${MAX_HEALTH_CHALLENGE} characters`);
      }
      sendJson(res, 200, { ok: true, proof: healthProof(tokens.owner, challenge) });
      return;
    }
    if (url.pathname === "/mcp") {
      if (!["GET", "POST", "DELETE"].includes(method)) {
        throw new HttpError(405, "method_not_allowed", "use GET, POST, or DELETE");
      }
      await mcp(req, res);
      return;
    }
    if (url.pathname === "/api/who") {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(
        res,
        200,
        presence(room, roster, {
          slow: sessions.slow(),
          reachable: reachableCallers({ reachable: () => reach.reachable() }, mcp.connected()),
        }),
      );
      return;
    }
    if (url.pathname === "/api/scheduler") {
      requireOwner(req);
      if (method === "GET") {
        sendJson(res, 200, scheduler.status());
        return;
      }
      if (method === "PUT") {
        const body = (await readJson(req)) as { enabled?: unknown } | null;
        if (typeof body?.enabled !== "boolean") {
          throw new HttpError(400, "bad_request", "enabled must be true or false");
        }
        sendJson(res, 200, scheduler.setEnabled(body.enabled));
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or PUT");
    }
    if (url.pathname === "/api/update") {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(res, 200, updates.status());
      return;
    }
    if (url.pathname === "/api/update/download") {
      requireOwner(req);
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      if (!updates.download()) throw new HttpError(409, "conflict", "no update is available to download");
      sendJson(res, 202, updates.status());
      return;
    }
    if (url.pathname === "/api/update/apply") {
      requireOwner(req);
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      if (!(await updates.apply())) throw new HttpError(409, "conflict", "no staged update to apply");
      res.once("finish", () => updates.exit());
      sendJson(res, 202, updates.status());
      return;
    }
    if (url.pathname === "/api/lounge/rules") {
      requireOwner(req);
      if (method === "GET") {
        sendJson(res, 200, { text: loungeRules });
        return;
      }
      if (method === "PUT") {
        const body = (await readJson(req, RULES_BODY)) as { text?: unknown } | null;
        const text = body?.text;
        if (typeof text !== "string") throw new LoungeError("bad_rules", "text must be a string");
        if (Buffer.byteLength(text, "utf8") > MAX_RULES_BYTES) {
          throw new LoungeError("bad_rules", `the rules have at most ${MAX_RULES_BYTES} bytes`);
        }
        writeSetting(db, LOUNGE_RULES_KEY, text);
        loungeRules = text;
        sendJson(res, 200, { text });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or PUT");
    }
    if (url.pathname === "/api/wiki/pages") {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(res, 200, wiki.list());
      return;
    }
    const wikiMatch = WIKI_PAGE_PATH.exec(url.pathname);
    if (wikiMatch) {
      requireOwner(req);
      const name = decodeRoomId(wikiMatch[1] ?? "");
      if (method === "GET") {
        sendJson(res, 200, { name, text: wiki.read(name) });
        return;
      }
      if (method === "PUT") {
        const body = (await readJson(req)) as { text?: unknown } | null;
        if (typeof body?.text !== "string") throw new HttpError(400, "bad_request", "text must be a string");
        sendJson(res, 200, wiki.write(name, body.text));
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or PUT");
    }
    if (url.pathname === "/api/skills") {
      requireOwner(req);
      if (method === "GET") {
        sendJson(res, 200, { folder: skills.root, ...skills.scan() });
        return;
      }
      if (method === "POST") {
        sendJson(res, 201, skills.create(await readJson(req, MAX_SKILL_BODY)));
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or POST");
    }
    if (url.pathname === "/api/codex/login") {
      requireOwner(req);
      if (method === "GET") sendJson(res, 200, await codexLogin.status());
      else if (method === "POST") sendJson(res, 200, await codexLogin.start());
      else if (method === "DELETE") sendJson(res, 200, await codexLogin.cancel());
      else throw new HttpError(405, "method_not_allowed", "use GET, POST, or DELETE");
      return;
    }
    const skillMatch = SKILL_PATH.exec(url.pathname);
    if (skillMatch) {
      requireOwner(req);
      const name = decodeRoomId(skillMatch[1]!);
      if (method === "GET") {
        sendJson(res, 200, skills.get(name));
        return;
      }
      if (method === "PUT") {
        const body = (await readJson(req, MAX_SKILL_BODY)) as { text?: unknown } | null;
        sendJson(res, 200, skills.replace(name, body?.text));
        return;
      }
      if (method === "DELETE") {
        skills.remove(name);
        res.writeHead(204).end();
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET, PUT, or DELETE");
    }
    if (url.pathname === "/guard/check") {
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      const token = bearerToken(req);
      const full = callerForToken(tokens, token);
      const caller = full ?? restricted.lookup(token)?.caller;
      if (!caller) throw new HttpError(401, "unauthorized", "missing or invalid token");
      if (caller === "owner") throw new HttpError(403, "forbidden", "the guard checks agent turns");
      const body = (await readJson(req)) as Record<string, unknown> | null;
      if (body === null || typeof body !== "object" || typeof body.tool !== "string") {
        throw new HttpError(400, "bad_check", "body needs a tool name");
      }
      // A closed hook must not leave a card open.
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) gone.abort();
      });
      sendJson(res, 200, await guard.check(caller, guard.action(body.tool, body.input, body.cwd), gone.signal));
      return;
    }
    if (url.pathname === "/api/guard") {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(res, 200, { pending: queue(), recent: guard.recent() });
      return;
    }
    if (url.pathname === "/api/guard/rule-asks") {
      requireOwner(req);
      if (method === "PUT") {
        const body = (await readJson(req)) as { enabled?: unknown } | null;
        if (typeof body?.enabled !== "boolean") throw new HttpError(400, "bad_rule_asks", "enabled must be true or false");
        writeSetting(db, RULE_ASKS_KEY, String(body.enabled));
      } else if (method !== "GET") {
        throw new HttpError(405, "method_not_allowed", "use GET or PUT");
      }
      sendJson(res, 200, { enabled: readSetting(db, RULE_ASKS_KEY) !== "false" });
      return;
    }
    if (url.pathname === "/api/guard/block-asks") {
      requireOwner(req);
      if (method === "PUT") {
        const body = (await readJson(req)) as { enabled?: unknown } | null;
        if (typeof body?.enabled !== "boolean") throw new HttpError(400, "bad_block_asks", "enabled must be true or false");
        writeSetting(db, BLOCK_ASKS_KEY, String(body.enabled));
      } else if (method !== "GET") {
        throw new HttpError(405, "method_not_allowed", "use GET or PUT");
      }
      sendJson(res, 200, { enabled: readSetting(db, BLOCK_ASKS_KEY) === "true" });
      return;
    }
    if (url.pathname === "/api/guard/mode") {
      const author = requireOwner(req);
      if (method === "PUT") {
        const body = (await readJson(req)) as { mode?: unknown } | null;
        const mode = body?.mode;
        if (!isGuardMode(mode)) throw new HttpError(400, "bad_guard_mode", "mode must be normal, auto, or bypass");
        guardMode.set(mode);
        audit.add({
          at: (opts.now?.() ?? new Date()).toISOString(),
          agent: author,
          tool: "guard-mode",
          summary: `guard mode: ${mode}`,
          verdict: "allow",
          outcome: "allowed",
          reason: `the owner set the guard mode to ${mode}`,
          source: "guard-mode",
        });
      } else if (method !== "GET") {
        throw new HttpError(405, "method_not_allowed", "use GET or PUT");
      }
      sendJson(res, 200, { mode: guardMode.get() });
      return;
    }
    if (url.pathname === "/api/guard/judge") {
      requireOwner(req);
      if (method === "PUT") {
        const body = await readJson(req);
        try {
          writeJudge(db, body as JudgeConfig);
        } catch (err) {
          throw new HttpError(400, "bad_judge", err instanceof Error ? err.message : String(err));
        }
      } else if (method !== "GET") {
        throw new HttpError(405, "method_not_allowed", "use GET or PUT");
      }
      const claude = kinds().find((k) => k.id === DEFAULT_JUDGE.runtime);
      sendJson(res, 200, { ...readJudge(db), ...(claude ? choicesOf(claude) : { efforts: [], models: [] }) });
      return;
    }
    const approvalMatch = APPROVAL_PATH.exec(url.pathname);
    if (approvalMatch) {
      requireOwner(req);
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      const body = (await readJson(req)) as { allow?: unknown } | null;
      if (typeof body?.allow !== "boolean") throw new HttpError(400, "bad_decision", "allow must be true or false");
      if (!approvals.decide(decodeRoomId(approvalMatch[1]!), body.allow)) {
        throw new HttpError(404, "unknown_approval", "no open approval with that id");
      }
      sendJson(res, 200, { ok: true });
      return;
    }
    const gateMatch = GATE_DECIDE_PATH.exec(url.pathname);
    if (gateMatch) {
      const author = requireOwner(req);
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      const body = (await readJson(req)) as { decision?: unknown; note?: unknown } | null;
      if (body?.decision !== "approve" && body?.decision !== "change") {
        throw new HttpError(400, "bad_decision", "decision must be approve or change");
      }
      gates.decide(author, decodeRoomId(gateMatch[1]!), body.decision, body.note ?? "");
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/api/plugins") {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(res, 200, { plugins: plugins.list() });
      return;
    }
    if (url.pathname === "/api/plugins/reload") {
      requireOwner(req);
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      await plugins.load();
      sendJson(res, 200, { plugins: plugins.list() });
      return;
    }
    const pluginMatch = PLUGIN_PATH.exec(url.pathname);
    if (pluginMatch) {
      requireOwner(req);
      if (method !== "PUT") throw new HttpError(405, "method_not_allowed", "use PUT");
      const body = (await readJson(req)) as { enabled?: unknown } | null;
      if (typeof body?.enabled !== "boolean") throw new HttpError(400, "bad_plugin", "enabled must be true or false");
      sendJson(res, 200, { plugins: await plugins.setEnabled(pluginMatch[1]!, body.enabled) });
      return;
    }
    const pluginFile = PLUGIN_FILE_PATH.exec(url.pathname);
    if (pluginFile && (method === "GET" || method === "HEAD")) {
      let rel: string;
      try {
        rel = decodeURIComponent(pluginFile[2]!);
      } catch {
        throw new HttpError(404, "not_found", "no plugin file");
      }
      const file = plugins.panelFile(pluginFile[1]!, rel);
      if (!file) throw new HttpError(404, "not_found", "no plugin file");
      const data = readFileSync(file);
      // The panel must not reach the lounge origin.
      res.writeHead(200, {
        "content-type": contentType(file),
        "content-security-policy": "sandbox allow-scripts",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        "content-length": String(data.length),
      });
      res.end(method === "HEAD" ? undefined : data);
      return;
    }
    if (url.pathname === "/api/agents") {
      requireOwner(req);
      if (method === "GET") {
        sendJson(res, 200, {
          agents: roster.active().map(rosterView),
          retired: roster.retired(),
          runtimes: kinds().map(({ id, label, toolModes }) => ({ id, label, toolModes: toolModes === true })),
        });
        return;
      }
      if (method === "POST") {
        const body = await readJson(req);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new HttpError(400, "bad_json", "body must be an object");
        }
        const { displayName, ...input } = body as Record<string, unknown>;
        // Check this first, so a bad value
        // leaves no row.
        if (displayName !== undefined) cleanNickname(displayName);
        const entry = roster.add(input as never);
        if (typeof displayName === "string" && displayName.trim() !== "") room.setNickname(entry.id, displayName);
        sendJson(res, 201, rosterView(entry));
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or POST");
    }
    const agentMatch = AGENT_PATH.exec(url.pathname);
    if (agentMatch) {
      requireOwner(req);
      const id = decodeRoomId(agentMatch[1]!);
      if (method === "PATCH") {
        const body = await readJson(req);
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          throw new HttpError(400, "bad_json", "body must be an object");
        }
        const { displayName, ...patch } = body as Record<string, unknown>;
        if (displayName !== undefined) cleanNickname(displayName);
        const entry = roster.update(id, patch);
        if (typeof displayName === "string") room.setNickname(entry.id, displayName);
        sendJson(res, 200, rosterView(entry));
        return;
      }
      if (method === "DELETE") {
        roster.retire(id);
        res.writeHead(204).end();
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use PATCH or DELETE");
    }
    const effortsMatch = RUNTIME_EFFORTS_PATH.exec(url.pathname);
    if (effortsMatch) {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      const kind = kinds().find((k) => k.id === decodeRoomId(effortsMatch[1]!));
      if (!kind) throw new HttpError(404, "unknown_runtime", "no such runtime");
      let draft: Record<string, unknown> = {};
      const raw = url.searchParams.get("entry");
      if (raw !== null && raw !== "") {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
          draft = parsed as Record<string, unknown>;
        } catch {
          throw new HttpError(400, "bad_query", "entry must be a JSON object");
        }
      }
      sendJson(res, 200, choicesOf(kind, draft));
      return;
    }
    if (url.pathname === "/api/grants") {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(res, 200, {
        groups: grants.groups(),
        grants: grants.all(roster.active().map((e) => e.id)),
      });
      return;
    }
    const grantMatch = GRANTS_PATH.exec(url.pathname);
    if (grantMatch) {
      requireOwner(req);
      if (method !== "PUT") throw new HttpError(405, "method_not_allowed", "use PUT");
      const agent = decodeRoomId(grantMatch[1]!);
      if (!roster.has(agent)) throw new LoungeError("unknown_agent", `no agent: ${agent}`);
      sendJson(res, 200, grants.set(agent, await readJson(req)));
      return;
    }
    if (url.pathname === "/api/nickname") {
      const author = requireOwner(req);
      if (method !== "PUT") throw new HttpError(405, "method_not_allowed", "use PUT");
      const body = (await readJson(req)) as { name?: unknown } | null;
      sendJson(res, 200, room.setNickname(author, body?.name));
      return;
    }
    if (url.pathname === "/api/events") {
      const author = requireOwner(req);
      if (method === "GET") {
        sendJson(res, 200, events.list());
        return;
      }
      if (method === "POST") {
        const body = (await readJson(req)) as Record<string, unknown> | null;
        sendJson(res, 201, events.create(author, body ?? {}));
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or POST");
    }
    const revealMatch = method === "POST" ? REVEAL_PATH.exec(url.pathname) : null;
    if (revealMatch) {
      requireOwner(req);
      const att = attachments.get(revealMatch[1]!);
      if (!att) throw new HttpError(404, "not_found", "unknown attachment");
      const path = attachmentPath(opts.home, att);
      if (!existsSync(path)) throw new HttpError(404, "not_found", "the stored file is gone");
      await reveal(path);
      res.writeHead(204).end();
      return;
    }
    const fileMatch = ATTACHMENT_PATH.exec(url.pathname);
    if (fileMatch) {
      // The 128-bit id is the key, so <img> can load it.
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "method_not_allowed", "use GET");
      const att = attachments.get(fileMatch[1]!);
      if (!att) throw new HttpError(404, "not_found", "unknown attachment");
      const inline = INLINE.has(att.mime);
      res.writeHead(200, {
        "content-type": inline ? att.mime : "application/octet-stream",
        "content-length": att.size,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=31536000, immutable",
      });
      res.end(method === "HEAD" ? undefined : attachments.read(att.id));
      return;
    }
    if (url.pathname === "/api/attachments") {
      const author = requireOwner(req);
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      const data = await readRaw(req, MAX_ATTACHMENT);
      const name = url.searchParams.get("name") ?? "file";
      sendJson(res, 201, attachments.save(author, name, data, req.headers["content-type"]));
      return;
    }
    if (url.pathname === "/api/threads") {
      const author = requireOwner(req);
      if (method === "GET") {
        sendJson(res, 200, threads.list());
        return;
      }
      if (method === "POST") {
        const body = (await readJson(req)) as Record<string, unknown> | null;
        sendJson(res, 201, threads.create(author, body ?? {}));
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or POST");
    }
    const stopMatch = THREAD_STOP_PATH.exec(url.pathname);
    if (stopMatch) {
      const author = requireOwner(req);
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      sendJson(res, 200, { stopped: children.stopTree(author, decodeRoomId(stopMatch[1])) });
      return;
    }
    const treeMatch = THREAD_TREE_PATH.exec(url.pathname);
    if (treeMatch) {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(res, 200, children.tree(decodeRoomId(treeMatch[1])));
      return;
    }
    const boardMatch = THREAD_BOARD_PATH.exec(url.pathname);
    if (boardMatch) {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      const roomId = decodeRoomId(boardMatch[1]!);
      const thread = threads.info(roomId);
      if (!thread) throw new LoungeError("unknown_room", `no thread: ${roomId}`);
      sendJson(res, 200, { tasks: readBoard(thread.cwd) });
      return;
    }
    if (url.pathname === "/api/work") {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(res, 200, threads.work());
      return;
    }
    const eventMatch = EVENT_PATH.exec(url.pathname);
    if (eventMatch) {
      const author = requireOwner(req);
      if (method !== "DELETE") throw new HttpError(405, "method_not_allowed", "use DELETE");
      sendJson(res, 200, events.cancel(author, Number(eventMatch[1])));
      return;
    }
    if (url.pathname === "/api/layout") {
      requireOwner(req);
      if (method === "GET") {
        sendJson(res, 200, room.layout());
        return;
      }
      if (method === "PUT") {
        sendJson(res, 200, room.setLayout(await readJson(req)));
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or PUT");
    }
    if (url.pathname === "/api/categories") {
      requireOwner(req);
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "use POST");
      const body = (await readJson(req)) as { name?: unknown } | null;
      sendJson(res, 201, room.createCategory(body?.name));
      return;
    }
    const categoryMatch = CATEGORY_PATH.exec(url.pathname);
    if (categoryMatch) {
      requireOwner(req);
      const id = decodeRoomId(categoryMatch[1]!);
      if (method === "PATCH") {
        const body = (await readJson(req)) as { name?: unknown } | null;
        sendJson(res, 200, room.renameCategory(id, body?.name));
        return;
      }
      if (method === "DELETE") {
        room.deleteCategory(id);
        res.writeHead(204).end();
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use PATCH or DELETE");
    }
    if (url.pathname === "/api/rooms") {
      const author = requireOwner(req);
      if (method === "GET") {
        sendJson(res, 200, room.channels());
        return;
      }
      if (method === "POST") {
        const body = (await readJson(req)) as { name?: unknown; topic?: unknown } | null;
        sendJson(res, 201, room.createChannel(body?.name, author, body?.topic ?? ""));
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or POST");
    }
    const roomMatch = ROOM_PATH.exec(url.pathname);
    if (roomMatch) {
      const author = requireOwner(req);
      const roomId = decodeRoomId(roomMatch[1]);
      if (method === "PATCH") {
        const body = (await readJson(req)) as { topic?: unknown; name?: unknown; mode?: unknown; slowSec?: unknown } | null;
        const settings = body?.mode !== undefined || body?.slowSec !== undefined;
        if (body?.name === undefined && body?.topic === undefined && !settings) {
          throw new HttpError(400, "bad_request", "body needs name, topic, mode, or slowSec");
        }
        let channel = body.name === undefined ? undefined : room.renameChannel(roomId, body.name, author);
        if (body.topic !== undefined) channel = room.setTopic(roomId, body.topic, author);
        if (settings) channel = room.setChannelSettings(roomId, { mode: body.mode, slowSec: body.slowSec }, author);
        sendJson(res, 200, channel);
        return;
      }
      if (method === "DELETE") {
        sendJson(res, 200, { removed: room.deleteRoom(roomId) });
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use PATCH or DELETE");
    }
    const filesMatch = FILES_PATH.exec(url.pathname);
    if (filesMatch) {
      requireOwner(req);
      if (method !== "GET") throw new HttpError(405, "method_not_allowed", "use GET");
      sendJson(res, 200, attachments.roomFiles(decodeRoomId(filesMatch[1]!), intParam(url.searchParams, "before")));
      return;
    }
    const match = MESSAGES_PATH.exec(url.pathname);
    if (match) {
      const author = requireOwner(req);
      const roomId = decodeRoomId(match[1]);
      if (method === "GET") {
        const since = intParam(url.searchParams, "since");
        const before = intParam(url.searchParams, "before");
        const limit = intParam(url.searchParams, "limit");
        sendJson(res, 200, room.read(roomId, { since, before, limit }));
        return;
      }
      if (method === "POST") {
        const body = (await readJson(req)) as { text?: unknown; attachments?: unknown } | null;
        const text = body?.text ?? "";
        if (typeof text !== "string") {
          throw new HttpError(400, "bad_text", "body must be {\"text\": string, \"attachments\"?: string[]}");
        }
        const files = attachments.resolve(body?.attachments);
        const message = room.post(author, roomId, text, "text", files);
        attachments.markPosted(files);
        sendJson(res, 201, message);
        return;
      }
      throw new HttpError(405, "method_not_allowed", "use GET or POST");
    }
    if ((method === "GET" || method === "HEAD") && isStaticPath(url.pathname)) {
      if (serveStatic(uiDist, url.pathname, res)) return;
      sendJson(res, 404, { error: "no_ui", message: "run npm --prefix ui run build" });
      return;
    }
    throw new HttpError(404, "not_found", `no route for ${url.pathname}`);
  };

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else if (err instanceof LoungeError) {
        const status = LOUNGE_STATUS[err.code] ?? 400;
        sendJson(res, status, { error: err.code, message: err.message });
      } else {
        console.error("request failed:", err);
        sendJson(res, 500, { error: "internal", message: "internal error" });
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${DEFAULT_HOST}`);
    const reject = (status: string) => {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (url.pathname !== "/ws") return reject("404 Not Found");
    const caller = callerForToken(tokens, url.searchParams.get("token") ?? undefined);
    if (!caller) return reject("401 Unauthorized");
    if (caller !== "owner") return reject("403 Forbidden");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const broadcast = (event: unknown) => {
    const frame = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(frame);
    }
  };
  const offs = [
    room.onMessage((message) => broadcast({ type: "message", message })),
    room.onChannel((channel) => broadcast({ type: "channel", channel })),
    room.onRemove((ids) => broadcast({ type: "removed", ids })),
    room.onTyping((t) => broadcast({ type: "typing", ...t })),
    room.onNickname((n) => broadcast({ type: "nickname", ...n })),
    events.onChange((event) => broadcast({ type: "scheduled", event })),
    updates.onChange((update) => broadcast({ type: "update", update })),
    threads.onWork((w) => broadcast({ type: "work", ...w })),
    room.onLayout((l) => broadcast({ type: "layout", ...l })),
    roster.onChange((id, kind) => broadcast({ type: "roster", id, kind })),
    // A plugin change adds or drops runtimes: probe again, and tell the UI.
    plugins.onChange(() => {
      if (opts.probeMs !== undefined) void reach.probe().catch((err) => console.error("probe failed:", err));
      broadcast({ type: "roster", id: "", kind: "update" });
    }),
    offRoster,
    approvals.onChange(() => broadcast({ type: "approval", pending: queue() })),
    gates.onChange(() => broadcast({ type: "approval", pending: queue() })),
    audit.onAdd((entry) => broadcast({ type: "guard", entry })),
    room.onMessage((message) => plugins.emit("message", message)),
    events.onFire((e) => plugins.emit("eventFire", e)),
    sessions.onTurnEnd((e) => plugins.emit("turnEnd", e)),
  ];
  const unsubscribe = () => {
    for (const off of offs) off();
  };
  // A new client learns who is typing now.
  wss.on("connection", (ws) => {
    for (const t of room.typing()) ws.send(JSON.stringify({ type: "typing", ...t }));
    for (const w of threads.work()) ws.send(JSON.stringify({ type: "work", ...w, active: true }));
    ws.send(JSON.stringify({ type: "layout", ...room.layout() }));
    ws.send(JSON.stringify({ type: "approval", pending: queue() }));
  });

  const shutdown = async () => {
    updates.stop();
    events.stop();
    threads.stop();
    reach.stop();
    scheduler.stop();
    approvals.close();
    gates.close();
    await sessions.shutdown();
    await codexLogin.close();
    await plugins.close();
    adapters.close();
    unsubscribe();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await mcp.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  };

  try {
    await listen(server, config.host, port);
  } catch (err) {
    scheduler.stop();
    await sessions.shutdown();
    unsubscribe();
    await mcp.close();
    db.close();
    throw err;
  }

  const { port: bound } = server.address() as AddressInfo;
  mcpUrl = `http://${config.host}:${bound}/mcp`;
  if (opts.probeMs !== undefined) reach.start();
  threads.start();
  if (opts.schedule) scheduler.start();
  updates.start();
  // Tests start events by hand.
  if (opts.schedule || opts.events) events.start();
  let closing: Promise<void> | undefined;
  return {
    url: `http://${config.host}:${bound}`,
    close: () => (closing ??= shutdown()),
  };
}
