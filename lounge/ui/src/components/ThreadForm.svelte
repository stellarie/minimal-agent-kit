<script lang="ts">
  import { MAX_TEXT, type Agent, type Channel, type ThreadDraft } from "../lib/api.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { firstAgent, roster } from "../lib/roster.svelte.ts";

  let {
    channel,
    onStart,
    onClose,
  }: {
    channel: Channel;
    onStart: (draft: ThreadDraft) => Promise<void>;
    onClose: () => void;
  } = $props();

  let title = $state("");
  let brief = $state("");
  let lead = $state<Agent>(firstAgent());
  let cwd = $state("");
  let error = $state("");
  let busy = $state(false);
  let input = $state<HTMLInputElement>();

  $effect(() => {
    input?.focus();
  });

  // The roster may load after this form opens.
  $effect(() => {
    if (lead === "") lead = firstAgent();
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    busy = true;
    try {
      await onStart({ channel: channel.id, title, brief, lead, cwd: cwd.trim() });
      onClose();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<!-- Escape bubbles up from the fields. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<form class="thread-form" onsubmit={save} onkeydown={(e) => e.key === "Escape" && onClose()}>
  <h2>Start work in #{channel.name}</h2>
  <label>
    <span>Title</span>
    <input class="field" maxlength="100" required placeholder="Fix the build" bind:value={title} bind:this={input} />
  </label>
  <label>
    <span>Lead</span>
    <select class="field" bind:value={lead}>
      {#each roster.agents as entry (entry.id)}<option value={entry.id}>{nameOf(entry.id)}</option>{/each}
    </select>
  </label>
  <label class="wide">
    <span>What to do</span>
    <textarea class="field" rows="3" required maxlength={MAX_TEXT} placeholder="Write @name to bring in more agents." bind:value={brief}></textarea>
  </label>
  <label class="wide">
    <span>Folder (optional, absolute path)</span>
    <input class="field" placeholder="E:\projects\my-app" bind:value={cwd} />
  </label>
  {#if error}<p class="error wide" role="alert">{error}</p>{/if}
  <div class="actions wide">
    <button class="btn" type="submit" disabled={busy}>Start work</button>
    <button class="btn btn--soft" type="button" onclick={onClose}>Cancel</button>
  </div>
</form>

<style>
  .thread-form {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    gap: 8px 12px;
    margin: 10px 16px 0;
    padding: 12px 14px;
    background: var(--bg);
    border: 2px solid var(--line);
    border-left: 5px solid var(--pink);
    border-radius: var(--r-lg);
  }
  h2 { grid-column: 1 / -1; margin: 0; font-size: 1rem; }
  label { display: grid; gap: 2px; font-size: .8rem; font-weight: 700; }
  .wide { grid-column: 1 / -1; }
  .field { padding: 5px 10px; border-radius: var(--r); font-weight: 400; }
  .actions { display: flex; gap: 8px; }
  .actions .btn { padding: 4px 14px; }
  .error { margin: 0; }
</style>
