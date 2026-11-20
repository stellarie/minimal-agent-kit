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
      enabled = (await client.guardRuleAsks()).enabled;
      problem = "";
    } catch (err) {
      problem = `Could not read the setting: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  async function set(next: boolean): Promise<void> {
    busy = true;
    try {
      enabled = (await client.setGuardRuleAsks(next)).enabled;
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

<section class="sticker rule-asks" aria-labelledby="rule-asks-title">
  <h2 id="rule-asks-title" class="section-title">Guard rule cards</h2>
  <p class="hint">
    The guard rules open a card for risky calls, such as a search in the lounge home or a read of a .env file.
    Turn this off to allow those calls without a card. Blocks still deny, and Ask and Auto modes still apply.
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
      <span>Rule cards are {enabled ? "on" : "off"}</span>
    </label>
    {#if !enabled}
      <p class="warn" role="status">Off: an agent can search the lounge home and read secret files without a card.</p>
    {/if}
  {:else if !problem}
    <p class="hint">Loading…</p>
  {/if}
</section>

<style>
  .rule-asks { margin-top: 28px; padding: 14px 20px 20px; }
  .hint { margin: 0 0 8px; color: var(--muted); }
  .row { display: flex; align-items: center; gap: 8px; font-weight: 700; }
  .warn { margin: 8px 0 0; font-weight: 700; }
</style>
