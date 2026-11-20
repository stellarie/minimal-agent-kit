<script lang="ts">
  import { MAX_TOPIC, slowLabel, type Channel, type ThreadInfo } from "../lib/api.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { whoColor } from "../lib/roster.svelte.ts";

  let {
    channel,
    parentName,
    thread,
    busy,
    drawer = null,
    onTopic,
    onRename,
    onWork,
    onStop,
    onParent,
    onDrawer,
    onSettings,
    onMode,
  }: {
    channel: Channel;
    // The parent channel name of a thread.
    parentName?: string;
    // Set when the room is a work thread.
    thread?: ThreadInfo;
    // An agent works in this room now.
    busy: boolean;
    // The open side drawer on small screens.
    drawer?: "channels" | "members" | null;
    onTopic: (topic: string) => Promise<void>;
    onRename: (name: string) => Promise<void>;
    onWork: () => void;
    onStop: () => Promise<void>;
    onParent: (id: string) => void;
    onDrawer?: (which: "channels" | "members") => void;
    onSettings: () => void;
    onMode: (mode: "concurrent" | "sequential") => Promise<void>;
  } = $props();

  const sequential = $derived(channel.mode === "sequential");
  let modeError = $state("");

  async function toggleMode() {
    modeError = "";
    try {
      await onMode(sequential ? "concurrent" : "sequential");
    } catch (err) {
      modeError = err instanceof Error ? err.message : String(err);
    }
  }

  let stopError = $state("");

  async function stop() {
    stopError = "";
    try {
      await onStop();
    } catch (err) {
      stopError = err instanceof Error ? err.message : String(err);
    }
  }

  let editing = $state(false);
  let draft = $state("");
  let error = $state("");
  let input = $state<HTMLInputElement>();

  $effect(() => {
    if (editing) input?.select();
  });

  function begin() {
    draft = channel.topic;
    error = "";
    editing = true;
  }

  async function save(e?: SubmitEvent) {
    e?.preventDefault();
    try {
      await onTopic(draft);
      editing = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") editing = false;
  }

  let renaming = $state(false);
  let nameDraft = $state("");
  let nameError = $state("");
  let nameInput = $state<HTMLInputElement>();

  $effect(() => {
    if (renaming) nameInput?.select();
  });

  // A room change ends an open rename.
  $effect(() => {
    void channel.id;
    renaming = false;
  });

  function beginRename() {
    nameDraft = channel.name;
    nameError = "";
    renaming = true;
  }

  async function saveName(e: SubmitEvent) {
    e.preventDefault();
    try {
      await onRename(nameDraft);
      renaming = false;
    } catch (err) {
      nameError = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<header class="head">
  {#if onDrawer}
    <button
      class="icon-btn drawer-btn"
      type="button"
      aria-expanded={drawer === "channels"}
      aria-controls="side-pane"
      onclick={() => onDrawer("channels")}
      ><span aria-hidden="true">☰</span><span class="sr-only">Channels</span></button
    >
  {/if}
  {#if channel.parent}
    <button class="crumb" type="button" onclick={() => onParent(channel.parent!)}>#{parentName ?? channel.parent}</button>
    <span class="sep" aria-hidden="true">›</span>
  {/if}
  {#if renaming}
    <form class="name-form" onsubmit={saveName}>
      <label for="channel-name" class="sr-only">Channel name</label>
      <input
        id="channel-name"
        class="field"
        maxlength="32"
        bind:value={nameDraft}
        bind:this={nameInput}
        onkeydown={(e) => e.key === "Escape" && (renaming = false)}
      />
      <button class="btn" type="submit">Rename</button>
      <button class="btn btn--soft" type="button" onclick={() => (renaming = false)}>Cancel</button>
    </form>
    {#if nameError}<p class="error" role="alert">{nameError}</p>{/if}
  {:else}
    <h1 id="room-title"><span class="hash" aria-hidden="true">{channel.parent ? "↳" : "#"}</span>{channel.name}</h1>
    {#if !channel.parent}
      <button class="rename" type="button" title="Rename this channel" onclick={beginRename}
        ><span aria-hidden="true">✎</span><span class="sr-only">Rename #{channel.name}</span></button
      >
    {/if}
  {/if}
  {#if editing}
    <form class="topic-form" onsubmit={save}>
      <label for="topic" class="sr-only">Channel topic</label>
      <input
        id="topic"
        class="field"
        maxlength={MAX_TOPIC}
        placeholder="What is this channel about?"
        bind:value={draft}
        onkeydown={onKeydown}
        bind:this={input}
      />
      <button class="btn" type="submit">Save</button>
      <button class="btn btn--soft" type="button" onclick={() => (editing = false)}>Cancel</button>
    </form>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {:else}
    <button class="topic" type="button" onclick={begin} title="Edit the channel topic">
      {channel.topic || "Add a topic"}
    </button>
  {/if}
  {#if channel.parent}
    {#if busy}<button class="btn btn--soft stop" type="button" onclick={stop}>Stop work</button>{/if}
  {:else}
    <button
      class="mode"
      class:mode--seq={sequential}
      type="button"
      aria-pressed={sequential}
      title={sequential ? "One agent replies at a time. Click to let all reply at once." : "All agents can reply at once. Click for one at a time."}
      onclick={toggleMode}
      ><span aria-hidden="true">{sequential ? "☰" : "⇶"}</span> {sequential ? "One at a time" : "All at once"}</button
    >
    {#if channel.slowSec}<span class="slow" title="Slow mode: cooldown per agent">⏱ {slowLabel(channel.slowSec)}</span>{/if}
    <button class="btn btn--soft work" type="button" onclick={onWork} title="Start a work thread in this channel">Start work</button>
  {/if}
  <button class="icon-btn gear" type="button" title="{channel.parent ? 'Thread' : 'Channel'} settings" onclick={onSettings}
    ><span aria-hidden="true">⚙</span><span class="sr-only">{channel.parent ? "Thread" : "Channel"} settings</span></button
  >
  {#if onDrawer}
    <button
      class="icon-btn drawer-btn"
      type="button"
      aria-expanded={drawer === "members"}
      aria-controls="members-pane"
      onclick={() => onDrawer("members")}
      ><span aria-hidden="true">☰</span><span class="sr-only">Members, events, and files</span></button
    >
  {/if}
  {#if thread}
    <p class="facts">
      <span class="chip" style:--who={whoColor(thread.lead)}>{nameOf(thread.lead)}</span>
      <span class="fact">leads</span>
      {#if thread.cwd}<span class="fact cwd" title={thread.cwd}>{thread.cwd}</span>{/if}
      {#if busy}<span class="fact live">working now</span>{/if}
    </p>
  {/if}
  {#if stopError}<p class="error" role="alert">{stopError}</p>{/if}
  {#if modeError}<p class="error" role="alert">{modeError}</p>{/if}
</header>

<style>
  .head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 14px;
    padding: 10px 16px;
    border-bottom: 2px solid var(--line);
  }
  h1 {
    margin: 0;
    font-size: 1.2rem;
    white-space: nowrap;
  }
  .hash { color: var(--pink); margin-right: 4px; }
  .crumb {
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font-weight: 700;
    cursor: pointer;
  }
  .crumb:hover { color: var(--pink-deep); text-decoration: underline; }
  .sep { color: var(--muted); }
  .drawer-btn { display: none; }
  .facts {
    flex-basis: 100%;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 8px;
    margin: 0;
    color: var(--muted);
    font-size: .8rem;
  }
  .cwd {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .live { color: var(--pink-deep); font-weight: 700; }
  .live::before {
    content: "";
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 5px;
    border-radius: 50%;
    background: var(--pink);
    animation: pulse 1.2s infinite ease-in-out;
  }
  @keyframes pulse {
    0%, 100% { opacity: .35; transform: scale(.85); }
    50% { opacity: 1; transform: scale(1.1); }
  }
  .work, .stop { padding: 3px 14px; font-size: .85rem; }
  .mode {
    padding: 3px 10px;
    border: 2px solid var(--line);
    border-radius: var(--r);
    background: none;
    color: var(--muted);
    font-size: .8rem;
    font-weight: 700;
    white-space: nowrap;
    cursor: pointer;
  }
  .mode:hover, .mode:focus-visible { color: var(--pink-deep); border-color: var(--pink); }
  .mode--seq { color: var(--pink-deep); background: var(--pink-soft); }
  .slow { color: var(--muted); font-size: .8rem; white-space: nowrap; }
  .gear { font-size: 1.05rem; }
  .topic {
    flex: 1;
    min-width: 0;
    padding: 2px 10px;
    border: 0;
    border-left: 2px solid var(--line);
    background: none;
    color: var(--muted);
    font-size: .9rem;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .topic:hover { color: var(--ink); }
  .rename {
    margin-left: -10px;
    padding: 0 4px;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .rename:hover, .rename:focus-visible { color: var(--pink-deep); background: var(--pink-soft); }
  .name-form { display: flex; gap: 8px; }
  .name-form .field { width: 14em; padding: 4px 12px; border-radius: var(--r); }
  .name-form .btn { padding: 4px 14px; }
  .topic-form { flex: 1; display: flex; gap: 8px; min-width: 240px; }
  .topic-form .field { padding: 4px 12px; border-radius: var(--r); }
  .topic-form .btn { padding: 4px 14px; }
  .error { flex-basis: 100%; margin: 0; }

  @media (max-width: 959px) {
    .drawer-btn { display: inline-grid; }
    .head { padding: 8px 10px; gap: 4px 8px; }
    .topic { order: 10; flex-basis: 100%; border-left: 0; padding-left: 0; }
    .topic-form { order: 10; flex-basis: 100%; }
  }
</style>
