<script lang="ts">
  import { tick } from "svelte";
  import type { Category, Channel, Layout, LayoutBody } from "../lib/api.ts";
  import {
    groups,
    moveCategory,
    moveChannel,
    sameBody,
    stepCategory,
    stepChannel,
    toBody,
    type Drop,
  } from "../lib/layout.ts";

  let {
    layout,
    current,
    unread,
    working,
    onPick,
    onCreate,
    onMove,
    onCreateCategory,
    onRenameCategory,
    onDeleteCategory,
  }: {
    layout: Layout;
    current: string;
    unread: Record<string, number>;
    // Rooms where an agent works now.
    working: ReadonlySet<string>;
    onPick: (id: string) => void;
    onCreate: (name: string) => Promise<void>;
    onMove: (body: LayoutBody) => Promise<void>;
    onCreateCategory: (name: string) => Promise<void>;
    onRenameCategory: (id: string, name: string) => Promise<void>;
    onDeleteCategory: (id: string) => Promise<void>;
  } = $props();

  const FOLD_KEY = "agent-lounge.folded";

  let menu = $state(false);
  let adding = $state<"channel" | "category" | null>(null);
  let name = $state("");
  let error = $state("");
  let input = $state<HTMLInputElement>();
  let announce = $state("");

  let folded = $state<string[]>(readFolded());
  let renaming = $state<string | null>(null);
  let renameDraft = $state("");
  let renameInput = $state<HTMLInputElement>();

  let dragging = $state<{ type: "channel" | "category"; id: string } | null>(null);
  let hint = $state<{ kind: "channel"; drop: Drop } | { kind: "category"; before: string | null } | null>(null);

  const list = $derived(groups(layout));
  const threadsOf = (id: string) => layout.channels.filter((c) => c.parent === id);
  const nameOfChannel = (id: string) => layout.channels.find((c) => c.id === id)?.name ?? id;
  const nameOfCategory = (id: string | null) =>
    id === null ? "no category" : (layout.categories.find((c) => c.id === id)?.name ?? id);

  function readFolded(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]");
      return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  function toggleFold(id: string) {
    folded = folded.includes(id) ? folded.filter((x) => x !== id) : [...folded, id];
    localStorage.setItem(FOLD_KEY, JSON.stringify(folded));
  }

  $effect(() => {
    if (adding) input?.focus();
  });

  $effect(() => {
    if (renaming) renameInput?.select();
  });

  function open(kind: "channel" | "category") {
    menu = false;
    adding = kind;
    name = "";
    error = "";
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    error = "";
    try {
      if (adding === "category") await onCreateCategory(name);
      else await onCreate(name);
      name = "";
      adding = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  function beginRename(c: Category) {
    renaming = c.id;
    renameDraft = c.name;
    error = "";
  }

  async function saveRename(e: SubmitEvent, id: string) {
    e.preventDefault();
    try {
      await onRenameCategory(id, renameDraft);
      renaming = null;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function remove(c: Category) {
    if (!confirm(`Delete the category "${c.name}"? Its channels stay, with no category.`)) return;
    try {
      await onDeleteCategory(c.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function commit(body: LayoutBody, message: string) {
    if (sameBody(body, toBody(layout))) return;
    announce = message;
    await onMove(body);
  }

  // Drag and drop

  function startDrag(e: DragEvent, type: "channel" | "category", id: string) {
    dragging = { type, id };
    e.dataTransfer?.setData("text/plain", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  function endDrag() {
    dragging = null;
    hint = null;
  }

  const upper = (e: DragEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  };

  function overChannel(e: DragEvent, groupIndex: number, index: number) {
    if (dragging?.type !== "channel") return;
    e.preventDefault();
    e.stopPropagation();
    const g = list[groupIndex]!;
    const next = upper(e) ? g.channels[index] : g.channels[index + 1];
    hint = next
      ? { kind: "channel", drop: { kind: "before", id: next.id } }
      : { kind: "channel", drop: { kind: "into", category: g.category?.id ?? null } };
  }

  function overGroup(e: DragEvent, groupIndex: number) {
    if (!dragging) return;
    e.preventDefault();
    const g = list[groupIndex]!;
    if (dragging.type === "channel") {
      hint = { kind: "channel", drop: { kind: "into", category: g.category?.id ?? null } };
      return;
    }
    const cats = layout.categories;
    if (!g.category) {
      hint = { kind: "category", before: cats[0]?.id ?? null };
      return;
    }
    const at = cats.findIndex((c) => c.id === g.category!.id);
    hint = { kind: "category", before: upper(e) ? g.category.id : (cats[at + 1]?.id ?? null) };
  }

  async function drop(e: DragEvent) {
    e.preventDefault();
    const d = dragging;
    const h = hint;
    endDrag();
    if (!d || !h) return;
    if (d.type === "channel" && h.kind === "channel") {
      const body = moveChannel(layout, d.id, h.drop);
      const cat = body.channels.find((x) => x.id === d.id)?.category ?? null;
      await commit(body, `Moved #${nameOfChannel(d.id)} to ${nameOfCategory(cat)}.`);
    }
    if (d.type === "category" && h.kind === "category") {
      await commit(moveCategory(layout, d.id, h.before), `Moved the category ${nameOfCategory(d.id)}.`);
    }
  }

  const isDropBefore = (id: string) => hint?.kind === "channel" && hint.drop.kind === "before" && hint.drop.id === id;
  const isDropEnd = (cat: string | null) =>
    hint?.kind === "channel" && hint.drop.kind === "into" && hint.drop.category === cat;
  const isCatBefore = (id: string | null) => hint?.kind === "category" && hint.before === id;

  // Keyboard moves: Alt+ArrowUp and Alt+ArrowDown.

  async function keyChannel(e: KeyboardEvent, id: string) {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const body = stepChannel(layout, id, e.key === "ArrowUp" ? -1 : 1);
    const pos = body.channels.findIndex((x) => x.id === id);
    const cat = body.channels[pos]?.category ?? null;
    await commit(body, `#${nameOfChannel(id)} is now at place ${pos + 1}, in ${nameOfCategory(cat)}.`);
    await tick();
    document.querySelector<HTMLElement>(`[data-channel="${CSS.escape(id)}"]`)?.focus();
  }

  async function keyCategory(e: KeyboardEvent, id: string) {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    const body = stepCategory(layout, id, e.key === "ArrowUp" ? -1 : 1);
    await commit(body, `${nameOfCategory(id)} is now category ${body.categories.indexOf(id) + 1}.`);
    await tick();
    document.querySelector<HTMLElement>(`[data-category="${CSS.escape(id)}"]`)?.focus();
  }
</script>

{#snippet row(c: Channel, thread: boolean)}
  <button
    type="button"
    class="channel"
    class:thread
    class:unread={(unread[c.id] ?? 0) > 0}
    aria-current={c.id === current ? "page" : undefined}
    title={c.topic || undefined}
    data-channel={thread ? undefined : c.id}
    aria-keyshortcuts={thread ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
    onclick={() => onPick(c.id)}
    onkeydown={thread ? undefined : (e) => keyChannel(e, c.id)}
  >
    <span class="hash" aria-hidden="true">{thread ? "↳" : "#"}</span>
    <span class="name">{c.name}{#if thread}<span class="sr-only"> (thread)</span>{/if}</span>
    {#if working.has(c.id)}
      <span class="busy" title="Someone is working here"><span class="sr-only">work in progress</span></span>
    {/if}
    {#if (unread[c.id] ?? 0) > 0}
      <span class="badge">{unread[c.id]}<span class="sr-only"> unread</span></span>
    {/if}
  </button>
{/snippet}

<nav class="channels" aria-labelledby="channels-title">
  <div class="title-row">
    <h2 id="channels-title" class="section-title">Channels</h2>
    <div class="menu-wrap">
      <button
        class="icon-btn"
        type="button"
        aria-expanded={menu}
        aria-haspopup="menu"
        title="Create a channel or a category"
        onclick={() => (menu = !menu)}
        ><span aria-hidden="true">+</span><span class="sr-only">Create a channel or a category</span></button
      >
      {#if menu}
        <div class="menu" role="menu">
          <button type="button" role="menuitem" onclick={() => open("channel")}>New channel</button>
          <button type="button" role="menuitem" onclick={() => open("category")}>New category</button>
        </div>
      {/if}
    </div>
  </div>
  {#if adding}
    <form class="new" onsubmit={create}>
      <label for="new-name" class="sr-only">{adding === "category" ? "New category name" : "New channel name"}</label>
      <input
        id="new-name"
        class="field"
        placeholder={adding === "category" ? "New category" : "new-channel"}
        maxlength={adding === "category" ? 32 : 40}
        bind:value={name}
        bind:this={input}
        onkeydown={(e) => e.key === "Escape" && (adding = null)}
      />
    </form>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#each list as g, gi (g.category?.id ?? "")}
    {@const catId = g.category?.id ?? null}
    {@const isFolded = catId !== null && folded.includes(catId)}
    <section
      class="group"
      class:drop-before={catId !== null && isCatBefore(catId)}
      class:dragging={dragging?.type === "category" && dragging.id === catId}
      aria-label={g.category ? g.category.name : "Channels with no category"}
      ondragover={(e) => overGroup(e, gi)}
      ondrop={drop}
    >
      {#if g.category}
        {@const cat = g.category}
        <div class="cat-head" draggable={renaming !== cat.id} ondragstart={(e) => startDrag(e, "category", cat.id)} ondragend={endDrag} role="presentation">
          {#if renaming === cat.id}
            <form class="cat-rename" onsubmit={(e) => saveRename(e, cat.id)}>
              <label for="cat-name-{cat.id}" class="sr-only">Category name</label>
              <input
                id="cat-name-{cat.id}"
                class="field"
                maxlength="32"
                bind:value={renameDraft}
                bind:this={renameInput}
                onkeydown={(e) => e.key === "Escape" && (renaming = null)}
                onblur={() => (renaming = null)}
              />
            </form>
          {:else}
            <button
              type="button"
              class="cat"
              data-category={cat.id}
              aria-expanded={!isFolded}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onclick={() => toggleFold(cat.id)}
              onkeydown={(e) => keyCategory(e, cat.id)}
            >
              <span class="caret" class:folded={isFolded} aria-hidden="true">▾</span>
              <span class="cat-name">{cat.name}</span>
            </button>
            <button type="button" class="tool" title="Rename {cat.name}" onclick={() => beginRename(cat)}
              ><span aria-hidden="true">✎</span><span class="sr-only">Rename the category {cat.name}</span></button
            >
            <button type="button" class="tool" title="Delete {cat.name}" onclick={() => remove(cat)}
              ><span aria-hidden="true">×</span><span class="sr-only">Delete the category {cat.name}</span></button
            >
          {/if}
        </div>
      {/if}
      <ul class:drop-end={isDropEnd(catId)} class:empty={g.channels.length === 0}>
        {#each g.channels as c, ci (c.id)}
          {#if !isFolded || c.id === current || (unread[c.id] ?? 0) > 0}
            {@const threads = threadsOf(c.id)}
            <li
              class:drop-before={isDropBefore(c.id)}
              class:dragging={dragging?.type === "channel" && dragging.id === c.id}
              draggable="true"
              ondragstart={(e) => startDrag(e, "channel", c.id)}
              ondragend={endDrag}
              ondragover={(e) => overChannel(e, gi, ci)}
            >
              {@render row(c, false)}
              {#if threads.length > 0 && !isFolded}
                <ul class="threads" aria-label="Threads in #{c.name}">
                  {#each threads as th (th.id)}
                    <li>{@render row(th, true)}</li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/if}
        {/each}
        {#if g.channels.length === 0 && g.category && dragging?.type === "channel"}
          <li class="placeholder" aria-hidden="true">Drop a channel here</li>
        {/if}
      </ul>
    </section>
  {/each}
  {#if dragging?.type === "category"}
    <div
      class="cat-end"
      class:drop-before={isCatBefore(null)}
      role="presentation"
      ondragover={(e) => {
        e.preventDefault();
        hint = { kind: "category", before: null };
      }}
      ondrop={drop}
    ></div>
  {/if}
  <p class="sr-only" aria-live="polite">{announce}</p>
</nav>

<style>
  .channels { padding: 12px 8px; }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 6px;
  }
  .menu-wrap { position: relative; }
  .menu {
    position: absolute;
    right: 0;
    top: 30px;
    z-index: 5;
    display: grid;
    min-width: 150px;
    padding: 4px;
    border: 2px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--card);
    box-shadow: var(--shadow);
  }
  .menu button {
    padding: 6px 10px;
    border: 0;
    border-radius: var(--r);
    background: none;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }
  .menu button:hover, .menu button:focus-visible { background: var(--pink-soft); }
  .new { padding: 0 4px 8px; }
  .new .field, .cat-rename .field { padding: 6px 10px; border-radius: var(--r); }
  .error { margin: 4px 4px 6px; font-size: .8rem; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .group { position: relative; padding-bottom: 6px; }
  .group + .group { margin-top: 6px; }
  .cat-head { display: flex; align-items: center; gap: 2px; padding: 2px 2px 2px 0; cursor: grab; }
  .cat {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 3px 6px;
    border: 0;
    background: none;
    color: var(--muted);
    font-size: .75rem;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    text-align: left;
    cursor: pointer;
  }
  .cat:hover { color: var(--ink); }
  .cat-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .caret { display: inline-block; transition: transform .15s; }
  .caret.folded { transform: rotate(-90deg); }
  .cat-rename { flex: 1; }
  .tool {
    padding: 0 5px;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    opacity: 0;
    cursor: pointer;
  }
  .cat-head:hover .tool, .cat-head:focus-within .tool { opacity: 1; }
  .tool:hover, .tool:focus-visible { color: var(--pink-deep); background: var(--pink-soft); }
  li[draggable="true"] { position: relative; }
  .dragging { opacity: .45; }
  .drop-before::before,
  .drop-end::after {
    content: "";
    display: block;
    height: 3px;
    border-radius: 2px;
    background: var(--pink);
  }
  .drop-before::before { position: absolute; left: 4px; right: 4px; top: -2px; }
  .group.drop-before::before { top: -5px; }
  .empty { min-height: 4px; }
  .placeholder {
    padding: 6px 10px;
    border: 2px dashed var(--line);
    border-radius: var(--r);
    color: var(--muted);
    font-size: .8rem;
  }
  .cat-end { position: relative; height: 24px; }
  .cat-end.drop-before::before { top: 4px; }
  .channel {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 10px;
    border: 0;
    border-radius: var(--r);
    background: none;
    color: var(--muted);
    text-align: left;
    cursor: pointer;
  }
  .channel:hover { background: var(--pink-soft); color: var(--ink); }
  .channel[aria-current="page"] { background: var(--pink-soft); color: var(--ink); font-weight: 700; }
  .channel.unread { color: var(--ink); font-weight: 700; }
  .hash { color: var(--pink); font-size: 1.15rem; line-height: 1; }
  .threads { margin: 2px 0 4px 18px; padding-left: 6px; border-left: 2px solid var(--line); }
  .thread { padding: 3px 8px; font-size: .9rem; }
  .thread .hash { font-size: .95rem; }
  .busy {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--pink);
    animation: pulse 1.2s infinite ease-in-out;
  }
  @keyframes pulse {
    0%, 100% { opacity: .35; transform: scale(.85); }
    50% { opacity: 1; transform: scale(1.1); }
  }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge {
    min-width: 20px;
    padding: 0 6px;
    border-radius: var(--r);
    background: var(--pink);
    color: var(--on-pink);
    font-size: .72rem;
    font-weight: 700;
    text-align: center;
  }
</style>
