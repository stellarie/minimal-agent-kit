import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Agent, Caller } from "../config.ts";
import { can, type Action, type Identity } from "../auth/permissions.ts";
import type { Grants } from "../auth/grants.ts";
import type { RestrictedTokens } from "../auth/restricted.ts";
import { callerForToken } from "../auth/tokens.ts";
import { LoungeError, type Room } from "../lounge/room.ts";
import type { Events } from "../lounge/events.ts";
import type { Threads } from "../lounge/threads.ts";
import type { Attachments } from "../lounge/attachments.ts";
import { isTextMime, type ProfileFiles, textPreview } from "../lounge/files.ts";
import { presence } from "../lounge/presence.ts";
import type { PluginTool, Plugins } from "../plugins/plugins.ts";
import type { Roster } from "../roster/roster.ts";
import type { Skills } from "../skills/skills.ts";
import type { Children } from "../threads/children.ts";
import type { Gates } from "../gates/gates.ts";
import type { DropReason, SessionEvent } from "./session-log.ts";
import {
  SESSION_ROOM_PREFIX,
  SESSION_STATES,
  type SessionState,
  type Sessions,
} from "../sessions/sessions.ts";

export interface McpDeps {
  room: Room;
  tokens: Record<string, string>;
  roster: Roster;
  sessions: Sessions;
  restricted: RestrictedTokens;
  events: Events;
  threads: Threads;
  attachments: Attachments;
  files: ProfileFiles;
  // Agents whose runtime answered the last probe.
  reachable?: () => ReadonlySet<Agent>;
  // Unset: every agent has every tool.
  grants?: Grants;
  plugins?: Plugins;
  skills?: Skills;
  children?: Children;
  gates?: Gates;
}

// One file of mcp/tools is one tool: it exports a ToolModule as its default.
export interface ToolContext {
  caller: Caller;
  deps: McpDeps;
  // Ends when the client cancels the call.
  signal?: AbortSignal;
}

export interface ToolModule {
  name: string;
  description: string;
  input: Record<string, z.ZodType>;
  // The permission the caller needs.
  action: Action;
  // A string comes back as plain text. Anything else comes back as JSON.
  run(args: Record<string, unknown>, ctx: ToolContext): unknown;
}

const TOOLS_DIR = join(import.meta.dirname, "tools");

// Every module of the folder, in name order. A new tool is a new file.
async function loadToolModules(dir: string): Promise<readonly ToolModule[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort();
  const out: ToolModule[] = [];
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: ToolModule };
    const tool = mod.default;
    if (!tool || typeof tool.name !== "string" || typeof tool.run !== "function") {
      throw new Error(`mcp/tools/${file} must export a tool module as its default`);
    }
    if (out.some((m) => m.name === tool.name)) throw new Error(`mcp/tools/${file}: tool ${tool.name} already exists`);
    out.push(tool);
  }
  return out;
}

// Loaded once, when this module starts.
export const TOOL_MODULES: readonly ToolModule[] = await loadToolModules(TOOLS_DIR);

function pluginSchema(tool: PluginTool): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  for (const [key, f] of Object.entries(tool.input)) {
    let t: z.ZodType = f.type === "number" ? z.number() : f.type === "boolean" ? z.boolean() : z.string();
    if (f.description) t = t.describe(f.description);
    out[key] = f.optional ? t.optional() : t;
  }
  return out;
}

export type McpHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<void>) & {
  close(): Promise<void>;
  connected(): Set<Caller>;
};

export interface McpOptions {
  idleMs?: number;
  maxPerCaller?: number;
  now?: () => number;
  // Unset: no session log.
  log?: (event: SessionEvent) => void;
}

const IDLE_MS = 30 * 60 * 1000;
const MAX_PER_CALLER = 8;
const SWEEP_MS = 60 * 1000;
const READ_TEXT_MAX = 64 * 1024;
const READ_IMAGE_MAX = 3 * 1024 * 1024;

