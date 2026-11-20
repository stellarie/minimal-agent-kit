<script lang="ts">
  import { onMount, tick } from "svelte";
  import { ApiError, ROOM_ID, SESSION_ROOM_PREFIX, createHttpClient } from "./lib/api.ts";
  import type {
    Approval,
    Caller,
    Category,
    Channel,
    Layout,
    LayoutBody,
    EventDraft,
    LinkState,
    LoungeClient,
    LoungeEvent,
    Message,
    Presence,
    SchedulerStatus,
    ThreadDraft,
    ThreadInfo,
    Attachment,
    RoomFile,
    WorkState,
  } from "./lib/api.ts";
  import ThreadForm from "./components/ThreadForm.svelte";
  import EventsPanel from "./components/EventsPanel.svelte";
  import SideTabs from "./components/SideTabs.svelte";
  import FilesPanel from "./components/FilesPanel.svelte";
  import BlackboardPanel from "./components/BlackboardPanel.svelte";
  import AgentGraph from "./components/AgentGraph.svelte";
  import FilePreview from "./components/FilePreview.svelte";
  import MessageRow from "./components/MessageRow.svelte";
  import ChannelList from "./components/ChannelList.svelte";
  import ChannelHeader from "./components/ChannelHeader.svelte";
  import ChannelSettings from "./components/ChannelSettings.svelte";
  import PresenceList from "./components/PresenceList.svelte";
  import Composer from "./components/Composer.svelte";
  import PermissionsPanel from "./components/PermissionsPanel.svelte";
  import PluginsPanel from "./components/PluginsPanel.svelte";
  import SkillsPanel from "./components/SkillsPanel.svelte";
  import AgentsPanel from "./components/AgentsPanel.svelte";
  import LoungeRulesPanel from "./components/LoungeRulesPanel.svelte";
  import WikiPanel from "./lib/WikiPanel.svelte";
  import { roster, setRoster } from "./lib/roster.svelte.ts";
  import type { Item } from "./lib/complete.ts";
  import ApprovalStack from "./components/ApprovalStack.svelte";
  import TokenForm from "./components/TokenForm.svelte";
  import ThemePicker from "./components/ThemePicker.svelte";
  import FontPicker from "./components/FontPicker.svelte";
  import { ChevronsLeft, ChevronsRight } from "@lucide/svelte";
  import { takeFragmentToken } from "./lib/token.ts";
  import { continues, toolName, typingText } from "./lib/format.ts";
  import { notify, notifyApproval, type Notifier } from "./lib/notify.ts";
  import { newApprovals } from "./lib/guard.ts";
  import { nameOf, setNickname } from "./lib/names.svelte.ts";
  import { applyBody } from "./lib/layout.ts";
  import { readSideTab, writeSideTab, type SideTab } from "./lib/sidetabs.ts";

  const TOKEN_KEY = "agent-lounge.token";
  const CHANNEL_KEY = "agent-lounge.channel";
  const TOOLS_KEY = "agent-lounge.tool-calls";
  const PAGE = 200;
  const FIRST = 50;
  const OLDER = 50;
  const KEEP = 500;
  // Load older messages this close to the top.
  const NEAR_TOP = 300;

  let client = $state<LoungeClient | null>(null);
  let channels = $state<Channel[]>([{ id: ROOM_ID, name: ROOM_ID, topic: "" }]);
  let categories = $state<Category[]>([]);
  let current = $state(ROOM_ID);
  let byRoom = $state<Record<string, Message[]>>({});
  let unread = $state<Record<string, number>>({});
  let typing = $state<{ roomId: string; caller: Caller }[]>([]);
  let people = $state<Presence[]>([{ caller: "owner", lastSeen: null }]);
  let link = $state<LinkState>("offline");
  let auto = $state<SchedulerStatus | null>(null);
  let events = $state<LoungeEvent[]>([]);
  let threads = $state<ThreadInfo[]>([]);
  let work = $state<WorkState[]>([]);
  let approvals = $state<Approval[]>([]);
  // Counts guard log entries, so the log reloads on each one.
  let guardChanges = $state(0);
  let starting = $state(false);
  let problem = $state("");
  let tokenProblem = $state("");
  let now = $state(Date.now());
  let view = $state<"lounge" | "rules" | "wiki" | "permissions" | "agents" | "skills" | "plugins" | "theme">("lounge");
  const VIEWS_FOLDED_KEY = "lounge.viewsFolded";
  let viewsFolded = $state(readFolded());

  function readFolded(): boolean {
    try {
      return localStorage.getItem(VIEWS_FOLDED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function toggleViews(): void {
    viewsFolded = !viewsFolded;
    try {
      localStorage.setItem(VIEWS_FOLDED_KEY, viewsFolded ? "1" : "0");
    } catch {
      // The fold then resets on reload.
    }
  }
  let logEl: HTMLElement | undefined = $state();
  // The open side pane on small screens.
  let drawer = $state<"channels" | "members" | null>(null);
  // Rooms whose first page is loaded.
  let loaded = new Set<string>();
  // Older history per room: more to fetch, fetching, or none left.
  let older = $state<Record<string, "more" | "loading" | "done">>({});
  // Scroll top per room. A missing entry means the end.
  let scrollMem: Record<string, number> = {};
  let hideTools = $state(localStorage.getItem(TOOLS_KEY) === "hide");
  let sideTab = $state<SideTab>(readSideTab(localStorage));
  // The file in the preview dialog.
  let previewing = $state<RoomFile | null>(null);

  const VIEWS = [
    ["lounge", "Lounge"],
    ["rules", "Lounge rules"],
    ["wiki", "Wiki"],
    ["permissions", "Permissions"],
    ["agents", "Agents"],
    ["skills", "Skills"],
    ["plugins", "Plugins"],
    ["theme", "Theme"],
  ] as const;

  // The composer lists: channels for #, enabled agents for @.
  const mentionItems = $derived<Item[]>(
    roster.agents.filter((e) => e.enabled).map((e) => ({ value: `@${e.id}`, label: nameOf(e.id) })),
  );

  const channelItems = $derived<Item[]>(
    channels.map((c) => ({ value: `#${c.id}`, label: c.name })),
  );
  const messages = $derived((byRoom[current] ?? []).filter((m) => !hideTools || m.kind !== "tool"));
  const byId = $derived(new Map((byRoom[current] ?? []).map((m) => [m.id, m])));
  const busyHere = $derived(hideTools ? work.filter((w) => w.roomId === current) : []);
  const channel = $derived(channels.find((c) => c.id === current) ?? channels[0]);
  const parentName = $derived(channels.find((c) => c.id === channel.parent)?.name);
  const thread = $derived(threads.find((t) => t.id === current));
  const workingRooms = $derived(new Set(work.map((w) => w.roomId)));
  const typingNow = $derived(
    typingText(typing.filter((t) => t.roomId === current).map((t) => nameOf(t.caller))),
  );

  let unsubscribe: (() => void) | null = null;
  let presenceTimer: ReturnType<typeof setInterval> | undefined;

  const LINK_TEXT: Record<LinkState, string> = {
    connecting: "connecting",
    live: "live",
    offline: "offline",
  };

  function nearBottom(): boolean {
    if (!logEl) return true;
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 120;
  }

  async function scrollToEnd() {
    await tick();
    logEl?.scrollTo({ top: logEl.scrollHeight, behavior: "instant" });
    delete scrollMem[current];
  }

  function onLogScroll() {
    if (!logEl) return;
    if (nearBottom()) delete scrollMem[current];
    else scrollMem[current] = logEl.scrollTop;
    if (logEl.scrollTop < NEAR_TOP) void loadOlder();
  }

  // Put the log back where the owner left this room.
  async function restoreScroll() {
    await tick();
    if (!logEl) return;
    const at = scrollMem[current];
    if (at === undefined) logEl.scrollTo({ top: logEl.scrollHeight, behavior: "instant" });
    else logEl.scrollTop = at;
    if (logEl.scrollTop < NEAR_TOP) void loadOlder();
  }

  function setHideTools(hide: boolean) {
    hideTools = hide;
    localStorage.setItem(TOOLS_KEY, hide ? "hide" : "show");
    void restoreScroll();
  }

  async function loadOlder(roomId = current) {
    const first = byRoom[roomId]?.[0]?.id;
    if (!client || older[roomId] !== "more" || first === undefined) return;
    older = { ...older, [roomId]: "loading" };
    try {
      const page = await client.messages(roomId, { before: first, limit: OLDER });
      const el = logEl;
      const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
      const list = byRoom[roomId] ?? [];
      const fresh = page.filter((m) => !list.some((x) => x.id === m.id));
      byRoom = { ...byRoom, [roomId]: [...fresh, ...list].sort((a, b) => a.id - b.id) };
      older = { ...older, [roomId]: page.length < OLDER ? "done" : "more" };
      await tick();
      // Keep the same message in view.
      if (el && el === logEl && roomId === current) {
        el.scrollTop = el.scrollHeight - fromBottom;
        if (el.scrollTop < NEAR_TOP) void loadOlder(roomId);
      }
    } catch (err) {
      older = { ...older, [roomId]: "more" };
      fail(err);
    }
  }

  // live: from the socket, so it can count as unread.
  function merge(incoming: Message[], live = false) {
    const stick = nearBottom();
    const next = { ...byRoom };
    for (const m of incoming) {
      if (m.roomId.startsWith(SESSION_ROOM_PREFIX)) continue;
      const list = next[m.roomId] ?? [];
      if (list.some((x) => x.id === m.id)) continue;
      next[m.roomId] = [...list, m].sort((a, b) => a.id - b.id).slice(-Math.max(KEEP, list.length));
      if (live && m.roomId !== current && m.author !== "owner" && m.kind === undefined) {
        unread = { ...unread, [m.roomId]: (unread[m.roomId] ?? 0) + 1 };
      }
      markSeen(m.author, m.createdAt);
    }
    byRoom = next;
    if (stick) void scrollToEnd();
  }

  function markSeen(caller: string, at: string) {
    people = people.map((p) =>
      p.caller === caller && (p.lastSeen === null || p.lastSeen < at) ? { ...p, lastSeen: at } : p,
    );
  }

  function upsertChannel(c: Channel) {
    // A new thread: fetch its lead and folder.
    if (c.parent && !threads.some((t) => t.id === c.id)) void loadThreads();
    const i = channels.findIndex((x) => x.id === c.id);
    channels = i < 0 ? [...channels, c] : channels.map((x) => (x.id === c.id ? c : x));
  }

  function setTyping(roomId: string, caller: Caller, active: boolean) {
    const rest = typing.filter((t) => !(t.roomId === roomId && t.caller === caller));
    typing = active ? [...rest, { roomId, caller }] : rest;
    // Typing is activity: keep presence current.
    if (active) markSeen(caller, new Date().toISOString());
  }

  function notifyHidden(message: Message) {
    const shell = (window as unknown as { __TAURI__?: { notification?: Notifier } }).__TAURI__;
    notify(message, { hidden: document.hidden, notifier: shell?.notification, name: nameOf });
  }

  function setApprovals(next: Approval[]) {
    const shell = (window as unknown as { __TAURI__?: { notification?: Notifier } }).__TAURI__;
    for (const a of newApprovals(approvals.map((x) => x.id), next)) {
      notifyApproval(a, { hidden: document.hidden, notifier: shell?.notification, name: nameOf });
    }
    approvals = next;
  }

  async function decideApproval(id: string, allow: boolean) {
    if (!client) throw new Error("Not connected.");
    try {
      await client.decide(id, allow);
    } catch (err) {
      // 404: the card timed out or another window answered.
      if (!(err instanceof ApiError && err.status === 404)) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) fail(err);
        throw err;
      }
    }
    approvals = approvals.filter((a) => a.id !== id);
  }

  function fail(err: unknown) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      forgetToken("The core rejected this token. Paste the owner token again.");
      return;
    }
    const unreachable = !(err instanceof ApiError) || [502, 503, 504].includes(err.status);
    problem = unreachable
      ? "Cannot reach the core at 127.0.0.1:47621. Start it, then reload."
      : `The core answered: ${err.message}`;
  }

  async function loadRoster() {
    if (!client) return;
    try {
      const list = await client.agents();
      setRoster(list.agents, list.runtimes, list.retired);
    } catch (err) {
      fail(err);
    }
  }

  // A roster change moves the list and presence.
  function rosterChanged() {
    void loadRoster();
    void refreshPresence();
  }

  async function refreshPresence() {
    if (!client) return;
    try {
      people = await client.who();
      for (const p of people) setNickname(p.caller, p.nickname ?? "");
      auto = await client.scheduler();
    } catch (err) {
      fail(err);
    }
  }

  async function toggleAuto() {
    if (!client || !auto) return;
    try {
      auto = await client.setScheduler(!auto.enabled);
    } catch (err) {
      fail(err);
    }
  }

  async function loadChannels() {
    if (!client) return;
    try {
      setLayoutState(await client.layout());
      if (!channels.some((c) => c.id === current)) current = channels[0]?.id ?? ROOM_ID;
    } catch (err) {
      fail(err);
    }
  }

  async function catchUp(roomId = current) {
    if (!client) return;
    try {
      let last = byRoom[roomId]?.at(-1)?.id;
      // A live message may arrive before the first visit.
      if (last === undefined || !loaded.has(roomId)) {
        const page = await client.messages(roomId, { limit: FIRST });
        merge(page);
        loaded.add(roomId);
        older = { ...older, [roomId]: page.length < FIRST ? "done" : "more" };
      } else {
        for (;;) {
          const page = await client.messages(roomId, { since: last, limit: PAGE });
          merge(page);
          if (page.length < PAGE) break;
          last = page[page.length - 1].id;
        }
      }
      problem = "";
    } catch (err) {
      fail(err);
    }
  }

  async function pick(id: string) {
    starting = false;
    drawer = null;
    current = id;
    localStorage.setItem(CHANNEL_KEY, id);
    unread = { ...unread, [id]: 0 };
    await restoreScroll();
    await catchUp(id);
    await restoreScroll();
  }

  // The log mounts again after a view switch.
  $effect(() => {
    if (logEl) void restoreScroll();
  });

  async function createChannel(name: string) {
    if (!client) throw new Error("Not connected.");
    const c = await client.createChannel(name, "");
    upsertChannel(c);
    await pick(c.id);
  }

  function upsertWork(w: WorkState & { active: boolean }) {
    const rest = work.filter((x) => !(x.agent === w.agent && x.roomId === w.roomId));
    work = w.active ? [...rest, { agent: w.agent, roomId: w.roomId, since: w.since, tool: w.tool }] : rest;
  }

  async function loadThreads() {
    if (!client) return;
    try {
      threads = await client.threads();
      work = await client.work();
    } catch (err) {
      fail(err);
    }
  }

  async function startThread(draft: ThreadDraft) {
    if (!client) throw new Error("Not connected.");
    const t = await client.startThread(draft);
    threads = [...threads.filter((x) => x.id !== t.id), t];
    upsertChannel(t);
    await pick(t.id);
  }

  async function stopThread() {
    if (!client) throw new Error("Not connected.");
    await client.stopThread(current);
  }

  function toolLines(caller: string, roomId: string): Message[] {
    return (byRoom[roomId] ?? []).filter((m) => m.author === caller && m.kind === "tool");
  }

  async function openWork(roomId: string) {
    await pick(roomId);
  }

  function upsertEvent(e: LoungeEvent) {
    events = [...events.filter((x) => x.id !== e.id), e];
  }

  async function loadEvents() {
    if (!client) return;
    try {
      events = await client.events();
    } catch (err) {
      fail(err);
    }
  }

  async function createEvent(draft: EventDraft) {
    if (!client) throw new Error("Not connected.");
    upsertEvent(await client.createEvent(draft));
  }

  async function cancelEvent(id: number) {
    if (!client) throw new Error("Not connected.");
    upsertEvent(await client.cancelEvent(id));
  }

  async function rename(name: string) {
    if (!client) throw new Error("Not connected.");
    const n = await client.setNickname(name);
    setNickname(n.caller, n.name);
  }

  function setLayoutState(l: Layout) {
    categories = l.categories;
    channels = l.channels;
  }

  // Show the move at once; the server frame confirms it.
  async function moveLayout(body: LayoutBody) {
    if (!client) return;
    setLayoutState(applyBody({ categories, channels }, body));
    try {
      setLayoutState(await client.setLayout(body));
    } catch (err) {
      fail(err);
      await loadChannels();
    }
  }

  async function renameChannel(name: string) {
    if (!client) throw new Error("Not connected.");
    upsertChannel(await client.renameChannel(current, name));
  }

  async function createCategory(name: string) {
    if (!client) throw new Error("Not connected.");
    await client.createCategory(name);
    await loadChannels();
  }

  async function renameCategory(id: string, name: string) {
    if (!client) throw new Error("Not connected.");
    await client.renameCategory(id, name);
    await loadChannels();
  }

  async function deleteCategory(id: string) {
    if (!client) throw new Error("Not connected.");
    await client.deleteCategory(id);
    await loadChannels();
  }

  let settingsOpen = $state(false);

  async function saveChannelMode(mode: "concurrent" | "sequential") {
    if (!client) throw new Error("Not connected.");
    upsertChannel(await client.setChannelSettings(current, { mode, slowSec: channel.slowSec ?? 0 }));
  }

  async function saveSettings(settings: { mode: "concurrent" | "sequential"; slowSec: number }) {
    if (!client) throw new Error("Not connected.");
    upsertChannel(await client.setChannelSettings(current, settings));
  }

  async function deleteRoom() {
    if (!client) throw new Error("Not connected.");
    removeRooms(await client.deleteRoom(current));
  }

  // A deleted current room goes back to its channel.
  function removeRooms(ids: string[]) {
    const gone = new Set(ids);
    if (gone.has(current)) {
      const parent = channels.find((c) => c.id === current)?.parent;
      settingsOpen = false;
      void pick(parent && !gone.has(parent) ? parent : ROOM_ID);
    }
    channels = channels.filter((c) => !gone.has(c.id));
    threads = threads.filter((t) => !gone.has(t.id));
  }

  async function saveTopic(topic: string) {
    if (!client) throw new Error("Not connected.");
    upsertChannel(await client.setTopic(current, topic));
  }

  function start(c: LoungeClient) {
    stop();
    client = c;
    problem = "";
    current = localStorage.getItem(CHANNEL_KEY) ?? ROOM_ID;
    unsubscribe = c.subscribe({
      message: (m) => {
        merge([m], true);
        notifyHidden(m);
      },
      channel: upsertChannel,
      removed: removeRooms,
      layout: setLayoutState,
      typing: (t) => setTyping(t.roomId, t.caller, t.active),
      nickname: (n) => setNickname(n.caller, n.name),
      roster: rosterChanged,
      scheduled: upsertEvent,
      work: upsertWork,
      approval: setApprovals,
      guard: () => {
        guardChanges += 1;
      },
      state: (state) => {
        link = state;
        // The core forgets typing on restart.
        if (state !== "live") typing = [];
        // Offline, a card cannot be answered.
        if (state === "offline") approvals = [];
        if (state === "live") {
          void loadChannels().then(() => catchUp());
          void loadRoster();
          void loadEvents();
          void loadThreads();
        }
      },
    });
    void loadChannels().then(() => catchUp().then(restoreScroll));
    void loadRoster();
    void refreshPresence();
    void loadEvents();
    void loadThreads();
    presenceTimer = setInterval(refreshPresence, 20_000);
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
    clearInterval(presenceTimer);
    client = null;
    link = "offline";
    typing = [];
    work = [];
    approvals = [];
    previewing = null;
  }

  function saveToken(token: string) {
    sessionStorage.setItem(TOKEN_KEY, token);
    tokenProblem = "";
    start(createHttpClient(token));
  }

  function forgetToken(reason = "") {
    sessionStorage.removeItem(TOKEN_KEY);
    stop();
    byRoom = {};
    unread = {};
    loaded = new Set();
    older = {};
    scrollMem = {};
    tokenProblem = reason;
  }

  function pickSideTab(tab: SideTab) {
    sideTab = tab;
    writeSideTab(localStorage, tab);
  }

  function toggleDrawer(which: "channels" | "members") {
    drawer = drawer === which ? null : which;
  }

  // Move focus into an open drawer; Escape closes it.
  $effect(() => {
    if (!drawer) return;
    const id = drawer === "channels" ? "side-pane" : "members-pane";
    void tick().then(() => document.getElementById(id)?.focus());
  });

  function onKey(e: KeyboardEvent) {
    // The open preview takes this Escape for itself.
    if (e.key === "Escape" && drawer && !previewing) drawer = null;
  }

  async function send(text: string, files: Attachment[] = []) {
    if (!client) throw new Error("Not connected.");
    try {
      merge([await client.post(current, text, files.map((f) => f.id))]);
      await scrollToEnd();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) fail(err);
      throw err;
    }
  }

  onMount(() => {
    const clock = setInterval(() => (now = Date.now()), 30_000);

    const fromFragment = takeFragmentToken(location, history);
    if (fromFragment) sessionStorage.setItem(TOKEN_KEY, fromFragment);
    const token = fromFragment ?? sessionStorage.getItem(TOKEN_KEY);
    if (token) start(createHttpClient(token));

    return () => {
      clearInterval(clock);
      stop();
    };
  });
