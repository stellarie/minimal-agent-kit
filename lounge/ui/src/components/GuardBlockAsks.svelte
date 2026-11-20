<script lang="ts">
  import { onMount } from "svelte";
  import type { LoungeClient } from "../lib/api.ts";

  let { client }: { client: LoungeClient } = $props();

  // Null until the core answers.
  let enabled = $state<boolean | null>(null);
  let busy = $state(false);
  let problem = $state("");

  async function load(): Promise<void> {
    try {
      enabled = (await client.getBlockAsks()).enabled;
      problem = "";
    } catch (err) {
      problem = `Could not read the setting: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function set(next: boolean): Promise<void> {
    busy = true;
    try {
      enabled = (await client.setBlockAsks(next)).enabled;
      problem = "";
    } catch (err) {
      problem = `Could not save: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<section class="sticker block-asks" aria-labelledby="block-asks-title">
  <h2 id="block-asks-title" class="section-title">Blocked calls ask</h2>
  <p class="hint">
    Turn this on and a file tool write inside the lounge home opens a dangerous card
    instead of a deny. Allow runs that one call. Shell commands stay blocked. The floor still denies: deletes of
    the home or drive, guard files, and tokens.
  </p>
  {#if problem}
    <p class="error" role="alert">{problem}</p>
  {/if}
  {#if enabled !== null}
    <label class="row">
      <input
        type="checkbox"
        checked={enabled}
        disabled={busy}
        onchange={(e) => void set(e.currentTarget.checked)}
      />
      <span>Blocked calls {enabled ? "ask" : "deny"}</span>
    </label>
    {#if enabled}
      <p class="warn" role="status">On: you can allow a blocked call by hand. Read each dangerous card first.</p>
    {/if}
  {:else if !problem}
    <p class="hint">Loading…</p>
  {/if}
</section>

<style>
  .block-asks { margin-top: 28px; padding: 14px 20px 20px; }
  .hint { margin: 0 0 8px; color: var(--muted); }
  .row { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  .warn { margin: 8px 0 0; color: var(--danger); font-weight: 700; }
</style>
