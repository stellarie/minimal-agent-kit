<script lang="ts">
  import type { GuardMode } from "../lib/api.ts";
  import { GUARD_MODE_LABELS, modeView } from "../lib/guardMode.ts";

  let { mode, busy, onSelect }: { mode: GuardMode; busy: boolean; onSelect: (mode: GuardMode) => void } = $props();

  const MODES: GuardMode[] = ["normal", "auto", "bypass"];
  const view = $derived(modeView(mode));
</script>

<div class="guard-mode">
  <div class="seg" role="group" aria-label="Guard mode" title={view.help}>
    {#each MODES as m (m)}
      <button
        type="button"
        class:bypass={m === "bypass"}
        aria-pressed={mode === m}
        disabled={busy}
        onclick={() => mode !== m && onSelect(m)}
      >{GUARD_MODE_LABELS[m]}</button>
    {/each}
  </div>
  {#if view.badge}
    <span class="badge" role="status">Judge on</span>
  {/if}
</div>

<style>
  .guard-mode { display: flex; align-items: center; gap: 6px; }
  .seg button { padding: 2px 10px; font-size: .85rem; }
  .seg button.bypass[aria-pressed="true"] { background: var(--danger); color: var(--on-danger); }
  .badge {
    padding: 2px 10px;
    border-radius: var(--r);
    background: var(--pink-soft);
    color: var(--ink);
    font-size: .75rem;
    font-weight: 700;
    white-space: nowrap;
  }
</style>
