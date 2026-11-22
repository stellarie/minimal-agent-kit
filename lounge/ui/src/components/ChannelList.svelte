<script lang="ts">
  import { tick } from "svelte";
  import type { Category, Channel, Layout, LayoutBody } from "../lib/api.ts";
  import { advance, finish, hintAt, press, type Hint, type Row, type Session } from "../lib/drag.ts";
  import {
    groups,
    moveCategory,
    moveChannel,
    sameBody,
    stepCategory,
    stepChannel,
    toBody,
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

  let nav = $state<HTMLElement>();
  let session = $state<Session | null>(null);
  let hint = $state<Hint | null>(null);
  // The copy that follows the pointer.
  let ghost = $state<{ x: number; y: number; w: number; label: string } | null>(null);
  let grab = { x: 0, y: 0, w: 0, label: "" };
  const dragging = $derived(session?.phase === "dragging" ? session : null);

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

  // The row boxes now, in page order. A folded group has no channel row.
  function measure(): { rows: Row[]; box: DOMRect } | null {
    if (!nav) return null;
    const rows: Row[] = [];
    for (const section of nav.querySelectorAll<HTMLElement>("section.group")) {
      const category = section.dataset.group || null;
      const g = section.getBoundingClientRect();
      const head = section.querySelector(".cat-head")?.getBoundingClientRect();
      rows.push({
        kind: "group",
        category,
        top: g.top,
        bottom: g.bottom,
        ...(head ? { headMid: head.top + head.height / 2 } : {}),
      });
      for (const li of section.querySelectorAll<HTMLElement>(":scope > ul > li[data-row]")) {
        const all = li.getBoundingClientRect();
        const line = li.querySelector("[data-channel]")?.getBoundingClientRect() ?? all;
        rows.push({ kind: "channel", id: li.dataset.row!, category, top: all.top, mid: line.top + line.height / 2, bottom: all.bottom });
      }
    }
    return { rows, box: nav.getBoundingClientRect() };
  }

  function onPress(e: PointerEvent, kind: "channel" | "category", id: string, label: string) {
    const target = e.target as HTMLElement;
    if (e.button !== 0 || session || target.closest(".tool, form, input, .threads")) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    grab = { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, label };
    session = press(kind, id, e.clientX, e.clientY);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onRelease);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", onEscape);
  }

  function onPointerMove(e: PointerEvent) {
    if (!session) return;
    session = advance(session, e.clientX, e.clientY);
    if (session.phase !== "dragging") return;
    const m = measure();
    hint = m ? hintAt(session, e.clientX, e.clientY, m.rows, m.box) : null;
    ghost = { x: e.clientX - grab.x, y: e.clientY - grab.y, w: grab.w, label: grab.label };
  }

  function onRelease() {
    const s = session;
    const landing = s ? finish(s, hint) : null;
    const wasDrag = s?.phase === "dragging";
    clear();
    if (wasDrag) swallowClick();
    if (s && landing) void drop(s, landing);
  }

  // A cancel while the button is still down: the later release must not click the row.
  function onEscape(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    const wasDrag = session?.phase === "dragging";
    clear();
    if (wasDrag) swallowAfterRelease();
  }

  function clear() {
    session = null;
    hint = null;
    ghost = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onRelease);
    window.removeEventListener("pointercancel", clear);
    window.removeEventListener("blur", clear);
    window.removeEventListener("keydown", onEscape);
  }

  // The click that follows a drag release would open the row or fold the category.
  function swallowClick() {
    const stop = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    window.addEventListener("click", stop, true);
    setTimeout(() => window.removeEventListener("click", stop, true), 0);
  }

  function swallowAfterRelease() {
    const arm = () => {
      off();
      swallowClick();
    };
    const off = () => {
      window.removeEventListener("pointerup", arm, true);
      window.removeEventListener("blur", off);
    };
    window.addEventListener("pointerup", arm, true);
    window.addEventListener("blur", off);
  }

  async function drop(d: Session, h: Hint) {
    if (d.kind === "channel" && h.kind === "channel") {
      const body = moveChannel(layout, d.id, h.drop);
      const cat = body.channels.find((x) => x.id === d.id)?.category ?? null;
      await commit(body, `Moved #${nameOfChannel(d.id)} to ${nameOfCategory(cat)}.`);
    }
    if (d.kind === "category" && h.kind === "category") {
      await commit(moveCategory(layout, d.id, h.before), `Moved the category ${nameOfCategory(d.id)}.`);
    }
  }

  $effect(() => clear);

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

<nav class="channels" class:dragging-now={dragging !== null} aria-labelledby="channels-title" bind:this={nav}>
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

  {#each list as g (g.category?.id ?? "")}
    {@const catId = g.category?.id ?? null}
    {@const isFolded = catId !== null && folded.includes(catId)}
    <section
      class="group"
      class:drop-before={catId !== null && isCatBefore(catId)}
      class:dragging={dragging?.kind === "category" && dragging.id === catId}
      data-group={catId ?? ""}
      aria-label={g.category ? g.category.name : "Channels with no category"}
    >
      {#if g.category}
        {@const cat = g.category}
        <div class="cat-head" onpointerdown={(e) => onPress(e, "category", cat.id, cat.name)} role="presentation">
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
        {#each g.channels as c (c.id)}
          {#if !isFolded || c.id === current || (unread[c.id] ?? 0) > 0}
            {@const threads = threadsOf(c.id)}
            <li
              class:drop-before={isDropBefore(c.id)}
              class:dragging={dragging?.kind === "channel" && dragging.id === c.id}
              data-row={c.id}
              onpointerdown={(e) => onPress(e, "channel", c.id, `#${c.name}`)}
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
        {#if g.channels.length === 0 && g.category && dragging?.kind === "channel"}
          <li class="placeholder" aria-hidden="true">Drop a channel here</li>
        {/if}
      </ul>
    </section>
  {/each}
  {#if dragging?.kind === "category"}
    <div class="cat-end" class:drop-before={isCatBefore(null)} role="presentation"></div>
  {/if}
  <p class="sr-only" aria-live="polite">{announce}</p>
</nav>

{#if ghost}
  <div class="ghost" aria-hidden="true" style:left="{ghost.x}px" style:top="{ghost.y}px" style:width="{ghost.w}px">
    {ghost.label}
  </div>
{/if}

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
  li[data-row] { position: relative; }
  .dragging-now { user-select: none; cursor: grabbing; }
  .dragging { opacity: .45; }
  .ghost {
    position: fixed;
    z-index: 30;
    padding: 5px 10px;
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: var(--card);
    box-shadow: var(--shadow);
    color: var(--ink);
    opacity: .6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
  }
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
