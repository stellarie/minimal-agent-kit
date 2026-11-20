import type { ToolMode } from "./toolModes.ts";

// A roster id.
export type Agent = string;
export type Caller = Agent | "owner";

export const ROOM_ID = "lounge";
// A channel or thread post. The core checks it too.
export const MAX_TEXT = 2000;

export interface Message {
  id: number;
  roomId: string;
  author: Caller;
  text: string;
  createdAt: string;
  // "event": a channel change. "tool": work activity.
  kind?: "event" | "tool";
  attachments?: Attachment[];
  // The message this one answers.
  replyTo?: number;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

// One file of a message, as the Files tab lists it.
export interface RoomFile extends Attachment {
  author: Caller;
  messageId: number;
  createdAt: string;
}

export interface FilesPage {
  files: RoomFile[];
  // The id to pass as before for the next page, or null.
  next: number | null;
}

export const MAX_ATTACHMENT = 25 * 1024 * 1024;
export const MAX_PER_MESSAGE = 10;

export interface Channel {
  id: string;
  name: string;
  topic: string;
  // Set for a work thread: its channel.
  parent?: string;
  // Unset: no category.
  category?: string;
  // Unset: concurrent replies.
  mode?: "sequential";
  // Cooldown per agent, in seconds. Unset: off.
  slowSec?: number;
}

export interface ChannelSettings {
  mode: "concurrent" | "sequential";
  slowSec: number;
}

export const MAX_SLOW_SEC = 3600;
export const SLOW_PRESETS = [0, 10, 30, 60, 120, 300, 600, 900, 1800, 3600];

export function slowLabel(sec: number): string {
  if (sec <= 0) return "Off";
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
  return sec % 3600 === 0 ? `${sec / 3600} h` : `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}

export interface Category {
  id: string;
  name: string;
}

export interface Layout {
  categories: Category[];
  channels: Channel[];
}

// The full order for PUT /api/layout.
export interface LayoutBody {
  categories: string[];
  channels: { id: string; category: string | null }[];
}

// One switch per tool group, per agent.
export interface GrantTable {
  groups: { id: string; label: string }[];
  grants: Record<string, Record<string, boolean>>;
}

export interface ThreadInfo extends Channel {
  parent: string;
  lead: Agent;
  cwd: string;
  createdBy: Caller;
  createdAt: string;
}

export interface ThreadDraft {
  channel: string;
  title: string;
  brief: string;
  lead: Agent;
  // Empty: a new folder in the lounge home.
  cwd: string;
}

export interface BoardItem {
  id: string;
  done: boolean;
  text: string;
  owner: string;
  files?: string;
  result?: string;
}

// One .kit/tasks/*.md file: parsed, or raw text with a warning.
export type BoardTask =
  | { ok: true; name: string; title: string; status: string; owner: string; updated: string; items: BoardItem[] }
  | { ok: false; name: string; raw: string; warning: string };

// What one agent works on now.
export interface WorkState {
  agent: Agent;
  roomId: string;
  since?: string;
  tool?: string;
}

export interface Typing {
  roomId: string;
  caller: Caller;
  active: boolean;
}

export const SESSION_ROOM_PREFIX = "session-";
export const MAX_TOPIC = 1024;
export const MAX_NICKNAME = 32;

export interface LoungeEvent {
  id: number;
  roomId: string;
  title: string;
  context: string;
  at: string;
  createdBy: Caller;
  createdAt: string;
  state: "pending" | "fired" | "cancelled";
  repeat?: Repeat;
}

export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "monthly";

export const REPEAT_LABELS: Record<Repeat, string> = {
  none: "Once",
  daily: "Every day",
  weekdays: "Every weekday",
  weekly: "Every week",
  monthly: "Every month",
};

export interface EventDraft {
  room: string;
  title: string;
  context: string;
  at: string;
  repeat?: Repeat;
}

export interface Nickname {
  caller: Caller;
  name: string;
}

// A guarded action that waits for the owner.
export interface Approval {
  id: string;
  agent: string;
  tool: string;
  summary: string;
  reason: string;
  cwd?: string;
  // A blocked call that waits for a hand decision.
  danger?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface AuditEntry {
  at: string;
  agent: string;
  tool: string;
  summary: string;
  // The verdict of the rules, before any tool mode.
  verdict: "allow" | "ask" | "block";
  outcome: "allowed" | "denied" | "blocked" | "timeout" | "auto-allowed";
  reason: string;
  // True for an askable block.
  danger?: boolean;
  // "rules", "plugin:{id}", "mode", or "classifier".
  source: string;
}

export interface GuardState {
  pending: Approval[];
  // Newest first.
  recent: AuditEntry[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  error?: string;
  tools: string[];
  guards: number;
  // Runtime ids it adds. A disabled plugin lists those its manifest names.
  runtimes: string[];
  // True for a plugin that ships with the lounge.
  bundled: boolean;
  // A URL path such as /plugins/hello/panel.html.
  panel?: string;
}

export interface RuntimeOptions {
  command?: string;
  commandArgs?: string[];
  softMs?: number;
  hardMs?: number;
  // Stub runtime only.
  reply?: string;
  [key: string]: unknown;
}

export interface AgentEntry {
  id: string;
  runtime: string;
  model: string;
  effort: string;
  enabled: boolean;
  tape: 1 | 2 | 3 | 4;
  options: RuntimeOptions;
  position: number;
  retired: boolean;
  toolMode: ToolMode;
}

// An entry with the choices its runtime offers.
export interface AgentView extends AgentEntry {
  efforts: string[];
  models: string[];
  // False when its runtime is not loaded. The reason names the plugin.
  available: boolean;
  reason?: string;
}

export interface RuntimeInfo {
  id: string;
  label: string;
  // True when its tool calls reach the guard, so a tool mode works.
  toolModes: boolean;
}

export interface RosterList {
  agents: AgentView[];
  // Retired rows keep a label color for old messages.
  retired: AgentEntry[];
  runtimes: RuntimeInfo[];
}

export interface NewAgent {
  id: string;
  runtime: string;
  model?: string;
  effort?: string;
  enabled?: boolean;
  tape?: 1 | 2 | 3 | 4;
  options?: RuntimeOptions;
  toolMode?: ToolMode;
  // The display name: a nickname.
  displayName?: string;
}

export type AgentPatch = Partial<
  Pick<AgentEntry, "runtime" | "model" | "effort" | "enabled" | "tape" | "options" | "position" | "toolMode">
> & { displayName?: string };

export interface RuntimeChoices {
  efforts: string[];
  models: string[];
}

export interface LoungeEvents {
  message(m: Message): void;
  channel(c: Channel): void;
  typing(t: Typing): void;
  nickname(n: Nickname): void;
  scheduled(e: LoungeEvent): void;
  work(w: WorkState & { active: boolean }): void;
  layout(l: Layout): void;
  state(s: LinkState): void;
  approval(pending: Approval[]): void;
  // The guard log has a new entry: refetch it.
  guard(): void;
  // The roster changed: refetch the list.
  roster(): void;
  // Rooms were deleted: a channel and its threads.
  removed?(ids: string[]): void;
}

export interface Presence {
  caller: Caller;
  lastSeen: string | null;
  nickname?: string;
  reachable?: boolean;
  adapter?: "enabled" | "unavailable" | "slow";
}

export type LinkState = "connecting" | "live" | "offline";

// Same as MAX_RULES_BYTES in the core.
export const RULES_MAX_BYTES = 16 * 1024;

export interface SchedulerStatus {
  enabled: boolean;
  running: string | null;
  queued: string[];
  paused: boolean;
}

export interface LoungeClient {
  messages(roomId: string, opts?: { since?: number; before?: number; limit?: number }): Promise<Message[]>;
  post(roomId: string, text: string, attachments?: string[]): Promise<Message>;
  upload(file: File): Promise<Attachment>;
  roomFiles(roomId: string, before?: number): Promise<FilesPage>;
  // Shows the stored file in Windows Explorer.
  reveal(attachmentId: string): Promise<void>;
  channels(): Promise<Channel[]>;
  createChannel(name: string, topic: string): Promise<Channel>;
  setTopic(roomId: string, topic: string): Promise<Channel>;
  renameChannel(roomId: string, name: string): Promise<Channel>;
  setChannelSettings(roomId: string, settings: ChannelSettings): Promise<Channel>;
  // Returns the ids of the deleted rooms.
  deleteRoom(roomId: string): Promise<string[]>;
  layout(): Promise<Layout>;
  setLayout(body: LayoutBody): Promise<Layout>;
  createCategory(name: string): Promise<Category>;
  renameCategory(id: string, name: string): Promise<Category>;
  deleteCategory(id: string): Promise<void>;
  setNickname(name: string): Promise<Nickname>;
  events(): Promise<LoungeEvent[]>;
  createEvent(draft: EventDraft): Promise<LoungeEvent>;
  cancelEvent(id: number): Promise<LoungeEvent>;
  threads(): Promise<ThreadInfo[]>;
  startThread(draft: ThreadDraft): Promise<ThreadInfo>;
  stopThread(id: string): Promise<{ stopped: number }>;
  // Read only: the task files of the thread folder.
  blackboard(threadId: string): Promise<BoardTask[]>;
  work(): Promise<WorkState[]>;
  who(): Promise<Presence[]>;
  scheduler(): Promise<SchedulerStatus>;
  setScheduler(enabled: boolean): Promise<SchedulerStatus>;
  loungeRules(): Promise<{ text: string }>;
  saveLoungeRules(text: string): Promise<{ text: string }>;
  grants(): Promise<GrantTable>;
  setGrants(name: Agent, changes: Record<string, boolean>): Promise<Record<string, boolean>>;
  guard(): Promise<GuardState>;
  decide(id: string, allow: boolean): Promise<void>;
  guardRuleAsks(): Promise<{ enabled: boolean }>;
  setGuardRuleAsks(enabled: boolean): Promise<{ enabled: boolean }>;
  getBlockAsks(): Promise<{ enabled: boolean }>;
  setBlockAsks(enabled: boolean): Promise<{ enabled: boolean }>;
  agents(): Promise<RosterList>;
  addAgent(draft: NewAgent): Promise<AgentView>;
  updateAgent(id: string, patch: AgentPatch): Promise<AgentView>;
  retireAgent(id: string): Promise<void>;
  runtimeOptions(runtime: string, draft: Partial<AgentEntry>): Promise<RuntimeChoices>;
  plugins(): Promise<PluginInfo[]>;
  setPlugin(id: string, enabled: boolean): Promise<PluginInfo[]>;
  reloadPlugins(): Promise<PluginInfo[]>;
  subscribe(on: LoungeEvents): () => void;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// The core answers { error: code, message }. Show the message.
async function readFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const { message, error } = parsed as { message?: unknown; error?: unknown };
      if (typeof message === "string") return message;
      if (error !== undefined) return String(error);
    }
  } catch {
    // Body is not JSON; show it as text.
  }
  return body || `${res.status} ${res.statusText}`;
}

export function createHttpClient(token: string): LoungeClient {
  const headers = { Authorization: `Bearer ${token}` };
  const json = { "Content-Type": "application/json" };

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(path, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) throw new ApiError(res.status, await readFailure(res));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  const send = (method: string, body: unknown): RequestInit => ({ method, headers: json, body: JSON.stringify(body) });
  const room = (id: string) => `/api/rooms/${encodeURIComponent(id)}`;

  return {
    messages(roomId, opts = {}) {
      const q = new URLSearchParams();
      if (opts.since !== undefined) q.set("since", String(opts.since));
      if (opts.before !== undefined) q.set("before", String(opts.before));
      if (opts.limit !== undefined) q.set("limit", String(opts.limit));
      const qs = q.size > 0 ? `?${q}` : "";
      return call<Message[]>(`${room(roomId)}/messages${qs}`);
    },

    post(roomId, text, attachments = []) {
      return call<Message>(`${room(roomId)}/messages`, send("POST", attachments.length > 0 ? { text, attachments } : { text }));
    },

    upload(file) {
      return call<Attachment>(`/api/attachments?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
    },

