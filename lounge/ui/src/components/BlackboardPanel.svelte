<script lang="ts">
  import { untrack } from "svelte";
  import type { BoardTask, LoungeClient } from "../lib/api.ts";
  import { progress } from "../lib/blackboard.ts";
  import { nameOf } from "../lib/names.svelte.ts";

  // Read only: this panel has no control that writes.
  let { client, threadId }: { client: LoungeClient; threadId: string | undefined } = $props();

  const REFRESH_MS = 5000;

  let tasks = $state<BoardTask[]>([]);
  let status = $state<"loading" | "idle">("idle");
  let failed = $state(false);
  // Drops the answer of a request that a newer one replaced.
  let round = 0;

  async function load(id: string, quiet: boolean) {
    const mark = ++round;
    if (!quiet) status = "loading";
    try {
      const board = await client.blackboard(id);
      if (mark !== round) return;
      tasks = board;
      failed = false;
    } catch {
      if (mark !== round) return;
      failed = true;
    }
    status = "idle";
  }

  // The agents write the files while the tab is open: read them again.
  $effect(() => {
    const id = threadId;
    untrack(() => {
      tasks = [];
      failed = false;
    });
    if (!id) return;
    untrack(() => void load(id, false));
    const timer = setInterval(() => void load(id, true), REFRESH_MS);
    return () => {
      clearInterval(timer);
      round++;
    };
  });
</script>

<div class="board">
  <h2 class="section-title">Board</h2>
  {#if !threadId}
    <p class="note">Open a thread to see its task board.</p>
  {:else if status === "loading"}
    <p class="note" role="status">Loading the board…</p>
  {:else if failed && tasks.length === 0}
    <p class="note">The board did not load.</p>
    <button class="more" type="button" onclick={() => void load(threadId, false)}>Try again</button>
  {:else if tasks.length === 0}
    <p class="note">No tasks yet. Agents add them in .kit/tasks.</p>
  {:else}
    {#each tasks as task (task.name)}
      <section class="task" aria-label={task.name}>
        {#if task.ok}
          <header class="head">
            <h3 class="title">{task.title}</h3>
            <span class="status" data-status={task.status}>{task.status}</span>
          </header>
          <p class="meta">
            {task.name} · owner {task.owner === "none" ? "none" : nameOf(task.owner)}{#if task.updated} · {task.updated}{/if} · {progress(task.items)}
          </p>
          {#if task.items.length > 0}
            <ul class="items">
              {#each task.items as item}
                <li class="item" class:done={item.done}>
                  <span class="mark" aria-hidden="true">{item.done ? "☑" : "☐"}</span>
                  <span class="text">
                    <span class="line"><strong>{item.id}</strong> {item.text}</span>
                    <span class="meta">
                      {item.done ? "done" : "open"} · owner {item.owner === "none" ? "none" : nameOf(item.owner)}{#if item.result} · {item.result}{/if}
                    </span>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
        {:else}
          <header class="head">
            <h3 class="title">{task.name}</h3>
          </header>
          <p class="warn" role="alert">Could not read this file: {task.warning}</p>
          <pre class="raw">{task.raw}</pre>
        {/if}
      </section>
    {/each}
    {#if failed}<p class="note">The last refresh failed. This is the last board that loaded.</p>{/if}
  {/if}
</div>

<style>
  .board { display: grid; gap: 8px; }
  .note { margin: 0; color: var(--muted); font-size: .85rem; }
  .task {
    display: grid;
    gap: 6px;
    padding: 8px 10px;
    border: 2px solid var(--line);
    border-left: 5px solid var(--pink);
    border-radius: var(--r-lg);
    background: var(--bg);
  }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  .title { margin: 0; font-size: .9rem; overflow-wrap: anywhere; }
  .status {
    flex: none;
    padding: 1px 8px;
    border: 2px solid var(--line);
    border-radius: var(--r);
    font-size: .7rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .status[data-status="done"] { border-color: var(--pink); }
  .status[data-status="blocked"] { border-style: dashed; }
  .meta { margin: 0; color: var(--muted); font-size: .75rem; overflow-wrap: anywhere; }
  .items { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .item { display: flex; gap: 8px; }
  .item.done .line { text-decoration: line-through; color: var(--muted); }
  .mark { flex: none; }
  .text { display: grid; gap: 1px; min-width: 0; }
  .line { font-size: .85rem; overflow-wrap: anywhere; }
  .warn { margin: 0; font-size: .8rem; font-weight: 700; }
  .raw {
    margin: 0;
    padding: 6px 8px;
    max-height: 260px;
    overflow: auto;
    border: 2px dashed var(--line);
    border-radius: var(--r-sm);
    background: var(--card);
    font-size: .75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .more {
    justify-self: start;
    padding: 4px 12px;
    border: 2px dashed var(--line);
    border-radius: var(--r);
    background: var(--card);
    color: var(--ink);
    font-size: .8rem;
    cursor: pointer;
  }
</style>
