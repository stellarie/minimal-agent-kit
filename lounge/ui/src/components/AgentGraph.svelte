<script lang="ts">
  import { untrack } from "svelte";
  import type { LoungeClient, ThreadTree, WorkState } from "../lib/api.ts";
  import { graphRows } from "../lib/graph.ts";
  import { nameOf } from "../lib/names.svelte.ts";

  // Read only. Live status comes from the work events of the page.
  let { client, threadId, work }: { client: LoungeClient; threadId: string | undefined; work: WorkState[] } = $props();

  const REFRESH_MS = 5000;

  let tree = $state<ThreadTree | undefined>(undefined);
  let failed = $state(false);
  let round = 0;

  async function load(id: string) {
    const mark = ++round;
    try {
      const next = await client.threadTree(id);
      if (mark !== round) return;
      tree = next;
      failed = false;
    } catch {
      if (mark !== round) return;
      failed = true;
    }
  }

  // A spawn adds a thread while the tab is open: read the tree again.
  $effect(() => {
    const id = threadId;
    untrack(() => {
      tree = undefined;
      failed = false;
    });
    if (!id) return;
    untrack(() => void load(id));
    const timer = setInterval(() => void load(id), REFRESH_MS);
    return () => {
      clearInterval(timer);
      round++;
    };
  });

  const rows = $derived(tree ? graphRows(tree, work) : []);
</script>

<div class="graph">
  <h2 class="section-title">Agents</h2>
  {#if !threadId}
    <p class="note">Open a thread to see its agents.</p>
  {:else if failed && !tree}
    <p class="note">The agent graph did not load.</p>
  {:else if !tree}
    <p class="note" role="status">Loading the agents…</p>
  {:else}
    <ul class="tree" aria-label="Agent graph">
      {#each rows as row (row.id)}
        <li class="node" class:here={row.id === threadId} style:--depth={row.depth}>
          <span class="dot" data-state={row.state} aria-hidden="true"></span>
          <span class="text">
            <span class="lead">{nameOf(row.lead)}</span>
            <span class="meta">{row.name} · {row.state}{#if row.agents.length > 0} · {row.agents.map(nameOf).join(", ")}{/if}</span>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .graph { display: grid; gap: 8px; }
  .note { margin: 0; color: var(--muted); font-size: .85rem; }
  .tree { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .node {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-left: calc(var(--depth) * 16px);
    padding: 4px 8px;
    border: 2px solid var(--line);
    border-radius: var(--r);
    background: var(--bg);
  }
  .node.here { border-color: var(--pink); }
  .dot { flex: none; width: 8px; height: 8px; border: 2px solid var(--line); border-radius: 50%; }
  .dot[data-state="working"] { background: var(--pink); border-color: var(--pink); }
  .dot[data-state="stopped"] { border-style: dashed; }
  .text { display: grid; gap: 1px; min-width: 0; }
  .lead { font-size: .85rem; font-weight: 700; }
  .meta { color: var(--muted); font-size: .75rem; overflow-wrap: anywhere; }
</style>