    roomFiles(roomId, before) {
      const qs = before === undefined ? "" : `?before=${before}`;
      return call<FilesPage>(`${room(roomId)}/files${qs}`);
    },

    reveal(attachmentId) {
      return call<void>(`/api/attachments/${attachmentId}/reveal`, { method: "POST" });
    },

    channels() {
      return call<Channel[]>("/api/rooms");
    },

    createChannel(name, topic) {
      return call<Channel>("/api/rooms", send("POST", { name, topic }));
    },

    setTopic(roomId, topic) {
      return call<Channel>(room(roomId), send("PATCH", { topic }));
    },

    renameChannel(roomId, name) {
      return call<Channel>(room(roomId), send("PATCH", { name }));
    },

    setChannelSettings(roomId, settings) {
      return call<Channel>(room(roomId), send("PATCH", settings));
    },

    async deleteRoom(roomId) {
      const body = await call<{ removed: string[] }>(room(roomId), { method: "DELETE" });
      return body.removed;
    },

    layout() {
      return call<Layout>("/api/layout");
    },

    setLayout(body) {
      return call<Layout>("/api/layout", send("PUT", body));
    },

    createCategory(name) {
      return call<Category>("/api/categories", send("POST", { name }));
    },

    renameCategory(id, name) {
      return call<Category>(`/api/categories/${encodeURIComponent(id)}`, send("PATCH", { name }));
    },