</script>

<svelte:window onkeydown={onKey} />

<a class="skip" href="#composer">Skip to the message box</a>

<div class="app">
<header class="topbar">
  <span class="brand"><span class="mark" aria-hidden="true"></span>agent lounge</span>
  <div class="views-wrap">
  <button
    class="btn btn--soft fold"
    type="button"
    aria-expanded={!viewsFolded}
    aria-controls="views-nav"
    title={viewsFolded ? "Show the views" : "Fold the views"}
    onclick={toggleViews}
  >
    {#if viewsFolded}<ChevronsLeft size={18} aria-hidden="true" />{:else}<ChevronsRight size={18} aria-hidden="true" />{/if}
    <span class="sr-only">{viewsFolded ? "Show the views" : "Fold the views"}</span>
  </button>
  <nav class="seg views" id="views-nav" aria-label="Views" hidden={viewsFolded}>
    {#each VIEWS as [id, label] (id)}
      <button
        type="button"
        aria-pressed={view === id}
        onclick={() => (view = id)}
      >{label}</button>
    {/each}
  </nav>
  </div>
  <div class="tools">
    <span class="link link--{link}" role="status">
      <span class="sr-only">Connection:</span>
      {LINK_TEXT[link]}
    </span>
    {#if client}
      <button class="btn btn--soft small" type="button" onclick={() => forgetToken()}>Forget token</button>
    {/if}
    <button
      class="switch small"
      type="button"
      aria-pressed={!hideTools}
      onclick={() => setHideTools(!hideTools)}
      title="When off, the log hides tool lines and shows who is working."
    >
      Tool calls
    </button>
  </div>
</header>

<main class="single theme-page" hidden={view !== "theme"}>
  <h1 class="view-title">theme</h1>
  <div class="theme-grid">
    <section class="sticker" aria-label="Font"><h2>Font</h2><FontPicker inline /></section>
    <section class="sticker" aria-label="Colors"><h2>Colors</h2><ThemePicker inline /></section>
  </div>
</main>

{#if view === "theme"}
  <!-- The theme page above stays mounted, so the saved theme applies at start. -->
{:else if view === "rules" || view === "wiki" || view === "permissions" || view === "agents" || view === "skills" || view === "plugins"}
  <main class="single">
    {#if problem}
      <p class="problem" role="alert">{problem}</p>
    {/if}
    {#if client && view === "rules"}
      <LoungeRulesPanel {client} />
    {:else if client && view === "wiki"}
      <WikiPanel {client} />
    {:else if client && view === "permissions"}
      <PermissionsPanel {client} pending={approvals.length} changes={guardChanges} />
    {:else if client && view === "agents"}
      <AgentsPanel {client} onChange={rosterChanged} />
    {:else if client && view === "skills"}
      <SkillsPanel {client} />
    {:else if client}
      <PluginsPanel {client} />
    {:else}
      <TokenForm problem={tokenProblem} onSave={saveToken} />
    {/if}
  </main>
{:else if !client}
  <main class="single">
    {#if problem}
      <p class="problem" role="alert">{problem}</p>
    {/if}
    <TokenForm problem={tokenProblem} onSave={saveToken} />
  </main>
{:else}
  <main class="discord" class:drawer-open={drawer !== null}>
    {#if drawer}
      <button class="scrim" type="button" aria-label="Close the side pane" onclick={() => (drawer = null)}></button>
    {/if}
    <aside class="pane side" id="side-pane" class:open={drawer === "channels"} tabindex="-1">
      <ChannelList
        layout={{ categories, channels }}
        {current}
        {unread}
        working={workingRooms}
        onPick={pick}
        onCreate={createChannel}
        onMove={moveLayout}
        onCreateCategory={createCategory}
        onRenameCategory={renameCategory}
        onDeleteCategory={deleteCategory}
      />
    </aside>

    <section class="pane room" aria-labelledby="room-title">
      <ChannelHeader
        {channel}
        {parentName}
        {thread}
        {drawer}
        busy={workingRooms.has(current)}
        onTopic={saveTopic}
        onRename={renameChannel}
        onWork={() => (starting = !starting)}
        onStop={stopThread}
        onParent={pick}
        onDrawer={toggleDrawer}
        onSettings={() => (settingsOpen = true)}
        onMode={saveChannelMode}
      />
      {#if settingsOpen}
        {#key channel.id}
          <ChannelSettings
            {channel}
            threadCount={channels.filter((c) => c.parent === channel.id).length}
            onSave={saveSettings}
            onDelete={deleteRoom}
            onClose={() => (settingsOpen = false)}
          />
        {/key}
      {/if}
      {#if starting && !channel.parent}
        <ThreadForm {channel} onStart={startThread} onClose={() => (starting = false)} />
      {/if}
      {#if problem}
        <p class="problem" role="alert">{problem}</p>
      {/if}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="log" role="log" aria-label="Messages in #{channel.name}" tabindex="0" bind:this={logEl} onscroll={onLogScroll}>
        {#if older[current] === "loading"}
          <p class="older" role="status">Loading older messages…</p>
        {:else if older[current] === "more"}
          <button class="older older--btn" type="button" onclick={() => void loadOlder()}>Load older messages</button>
        {:else if older[current] === "done" && messages.length > 0}
          <p class="older">This is the start of #{channel.name}.</p>
        {/if}
        {#each messages as message, i (message.id)}
          <MessageRow
            {message}
            {now}
            grouped={continues(messages[i - 1], message)}
            quoted={message.replyTo === undefined ? undefined : byId.get(message.replyTo)}
          />
        {:else}
          <p class="empty">This is the start of #{channel.name}. Say hello.</p>
        {/each}
      </div>
      {#if busyHere.length > 0}
        <p class="working" role="status">
          {#each busyHere as w (w.agent)}
            <span class="busy">
              <span class="gear" aria-hidden="true">⚙</span>
              <strong>{nameOf(w.agent)}</strong> is working{#if w.tool}, using <code>{toolName(w.tool)}</code>{/if}
            </span>
          {/each}
        </p>
      {/if}
      <Composer
        disabled={!client}
        channel={channel.name}
        mentions={mentionItems}
        channels={channelItems}
        onSend={send}
        onUpload={(f) => client!.upload(f)}
      />
      <p class="typing" aria-live="polite">
        {#if typingNow}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>{typingNow}{/if}
      </p>
    </section>

    <aside class="pane members" id="members-pane" class:open={drawer === "members"} tabindex="-1" aria-labelledby="side-tabs-title">
      <SideTabs tab={sideTab} onSelect={pickSideTab} />
      <div role="tabpanel" id="side-panel-{sideTab}" aria-labelledby="side-tab-{sideTab}">
        {#if sideTab === "members"}
          <div class="members-head">
            <h2 id="presence-title" class="section-title">Members</h2>
            {#if auto}
              <button
                class="switch"
                type="button"
                aria-pressed={auto.enabled}
                onclick={toggleAuto}
                title="When on, the agents reply in every channel on their own."
              >
                Auto replies
              </button>
            {/if}
          </div>
          {#if auto?.enabled && auto.paused}
            <p class="auto-note">Auto replies pause until you write.</p>
          {/if}
          <PresenceList
            {people}
            {now}
            onRename={rename}
            {work}
            {channels}
            {toolLines}
            onOpen={openWork}
          />
        {:else if sideTab === "events"}
          <EventsPanel {events} {channels} {current} onCreate={createEvent} onCancel={cancelEvent} />
        {:else if sideTab === "board"}
          <AgentGraph {client} threadId={thread?.id} {work} />
          <BlackboardPanel {client} threadId={thread?.id} />
        {:else}
          <FilesPanel
            {client}
            roomId={current}
            messages={byRoom[current] ?? []}
            {now}
            onOpen={(file) => (previewing = file)}
            onError={fail}
          />
        {/if}
      </div>
    </aside>
  </main>
{/if}
</div>

{#if client && previewing}
  <FilePreview file={previewing} {client} onClose={() => (previewing = null)} />
{/if}

<ApprovalStack {approvals} {now} onDecide={decideApproval} />

<style>
  .app {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    height: 100dvh;
  }
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 16px;
    padding: 10px 16px;
  }
  .brand {
    font-family: var(--font-pop);
    font-size: 1.2rem;
    white-space: nowrap;
  }
  .mark {
    display: inline-block;
    width: .7em;
    height: .7em;
    margin-right: 8px;
    border-radius: 2px;
    background: var(--pink);
  }
  .views { flex: 0 1 auto; flex-wrap: wrap; max-width: 100%; }
  .views-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; margin-left: auto; }
  .views[hidden] { display: none; }
  .fold { display: grid; place-items: center; padding: 4px 6px; }
  .theme-page[hidden] { display: none; }
  .theme-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; max-width: 820px; margin: 0 auto; padding: 0 16px 24px; }
  .theme-grid .sticker { padding: 12px 16px; }
  .theme-grid h2 { margin: 0 0 8px; font-size: 1rem; }
  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .small { padding: 4px 12px; font-size: .85rem; }
  .link {
    padding: 2px 12px;
    border-radius: var(--r);
    background: var(--card);
    border: 1px dashed var(--line);
    font-size: .8rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .link--live { border-style: solid; border-color: var(--pink); }
  .link--live::before { content: "● "; color: var(--pink-deep); }

  .single { width: 100%; max-width: 1080px; margin: 0 auto; padding: 8px 16px 16px; overflow-y: auto; }

  .discord {
    position: relative;
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr) 260px;
    gap: 10px;
    min-height: 0;
    padding: 0 10px 10px;
  }
  .pane {
    min-height: 0;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow);
  }
  .pane:focus { outline: none; }
  .side { overflow-y: auto; }
  .room {
    display: flex;
    flex-direction: column;
  }
  .scrim { display: none; }
  .log {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 0 12px;
    scrollbar-color: var(--line) transparent;
  }
  .empty { color: var(--muted); text-align: center; margin-top: 24px; }
  .problem {
    margin: 8px 16px;
    padding: 10px 16px;
    background: var(--pink-soft);
    border-radius: var(--r-lg);
    font-weight: 700;
  }
  .older {
    display: block;
    margin: 8px auto;
    color: var(--muted);
    font-size: .8rem;
    text-align: center;
  }
  .older--btn {
    padding: 4px 12px;
    border: 1px dashed var(--line);
    border-radius: var(--r);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: .8rem;
    cursor: pointer;
  }
  .working {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin: 0;
    padding: 4px 18px;
    color: var(--muted);
    font-size: .8rem;
  }
  .working .gear { display: inline-block; animation: spin 2s linear infinite; }
  .working code { font-size: .8rem; }
  @keyframes spin { to { transform: rotate(1turn); } }
  @media (prefers-reduced-motion: reduce) {
    .working .gear { animation: none; }
  }
  .typing {
    min-height: 1.4em;
    margin: 0;
    padding: 0 18px 8px;
    color: var(--muted);
    font-size: .8rem;
  }
  .dots { display: inline-flex; gap: 3px; margin-right: 6px; }
  .dots i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--pink);
    animation: bounce 1.2s infinite ease-in-out;
  }
  .dots i:nth-child(2) { animation-delay: .15s; }
  .dots i:nth-child(3) { animation-delay: .3s; }
  @keyframes bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: .5; }
    30% { transform: translateY(-4px); opacity: 1; }
  }

  .members { padding: 14px 12px; overflow-y: auto; }
  .members-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }
  .auto-note { margin: -4px 0 10px; color: var(--muted); font-size: .8rem; }

  @media (max-width: 599px) {
    .views button { padding: 4px 8px; }
  }

  @media (max-width: 959px) {
    .topbar { padding: 8px 10px; gap: 6px 10px; }
    .brand { font-size: 1.05rem; }
    .discord {
      grid-template-columns: minmax(0, 1fr);
      padding: 0 6px 6px;
    }
    .side, .members {
      position: fixed;
      top: 0;
      bottom: 0;
      z-index: 30;
      width: min(320px, 86vw);
      border-radius: 0;
      box-shadow: none;
      transition: transform .2s ease;
    }
    .side { left: 0; border-width: 0 1px 0 0; transform: translateX(-100%); }
    .members { right: 0; border-width: 0 0 0 1px; transform: translateX(100%); }
    .side.open, .members.open { transform: none; }
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 25;
      border: 0;
      background: var(--ink);
      opacity: .35;
      cursor: pointer;
    }
  }
</style>