interface Session {
  caller: Caller;
  // Restricted sessions get their own cap.
  capKey: string;
  token: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
  startedAt: number;
}

export function reachableCallers(deps: Pick<McpDeps, "reachable">, connected: Set<Caller>): Set<Caller> {
  return new Set<Caller>([...(deps.reachable?.() ?? []), ...connected]);
}

export function bearerToken(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "");
  return match?.[1];
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function failureOf(err: unknown): CallToolResult {
  if (err instanceof LoungeError) return failure(`${err.code}: ${err.message}`);
  return failure((err as Error).message);
}

function buildServer(identity: Identity, deps: McpDeps, connected: () => Set<Caller>): McpServer {
  const { caller } = identity;
  const allowed = (action: Action): boolean =>
    can(identity, action) && (caller === "owner" || !deps.grants || deps.grants.allows(caller, action));
  const server = new McpServer({ name: "agent-lounge", version: "0.1.0" });
  const add = server.registerTool.bind(server) as McpServer["registerTool"];

  const begin = (): void => {
    deps.room.touch(caller);
  };

  const run = (action: Action, body: () => unknown): CallToolResult => {
    begin();
    if (!allowed(action)) return failure(`forbidden: ${caller} may not use ${action}`);
    try {
      return text(body());
    } catch (err) {
      if (err instanceof LoungeError) return failure(`${err.code}: ${err.message}`);
      throw err;
    }
  };

  // Any rejection becomes a tool error, never an unhandled one.
  const runAsync = async (action: Action, body: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      begin();
      if (!allowed(action)) return failure(`forbidden: ${caller} may not use ${action}`);
      return text(await body());
    } catch (err) {
      return failureOf(err);
    }
  };

  add(
    "lounge_read",
    {
      description: "Read room messages, oldest first. `since` is an exclusive message id.",
      inputSchema: {
        room: z.string(),
        since: z.number().int().optional(),
        limit: z.number().int().optional(),
      },
    },
    async ({ room, since, limit }) =>
      run("lounge_read", () => deps.room.read(room, { since, limit })),
  );

  add(
    "lounge_post",
    {
      description:
        "Post a message to a room as yourself. `attachments` are ids from lounge_attach. Judge each file before you send it. `replyTo` is the id of the message in the same room that you answer.",
      inputSchema: {
        room: z.string(),
        text: z.string(),
        attachments: z.array(z.string()).optional(),
        replyTo: z.number().int().positive().optional(),
      },
    },
    async ({ room, text: body, attachments, replyTo }) =>
      run("lounge_post", () => {
        if (room.startsWith(SESSION_ROOM_PREFIX)) {
          throw new LoungeError("forbidden", "session rooms take writes through session tools");
        }
        const files = deps.attachments.resolve(attachments);
        const message = deps.room.post(caller, room, body, "text", files, replyTo);
        deps.attachments.markPosted(files);
        return { id: message.id };
      }),
  );

  // Staged files come back to the agent only. It decides to post.
  const staged = async (action: Action, body: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      begin();
      if (!allowed(action)) return failure(`forbidden: ${caller} may not use ${action}`);
      return await body();
    } catch (err) {
      return failureOf(err);
    }
  };

  add(
    "lounge_browse",
    {
      description:
        "List a folder in the owner's user profile. `path` is absolute or relative to the profile. Files that may hold secrets are hidden.",
      inputSchema: { path: z.string().optional() },
    },
    async ({ path }) => staged("lounge_files", async () => text(deps.files.browse(path))),
  );

  add(
    "lounge_attach",
    {
      description:
        "Stage a file from the owner's profile. You get its id and a view of it; nobody else sees it. To send it, call lounge_post with the id.",
      inputSchema: { path: z.string() },
    },
    async ({ path }) =>
      staged("lounge_files", async () => {
        const file = deps.files.read(path);
        const att = deps.attachments.save(caller, file.name, file.data, file.mime);
        const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify({ attachment: att, path: file.path }) }];
        const view = textPreview(att.mime, file.data);
        if (view !== undefined) content.push({ type: "text", text: view });
        if (/^image\/(png|jpeg|gif|webp)$/.test(att.mime) && file.data.length <= 3 * 1024 * 1024) {
          content.push({ type: "image", data: file.data.toString("base64"), mimeType: att.mime });
        }
        return { content };
      }),
  );

  add(
    "lounge_attachment_read",
    {
      description:
        "Read a file that a message in a room holds, by its attachment id. You get its name, type, and size. You also get a view of an image or a text file.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) =>
      staged("lounge_read", async () => {
        const unknown = (): LoungeError => new LoungeError("unknown_attachment", `unknown attachment: ${id}`);
        const att = deps.attachments.get(id);
        const seen = deps.attachments.rooms(id).length > 0;
        if (!att || !seen) throw unknown();
        const text = isTextMime(att.mime);
        const image = /^image\/(png|jpeg|gif|webp)$/.test(att.mime) && att.size <= READ_IMAGE_MAX;
        let data: Buffer;
        try {
          data = deps.attachments.read(id);
        } catch {
          throw unknown();
        }
        const meta = { id: att.id, name: att.name, mime: att.mime, size: att.size };
        const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(meta) }];
        if (text) {
          // A byte cut can split a UTF-8 character.
          const head = data.subarray(0, READ_TEXT_MAX).toString("utf8").replace(/�$/, "");
          content.push({ type: "text", text: data.length > READ_TEXT_MAX ? `${head}\n[cut]` : head });
        } else if (image && data.length <= READ_IMAGE_MAX) {
          content.push({ type: "image", data: data.toString("base64"), mimeType: att.mime });
        }
        return { content };
      }),
  );

  add(
    "lounge_channels",
    { description: "List the lounge channels with their topics.", inputSchema: {} },
    async () => run("lounge_channels", () => deps.room.channels()),
  );

  add(
    "lounge_events",
    { description: "List scheduled events that have not started yet.", inputSchema: {} },
    async () => run("event_list", () => deps.events.list({ pending: true })),
  );

  add(
    "lounge_schedule",
    {
      description:
        "Schedule an event in a channel. At `at` (ISO 8601 with a zone), the channel shows it and every agent is pinged with the title and context. `repeat` makes it come back daily, on weekdays, weekly, or monthly (day 1 to 28) until cancelled.",
      inputSchema: {
        room: z.string().optional(),
        title: z.string(),
        at: z.string(),
        context: z.string().optional(),
        repeat: z.enum(["none", "daily", "weekdays", "weekly", "monthly"]).optional(),
      },
    },
    async (args) =>
      run("event_create", () => deps.events.create(caller, args)),
  );

  add(
    "lounge_unschedule",
    { description: "Cancel a scheduled event that you created.", inputSchema: { id: z.number().int() } },
    async ({ id }) => run("event_cancel", () => deps.events.cancel(caller, id)),
  );

  add(
    "lounge_threads",
    {
      description:
        "List the open work threads of a channel, newest activity first. Call it before you start a thread. Join a thread that covers the work.",
      inputSchema: { channel: z.string() },
    },
    async ({ channel }) => run("lounge_channels", () => deps.threads.open(channel)),
  );

  add(
    "lounge_thread_start",
    {
      description:
        "Start a work thread under a channel. The lead (default: you) starts work on the brief at once. In the thread, write @name to hand work to another agent. Set `cwd` to the absolute path of the project folder. Without it, the thread works in a new empty folder and cannot change any project. If the channel has an open thread, the open threads come back and nothing starts. Join one with lounge_post. Set `force` and a `reason` only for separate work.",
      inputSchema: {
        channel: z.string(),
        title: z.string(),
        brief: z.string(),
        lead: z.string().optional(),
        cwd: z.string().optional(),
        force: z.boolean().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ force, reason, ...args }) =>
      run("thread_start", () => {
        const channel = deps.threads.resolveChannel(args.channel);
        if (force !== true) {
          const like = deps.threads.similar(channel, args.title);
          const open = deps.threads.open(channel);
          const existing = [...(like ? [like] : []), ...open.filter((x) => x.id !== like?.id)];
          if (existing.length > 0) {
            const first = existing[0]!;
            return {
              existing,
              note: `The channel has open threads. Do not start a new one. Join "${first.title}": post with lounge_post to room ${first.id} and write @${first.lead}. Set force to true with a reason only for separate work.`,
            };
          }
        }
        // A mention in the reason must not start turns.
        const why = force === true ? reason?.replace(/@/g, "").trim() : "";
        const brief = why ? `${args.brief}

Why a new thread: ${why}` : args.brief;
        return deps.threads.create(caller, { ...args, brief });
      }),
  );

  add(
    "lounge_nick",
    {
      description: "Set your display name in the lounge. An empty name goes back to your own name.",
      inputSchema: { name: z.string() },
    },
    async ({ name }) => run("lounge_nick", () => deps.room.setNickname(caller, name)),
  );

  add(
    "lounge_who",
    { description: "List callers with presence and adapter state.", inputSchema: {} },
    async () =>
      run("lounge_who", () =>
        presence(deps.room, deps.roster, {
          slow: deps.sessions.slow(),
          reachable: reachableCallers(deps, connected()),
        }),
      ),
  );

  add(
    "session_list",
    {
      description: "List sessions, oldest first. Filter by state.",
      inputSchema: { state: z.enum(SESSION_STATES as [SessionState, ...SessionState[]]).optional() },
    },
    async ({ state }) => run("session_list", () => deps.sessions.list(state)),
  );

  add(
    "session_open",
    {
      description: "Open a chat session with an agent. The brief is the first message.",
      inputSchema: { agent: z.string(), kind: z.string(), brief: z.string() },
    },
    async ({ agent, kind, brief }) =>
      run("session_open", () => deps.sessions.open(caller, { agent, kind, brief })),
  );

  add(
    "session_message",
    {
      description: "Send a message to a session. Waits a short time for the reply.",
      inputSchema: { id: z.string(), text: z.string() },
    },
    async ({ id, text: body }) =>
      runAsync("session_message", () => deps.sessions.message(caller, id, body)),
  );

  add(
    "session_status",
    { description: "Show the state of one session.", inputSchema: { id: z.string() } },
    async ({ id }) => run("session_status", () => deps.sessions.status(id)),
  );

  add(
    "session_close",
    { description: "Close a session. A running turn stops.", inputSchema: { id: z.string() } },
    async ({ id }) =>
      run("session_close", () => deps.sessions.close(caller, id)),
  );

  for (const tool of TOOL_MODULES) {
    add(tool.name, { description: tool.description, inputSchema: tool.input }, async (args, extra) => {
      try {
        begin();
        if (!allowed(tool.action)) return failure(`forbidden: ${caller} may not use ${tool.action}`);
        const out = await tool.run({ ...(args as Record<string, unknown>) }, { caller, deps, signal: extra.signal });
        return typeof out === "string" ? { content: [{ type: "text", text: out }] } : text(out);
      } catch (err) {
        return failureOf(err);
      }
    });
  }

  for (const tool of deps.plugins?.tools() ?? []) {
    add(
      tool.mcpName,
      { description: tool.description, inputSchema: pluginSchema(tool) },
      async (args) => {
        try {
          begin();
          if (caller !== "owner" && deps.grants && !deps.grants.allowsGroup(caller, `plugin.${tool.plugin}`)) {
            return failure(`forbidden: ${caller} may not use ${tool.mcpName}`);
          }
          const out = await tool.run({ ...(args as Record<string, unknown>) }, { caller });
          return text(typeof out === "string" ? out : (out ?? "done"));
        } catch (err) {
          return failure(`plugin ${tool.plugin}: ${(err as Error).message}`);
        }
      },
    );
  }

  return server;
}