    async deleteCategory(id) {
      await call<unknown>(`/api/categories/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    setNickname(name) {
      return call<Nickname>("/api/nickname", send("PUT", { name }));
    },

    events() {
      return call<LoungeEvent[]>("/api/events");
    },

    createEvent(draft) {
      return call<LoungeEvent>("/api/events", send("POST", draft));
    },

    cancelEvent(id) {
      return call<LoungeEvent>(`/api/events/${id}`, { method: "DELETE" });
    },

    threads() {
      return call<ThreadInfo[]>("/api/threads");
    },

    startThread(draft) {
      return call<ThreadInfo>("/api/threads", send("POST", draft));
    },

    stopThread(id) {
      return call<{ stopped: number }>(`/api/threads/${encodeURIComponent(id)}/stop`, { method: "POST" });
    },

    async blackboard(threadId) {
      const body = await call<{ tasks: BoardTask[] }>(`/api/threads/${encodeURIComponent(threadId)}/blackboard`);
      return body.tasks;
    },

    work() {
      return call<WorkState[]>("/api/work");
    },

    who() {
      return call<Presence[]>("/api/who");
    },

    scheduler() {
      return call<SchedulerStatus>("/api/scheduler");
    },

    setScheduler(enabled) {
      return call<SchedulerStatus>("/api/scheduler", send("PUT", { enabled }));
    },

    loungeRules() {
      return call<{ text: string }>("/api/lounge/rules");
    },

    saveLoungeRules(text) {
      return call<{ text: string }>("/api/lounge/rules", send("PUT", { text }));
    },

    grants() {
      return call<GrantTable>("/api/grants");
    },

    setGrants(name, changes) {
      return call<Record<string, boolean>>(`/api/grants/${encodeURIComponent(name)}`, send("PUT", changes));
    },

    guard() {
      return call<GuardState>("/api/guard");
    },

    async decide(id, allow) {
      await call<unknown>(`/api/guard/approvals/${encodeURIComponent(id)}`, send("POST", { allow }));
    },

    guardRuleAsks() {
      return call<{ enabled: boolean }>("/api/guard/rule-asks");
    },

    setGuardRuleAsks(enabled) {
      return call<{ enabled: boolean }>("/api/guard/rule-asks", send("PUT", { enabled }));
    },

    getBlockAsks() {
      return call<{ enabled: boolean }>("/api/guard/block-asks");
    },

    setBlockAsks(enabled) {
      return call<{ enabled: boolean }>("/api/guard/block-asks", send("PUT", { enabled }));
    },

    agents() {
      return call<RosterList>("/api/agents");
    },

    addAgent(draft) {
      return call<AgentView>("/api/agents", send("POST", draft));
    },

    updateAgent(id, patch) {
      return call<AgentView>(`/api/agents/${encodeURIComponent(id)}`, send("PATCH", patch));
    },

    async retireAgent(id) {
      await call<unknown>(`/api/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
    },

    runtimeOptions(runtime, draft) {
      const entry = encodeURIComponent(JSON.stringify(draft));
      return call<RuntimeChoices>(`/api/runtimes/${encodeURIComponent(runtime)}/efforts?entry=${entry}`);
    },

    async plugins() {
      return (await call<{ plugins: PluginInfo[] }>("/api/plugins")).plugins;
    },

    async setPlugin(id, enabled) {
      const body = await call<{ plugins: PluginInfo[] }>(`/api/plugins/${encodeURIComponent(id)}`, send("PUT", { enabled }));
      return body.plugins;
    },

    async reloadPlugins() {
      return (await call<{ plugins: PluginInfo[] }>("/api/plugins/reload", { method: "POST" })).plugins;
    },

    subscribe(on) {
      let socket: WebSocket | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let delay = 1000;
      let stopped = false;

      const open = () => {
        on.state("connecting");
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        const url = `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`;
        socket = new WebSocket(url);
        socket.onopen = () => {
          delay = 1000;
          on.state("live");
        };
        socket.onmessage = (ev) => {
          try {
            const data = JSON.parse(String(ev.data)) as {
              type?: string;
              message?: Message;
              channel?: Channel;
              name?: string;
              event?: LoungeEvent;
              agent?: Agent;
              tool?: string;
              categories?: Category[];
              channels?: Channel[];
              pending?: Approval[];
              ids?: unknown;
            } & Partial<Typing>;
            if (data.type === "message" && data.message) on.message(data.message);
            if (data.type === "channel" && data.channel) on.channel(data.channel);
            if (data.type === "removed" && Array.isArray(data.ids)) on.removed?.(data.ids.map(String));
            if (data.type === "layout" && Array.isArray(data.categories) && Array.isArray(data.channels)) {
              on.layout({ categories: data.categories, channels: data.channels });
            }
            if (data.type === "approval" && Array.isArray(data.pending)) on.approval(data.pending);
            if (data.type === "guard") on.guard();
            if (data.type === "roster") on.roster();
            if (data.type === "scheduled" && data.event) on.scheduled(data.event);
            if (data.type === "work" && data.agent && data.roomId) {
              on.work({ agent: data.agent, roomId: data.roomId, active: data.active === true, tool: data.tool });
            }
            if (data.type === "nickname" && data.caller && typeof data.name === "string") {
              on.nickname({ caller: data.caller, name: data.name });
            }
            if (data.type === "typing" && data.roomId && data.caller) {
              on.typing({ roomId: data.roomId, caller: data.caller, active: data.active === true });
            }
          } catch {
            // Ignore frames that are not JSON.
          }
        };
        socket.onclose = () => {
          socket = null;
          if (stopped) return;
          on.state("offline");
          retry = setTimeout(open, delay);
          delay = Math.min(delay * 2, 30000);
        };
      };

      open();
      return () => {
        stopped = true;
        clearTimeout(retry);
        socket?.close();
      };
    },
  };
}
