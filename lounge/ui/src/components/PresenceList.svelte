<script lang="ts">
  import { MAX_NICKNAME, type Channel, type Message, type Presence, type WorkState } from "../lib/api.ts";
  import { displayName, formatLastSeen, isHere } from "../lib/format.ts";
  import { nameOf, nicknames } from "../lib/names.svelte.ts";
  import Initial from "./Initial.svelte";

  let {
    people,
    now,
    onRename,
    work = [],
    channels = [],
    toolLines = () => [],
    onOpen,
  }: {
    people: Presence[];
    now: number;
    onRename?: (name: string) => Promise<void>;
    work?: WorkState[];
    channels?: Channel[];
    // The latest tool lines of one agent in a room.
    toolLines?: (caller: string, roomId: string) => Message[];
    onOpen?: (roomId: string) => void;
  } = $props();

  let open = $state<string | null>(null);
  const roomName = (id: string) => channels.find((c) => c.id === id)?.name ?? id;

  let renaming = $state(false);
  let draft = $state("");
  let error = $state("");
  let input = $state<HTMLInputElement>();

  $effect(() => {
    if (renaming) input?.select();
  });

  function begin() {
    draft = nicknames["owner"] ?? "";
    error = "";
    renaming = true;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!onRename) return;
    try {
      await onRename(draft);
      renaming = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<ul class="people">
  {#each people as p (p.caller)}
    {@const here = isHere(p, now)}
    {@const jobs = work.filter((w) => w.agent === p.caller)}
    <li class="person" class:here>
      <span class="dot">
        <Initial caller={p.caller} size={26} border={here ? "var(--pink)" : "var(--line)"} />
      </span>
      <button
        class="name"
        type="button"
        aria-expanded={open === p.caller}
        onclick={() => (open = open === p.caller ? null : p.caller)}
        title="Show what {nameOf(p.caller)} is doing"
      >
        {nameOf(p.caller)}
        {#if nicknames[p.caller]}<span class="real">({displayName(p.caller)})</span>{/if}
        {#if jobs.length > 0}<span class="working">working</span>{/if}
      </button>
      <span class="state">
        {here ? "here" : "away"} · {formatLastSeen(p.lastSeen, now)}
      </span>
      {#if p.adapter === "unavailable"}
        <span class="tag">adapter unavailable</span>
      {:else if p.adapter === "slow"}
        <span class="tag">slow</span>
      {/if}
      {#if open === p.caller}
        <div class="card" role="region" aria-label="What {nameOf(p.caller)} is doing">
          {#if jobs.length === 0}
            <p class="idle">Not working on anything now.</p>
          {/if}
          {#each jobs as job (job.roomId)}
            <button class="job" type="button" onclick={() => onOpen?.(job.roomId)}>↳ {roomName(job.roomId)}</button>
            <ul class="lines">
              {#each toolLines(p.caller, job.roomId).slice(-5) as line (line.id)}
                <li><code>{line.text}</code></li>
              {:else}
                <li class="idle">Starting…</li>
              {/each}
            </ul>
          {/each}
        </div>
      {/if}
      {#if p.caller === "owner" && onRename}
        {#if renaming}
          <form class="rename" onsubmit={save}>
            <label for="my-name" class="sr-only">Your display name</label>
            <input
              id="my-name"
              class="field"
              maxlength={MAX_NICKNAME}
              placeholder="owner"
              bind:value={draft}
              bind:this={input}
              onkeydown={(e) => e.key === "Escape" && (renaming = false)}
            />
            {#if error}<span class="error" role="alert">{error}</span>{/if}
          </form>
        {:else}
          <button class="link-btn" type="button" onclick={begin}>Change my name</button>
        {/if}
      {/if}
    </li>
  {/each}
</ul>

<style>
  .people {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 10px;
  }
  .person {
    display: grid;
    grid-template-columns: auto 1fr;
    column-gap: 10px;
    align-items: center;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px dashed var(--line);
    border-radius: var(--r-lg);
  }
  .person.here { border-style: solid; }
  .dot {
    grid-row: span 3;
    display: flex;
  }
  .name {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 600;
    text-align: left;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  .name:hover { color: var(--pink-deep); }
  .working {
    margin-left: 6px;
    padding: 0 8px;
    border-radius: var(--r);
    background: var(--pink);
    color: var(--on-pink);
    font-size: .7rem;
  }
  .card {
    grid-column: 1 / -1;
    margin-top: 8px;
    padding: 8px 10px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    font-size: .8rem;
  }
  .job {
    padding: 0;
    border: 0;
    background: none;
    color: var(--pink-deep);
    font-weight: 600;
    cursor: pointer;
  }
  .job:hover { text-decoration: underline; }
  .lines { list-style: none; margin: 4px 0 6px; padding: 0; display: grid; gap: 2px; }
  .lines code {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: .75rem;
  }
  .idle { margin: 0; color: var(--muted); }
  .real { color: var(--muted); font-size: .75rem; font-weight: 400; }
  .state { color: var(--muted); font-size: .85rem; }
  .tag {
    justify-self: start;
    padding: 0 10px;
    background: var(--tape-2);
    border-radius: var(--r);
    font-size: .75rem;
    font-weight: 600;
  }
  .link-btn {
    grid-column: 2;
    justify-self: start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--pink-deep);
    font-size: .8rem;
    text-decoration: underline;
    cursor: pointer;
  }
  .rename { grid-column: 1 / -1; margin-top: 6px; }
  .rename .field { padding: 4px 10px; border-radius: var(--r); }
  .error { font-size: .8rem; }
</style>