export function createMcpHandler(deps: McpDeps, options: McpOptions = {}): McpHandler {
  const idleMs = options.idleMs ?? IDLE_MS;
  const maxPerCaller = options.maxPerCaller ?? MAX_PER_CALLER;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const sessions = new Map<string, Session>();
  // Full-token callers served without a session.
  const statelessSeen = new Map<Caller, number>();

  const drop = (id: string, reason: DropReason): void => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    log({ kind: "drop", reason, caller: session.capKey, session: id, ageMs: now() - session.startedAt });
    void session.server.close();
  };

  const sweep = (): void => {
    const cutoff = now() - idleMs;
    for (const [id, s] of sessions) if (s.lastUsed <= cutoff) drop(id, "idle");
  };

  const enforceCap = (capKey: string): void => {
    const own = [...sessions].filter(([, s]) => s.capKey === capKey);
    own.sort(([, a], [, b]) => a.lastUsed - b.lastUsed);
    for (const [id] of own.slice(0, Math.max(0, own.length - maxPerCaller))) drop(id, "cap");
  };

  // Full-token sessions show in presence.
  const connected = (): Set<Caller> => {
    const cutoff = now() - idleMs;
    const out = new Set<Caller>();
    for (const s of sessions.values()) if (s.capKey === s.caller && s.lastUsed > cutoff) out.add(s.caller);
    for (const [caller, at] of statelessSeen) if (at > cutoff) out.add(caller);
    return out;
  };

  const timer = setInterval(sweep, SWEEP_MS);
  timer.unref();

  const stopRevoke = deps.restricted.onRevoke((token) => {
    for (const [id, s] of sessions) if (s.token === token) drop(id, "revoke");
  });

  const identify = (token: string | undefined): Identity | null => {
    const caller = callerForToken(deps.tokens, token);
    if (caller) return { caller, restricted: false };
    const grant = deps.restricted.lookup(token);
    if (grant) return { caller: grant.caller, restricted: true };
    return null;
  };

  // One request on a fresh server, same token rules.
  const serveStateless = async (identity: Identity, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!identity.restricted) statelessSeen.set(identity.caller, now());
    const server = buildServer(identity, deps, connected);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res);
    } finally {
      await server.close();
    }
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const token = bearerToken(req);
    const identity = identify(token);
    if (!identity || !token) {
      sendError(res, 401, "unauthorized", { "www-authenticate": "Bearer" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (session && session.lastUsed <= now() - idleMs) drop(sessionId, "idle");
      if (!sessions.has(sessionId) || !session) {
        // Some clients never re-initialize after a 404.
        if (req.method === "POST") {
          log({ kind: "stateless", caller: identity.caller, session: sessionId });
          await serveStateless(identity, req, res);
          return;
        }
        log({ kind: "404", method: req.method ?? "", caller: identity.caller, session: sessionId });
        sendError(res, 404, "session not found");
        return;
      }
      if (session.token !== token) {
        sendError(res, 403, "session belongs to another token");
        return;
      }
      session.lastUsed = now();
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") {
      sendError(res, 400, "missing mcp-session-id");
      return;
    }

    const { caller } = identity;
    const capKey = identity.restricted ? `${caller}:restricted` : caller;
    const server = buildServer(identity, deps, connected);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        const at = now();
        sessions.set(id, { caller, capKey, token, server, transport, lastUsed: at, startedAt: at });
        enforceCap(capKey);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (!id) return;
      const open = sessions.get(id);
      if (!open) return;
      log({ kind: "drop", reason: "close", caller: open.caller, session: id, ageMs: now() - open.startedAt });
      sessions.delete(id);
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
    // A non-initialize request leaves no session.
    if (!transport.sessionId) await server.close();
  };

  return Object.assign(handler, {
    connected,
    async close(): Promise<void> {
      clearInterval(timer);
      stopRevoke();
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.all(open.map((s) => s.server.close()));
    },
  });
}
