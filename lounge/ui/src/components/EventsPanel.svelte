<script lang="ts">
  import type { Channel, EventDraft, LoungeEvent, Repeat } from "../lib/api.ts";
  import { REPEAT_LABELS } from "../lib/api.ts";
  import { nameOf } from "../lib/names.svelte.ts";

  let {
    events,
    channels,
    current,
    onCreate,
    onCancel,
  }: {
    events: LoungeEvent[];
    channels: Channel[];
    current: string;
    onCreate: (draft: EventDraft) => Promise<void>;
    onCancel: (id: number) => Promise<void>;
  } = $props();

  const when = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let adding = $state(false);
  let title = $state("");
  let at = $state("");
  let room = $state("");
  let context = $state("");
  let repeat = $state<Repeat>("none");
  let error = $state("");

  const upcoming = $derived(
    events.filter((e) => e.state === "pending").sort((a, b) => a.at.localeCompare(b.at)),
  );

  // datetime-local wants local time without a zone.
  function localInput(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function begin() {
    title = "";
    context = "";
    repeat = "none";
    room = current;
    at = localInput(new Date(Date.now() + 60 * 60_000));
    error = "";
    adding = true;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) {
      error = "Pick a date and time.";
      return;
    }
    if (repeat === "monthly" && date.getDate() > 28) {
      error = "A monthly event needs a day from 1 to 28.";
      return;
    }
    try {
      await onCreate({ room, title, context, at: date.toISOString(), repeat });
      adding = false;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  async function cancel(e: LoungeEvent) {
    if (!confirm(`Cancel the event "${e.title}"?`)) return;
    try {
      await onCancel(e.id);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<section class="events" aria-labelledby="events-title">
  <div class="title-row">
    <h2 id="events-title" class="section-title">Events</h2>
    <button class="icon-btn" type="button" aria-expanded={adding} onclick={() => (adding ? (adding = false) : begin())}>
      <span aria-hidden="true">+</span><span class="sr-only">Schedule an event</span>
    </button>
  </div>

  {#if adding}
    <form class="form" onsubmit={save}>
      <label>
        <span>Title</span>
        <input class="field" maxlength="100" required bind:value={title} />
      </label>
      <label>
        <span>When</span>
        <input class="field" type="datetime-local" required bind:value={at} />
      </label>
      <label>
        <span>Repeat</span>
        <select class="field" bind:value={repeat}>
          {#each Object.entries(REPEAT_LABELS) as [value, label] (value)}<option {value}>{label}</option>{/each}
        </select>
      </label>
      <label>
        <span>Channel</span>
        <select class="field" bind:value={room}>
          {#each channels as c (c.id)}<option value={c.id}>#{c.name}</option>{/each}
        </select>
      </label>
      <label>
        <span>Context for the agents</span>
        <textarea class="field" rows="3" maxlength="2000" bind:value={context}></textarea>
      </label>
      <div class="actions">
        <button class="btn" type="submit">Schedule</button>
        <button class="btn btn--soft" type="button" onclick={() => (adding = false)}>Cancel</button>
      </div>
    </form>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if upcoming.length === 0 && !adding}
    <p class="empty">No events yet. Press + to plan one.</p>
  {:else}
    <ul class="list">
      {#each upcoming as e (e.id)}
        <li class="item">
          <time datetime={e.at}>{when.format(new Date(e.at))}</time>
          <strong>{e.title}</strong>
          <span class="meta">#{e.roomId} · by {nameOf(e.createdBy)}{e.repeat && e.repeat !== "none" ? ` · ${REPEAT_LABELS[e.repeat].toLowerCase()}` : ""}</span>
          {#if e.context}<span class="context">{e.context}</span>{/if}
          <button class="link" type="button" onclick={() => cancel(e)}>Cancel<span class="sr-only"> {e.title}</span></button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .events { margin-top: 16px; }
  .title-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .form { display: grid; gap: 8px; margin-bottom: 10px; }
  .form label { display: grid; gap: 2px; font-size: .8rem; font-weight: 700; }
  .form .field { padding: 5px 10px; border-radius: var(--r); font-weight: 400; }
  .actions { display: flex; gap: 8px; }
  .actions .btn { padding: 4px 14px; }
  .empty { margin: 0; color: var(--muted); font-size: .85rem; }
  .error { margin: 0 0 8px; font-size: .8rem; }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .item {
    display: grid;
    gap: 1px;
    height: 220px;
    overflow: hidden;
    padding: 8px 10px;
    background: var(--bg);
    border: 2px solid var(--line);
    border-left: 5px solid var(--pink);
    border-radius: var(--r-lg);
    font-size: .85rem;
  }
  time { color: var(--pink-deep); font-weight: 700; font-size: .78rem; }
  .meta, .context { color: var(--muted); font-size: .78rem; }
  .context { overflow-wrap: anywhere; min-height: 0; overflow-y: auto; }
  .link {
    justify-self: start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--pink-deep);
    font-size: .78rem;
    text-decoration: underline;
    cursor: pointer;
  }
  /* Show Cancel on hover or focus only. */
  @media (hover: hover) {
    .item .link { opacity: 0; transition: opacity .15s; }
    .item:hover .link, .item:focus-within .link { opacity: 1; }
  }
</style>
