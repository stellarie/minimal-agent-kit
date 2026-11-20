<script lang="ts">
  import { onMount } from "svelte";
  import { SLOW_PRESETS, slowLabel, type Channel, type ChannelSettings } from "../lib/api.ts";

  let {
    channel,
    threadCount = 0,
    onSave,
    onDelete,
    onClose,
  }: {
    channel: Channel;
    // Threads that go with the channel.
    threadCount?: number;
    onSave: (settings: ChannelSettings) => Promise<void>;
    onDelete: () => Promise<void>;
    onClose: () => void;
  } = $props();

  const isThread = $derived(channel.parent !== undefined);
  const what = $derived(isThread ? "thread" : "channel");

  let dialog = $state<HTMLDialogElement>();
  let mode = $state<"concurrent" | "sequential">("concurrent");
  let slow = $state(0);
  let confirming = $state(false);
  let busy = $state(false);
  let error = $state("");

  onMount(() => {
    mode = channel.mode ?? "concurrent";
    slow = channel.slowSec ?? 0;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  });

  const options = $derived(SLOW_PRESETS.includes(slow) ? SLOW_PRESETS : [...SLOW_PRESETS, slow].sort((a, b) => a - b));
  const changed = $derived(mode !== (channel.mode ?? "concurrent") || slow !== (channel.slowSec ?? 0));

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!changed) return onClose();
    busy = true;
    error = "";
    try {
      await onSave({ mode, slowSec: slow });
      onClose();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (!confirming) {
      confirming = true;
      return;
    }
    busy = true;
    error = "";
    try {
      await onDelete();
      onClose();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      confirming = false;
    } finally {
      busy = false;
    }
  }

  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) onClose();
  }

  // The app window must not see this Escape.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="settings"
  aria-labelledby="settings-title"
  onkeydown={onKeydown}
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
  onclick={onBackdrop}
>
  <form class="box" onsubmit={save}>
    <header class="head">
      <h2 id="settings-title">{isThread ? "↳" : "#"}{channel.name} settings</h2>
      <button class="icon-btn" type="button" onclick={onClose}
        ><span aria-hidden="true">✕</span><span class="sr-only">Close</span></button
      >
    </header>

    {#if !isThread}
      <fieldset>
        <legend>Agent replies</legend>
        <label class="choice">
          <input type="radio" name="mode" value="concurrent" bind:group={mode} />
          <span><b>At the same time</b><small>All agents can reply at once.</small></span>
        </label>
        <label class="choice">
          <input type="radio" name="mode" value="sequential" bind:group={mode} />
          <span><b>One at a time</b><small>Each agent waits for the reply before its own.</small></span>
        </label>
      </fieldset>

      <label class="field-row">
        <span><b>Slow mode</b><small>After an agent posts, it waits this long before it posts again here. Replies to you skip it.</small></span>
        <select class="field" bind:value={slow}>
          {#each options as sec (sec)}
            <option value={sec}>{slowLabel(sec)}</option>
          {/each}
        </select>
      </label>
    {/if}

    <section class="danger" aria-label="Delete">
      <p>
        {#if isThread}
          Delete this thread and its messages.
        {:else}
          Delete this channel{threadCount > 0 ? `, its ${threadCount} thread${threadCount === 1 ? "" : "s"},` : ""} and its messages.
        {/if}
        This cannot be undone.
      </p>
      <button class="btn btn--soft del" type="button" disabled={busy} onclick={remove}>
        {confirming ? `Click again to delete the ${what}` : `Delete ${what}`}
      </button>
    </section>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <footer class="foot">
      <button class="btn btn--soft" type="button" onclick={onClose}>Cancel</button>
      {#if !isThread}<button class="btn" type="submit" disabled={busy || !changed}>Save</button>{/if}
    </footer>
  </form>
</dialog>

<style>
  .settings {
    width: min(460px, 94vw);
    padding: 0;
    border: 2px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--card);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  .settings::backdrop { background: color-mix(in srgb, var(--ink) 55%, transparent); }
  .box { display: grid; gap: 14px; padding: 0 0 14px; }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 2px solid var(--line);
  }
  h2 { flex: 1; margin: 0; font-size: 1rem; overflow-wrap: anywhere; }
  fieldset { display: grid; gap: 8px; margin: 0 14px; padding: 0; border: 0; }
  legend { margin-bottom: 6px; font-weight: 700; }
  .choice, .field-row { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; }
  .field-row { margin: 0 14px; align-items: center; justify-content: space-between; }
  .choice input { margin-top: 4px; accent-color: var(--pink); }
  b, small { display: block; }
  small { color: var(--muted); font-size: .8rem; }
  .field-row select { flex: none; width: auto; padding: 4px 10px; border-radius: var(--r); }
  .danger {
    display: grid;
    gap: 8px;
    margin: 0 14px;
    padding: 10px 12px;
    border: 2px dashed var(--pink-deep);
    border-radius: var(--r);
  }
  .danger p { margin: 0; font-size: .85rem; }
  .del { justify-self: start; color: var(--pink-deep); font-weight: 700; }
  .error { margin: 0 14px; }
  .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 0 14px; }
</style>
