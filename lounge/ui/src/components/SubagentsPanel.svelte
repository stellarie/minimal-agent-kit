<script lang="ts">
  import type { Subagent } from "../lib/api.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { byAgent } from "../lib/subagents.ts";

  // Live from the subagent events of the page. A child row opens its thread.
  let { subagents, onOpen }: { subagents: Subagent[]; onOpen: (roomId: string) => void } = $props();

  const groups = $derived(byAgent(subagents));
</script>

<div class="subs">
  <h2 class="section-title">Subagents</h2>
  {#if groups.length === 0}
    <p class="note">No subagents yet. A lounge_spawn child or a runtime subagent shows here.</p>
  {:else}
    {#each groups as group (group.agent)}
      <section class="group" aria-label="Subagents of {nameOf(group.agent)}">
        <h3 class="who">{nameOf(group.agent)}{#if group.running > 0} <span class="count">· {group.running} running</span>{/if}</h3>
        <ul class="list">
          {#each group.items as s (s.key)}
            <li class="row">
              <span class="dot" data-state={s.state} aria-hidden="true"></span>
              {#if s.kind === "child" && s.threadId}
                <button type="button" class="title link" onclick={() => onOpen(s.threadId!)}>{s.title}</button>
              {:else}
                <span class="title">{s.title}</span>
              {/if}
              <span class="meta">{s.kind === "child" ? "thread" : "runtime"} · {s.state}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
</div>

<style>
  .subs { display: grid; gap: 8px; }
  .note { margin: 0; color: var(--muted); font-size: .85rem; }
  .group { display: grid; gap: 4px; }
  .who { margin: 0; font-size: .85rem; font-weight: 700; }
  .count { color: var(--muted); font-weight: 400; }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 8px;
    border: 2px solid var(--line);
    border-radius: var(--r);
    background: var(--bg);
    min-width: 0;
  }
  .dot { flex: none; width: 8px; height: 8px; border: 2px solid var(--line); border-radius: 50%; }
  .dot[data-state="running"] { background: var(--pink); border-color: var(--pink); }
  .dot[data-state="failed"] { border-style: dashed; border-color: var(--pink-deep); }
  .title { flex: 1; min-width: 0; font-size: .85rem; overflow-wrap: anywhere; }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-size: .85rem;
    text-align: left;
    text-decoration: underline;
    cursor: pointer;
  }
  .meta { flex: none; color: var(--muted); font-size: .75rem; }
</style>
