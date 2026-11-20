<script lang="ts">
  import { ApiError, type GuardState, type LoungeClient } from "../lib/api.ts";
  import { formatTime } from "../lib/format.ts";
  import { outcomeLabel, sourceLabel } from "../lib/guard.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { whoColor } from "../lib/roster.svelte.ts";

  // pending: reload the log when a card appears or goes.
  // changes: reload it when the core logs an entry.
  let { client, pending, changes }: { client: LoungeClient; pending: number; changes: number } = $props();

  let snap = $state<GuardState | null>(null);
  let problem = $state("");
  let now = $state(Date.now());

  async function load(): Promise<void> {
    try {
      snap = await client.guard();
      now = Date.now();
      problem = "";
    } catch (err) {
      problem = err instanceof ApiError ? err.message : "Cannot reach the core.";
    }
  }

  $effect(() => {
    void pending;
    void changes;
    void load();
  });
</script>

<section class="sticker log" aria-labelledby="guard-title">
  <div class="head">
    <h2 id="guard-title" class="section-title">Guard log</h2>
    <button class="icon-btn" type="button" onclick={() => void load()}>
      <span aria-hidden="true">↻</span><span class="sr-only">Reload the guard log</span>
    </button>
  </div>
  <p class="hint">
    Every call the guard stopped, and every call a tool mode decided, shows here.
  </p>
  {#if problem}
    <p class="error" role="alert">{problem}</p>
  {/if}
  {#if snap}
    {#if snap.recent.length === 0}
      <p class="hint">Nothing logged yet.</p>
    {:else}
      <ul class="entries">
        {#each snap.recent as e, i (`${e.at}|${i}`)}
          <li class="entry entry--{e.outcome}">
            <p class="top">
              <time datetime={e.at}>{formatTime(e.at, now)}</time>
              <span class="chip" style:--who={whoColor(e.agent)}>{nameOf(e.agent)}</span>
              <strong>{e.tool}</strong>
              <span class="outcome">{outcomeLabel(e.outcome)}</span>
              <span class="source">{sourceLabel(e.source)}</span>
            </p>
            <p class="reason">{e.reason}</p>
            <code class="cmd">{e.summary}</code>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .log { margin-top: 28px; padding: 14px 20px 20px; }
  .head { display: flex; align-items: center; justify-content: space-between; }
  .hint { margin: 0 0 8px; color: var(--muted); }
  .hint strong { color: var(--ink); }
  .entries {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: grid;
    gap: 8px;
    max-height: 460px;
    overflow-y: auto;
    scrollbar-color: var(--line) transparent;
  }
  .entry {
    padding: 8px 10px;
    background: var(--bg);
    border: 2px solid var(--line);
    border-left: 5px solid var(--pink);
    border-radius: var(--r-lg);
    font-size: .85rem;
  }
  .entry--blocked, .entry--timeout { border-left-color: var(--muted); }
  .entry--auto-allowed { border-left-color: var(--line); }
  .top { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 10px; margin: 0; }
  time, .source { color: var(--muted); font-size: .78rem; }
  .outcome { color: var(--pink-deep); font-weight: 700; }
  .reason { margin: 2px 0 4px; overflow-wrap: anywhere; }
  .cmd {
    display: block;
    max-height: 4.4em;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: .78rem;
    color: var(--muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  @media (max-width: 599px) {
    .log { padding: 12px 12px 16px; }
  }
</style>
