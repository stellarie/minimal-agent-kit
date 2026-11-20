<script lang="ts">
  import type { SideTab } from "../lib/sidetabs.ts";
  import { SIDE_TABS } from "../lib/sidetabs.ts";

  let { tab, onSelect }: { tab: SideTab; onSelect: (tab: SideTab) => void } = $props();

  const LABELS: Record<SideTab, string> = { members: "Members", events: "Events", files: "Files" };

  function onKeydown(e: KeyboardEvent) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const edge = e.key === "Home" ? 0 : e.key === "End" ? SIDE_TABS.length - 1 : -1;
    if (step === 0 && edge < 0) return;
    e.preventDefault();
    const at = SIDE_TABS.indexOf(tab);
    const to = edge >= 0 ? edge : (at + step + SIDE_TABS.length) % SIDE_TABS.length;
    onSelect(SIDE_TABS[to]!);
    document.getElementById(`side-tab-${SIDE_TABS[to]}`)?.focus();
  }
</script>

<span id="side-tabs-title" class="sr-only">Side bar</span>
<div class="tabs" role="tablist" aria-labelledby="side-tabs-title" tabindex="-1" onkeydown={onKeydown}>
  {#each SIDE_TABS as id (id)}
    <button
      type="button"
      role="tab"
      id="side-tab-{id}"
      class="tab"
      aria-label={LABELS[id]}
      title={LABELS[id]}
      aria-selected={tab === id}
      aria-controls={tab === id ? `side-panel-${id}` : undefined}
      tabindex={tab === id ? 0 : -1}
      onclick={() => onSelect(id)}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {#if id === "members"}
          <circle cx="9" cy="8" r="3.2" />
          <path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" />
          <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18.5 14.8c1.7.8 2.5 2.4 2.5 5.2" />
        {:else if id === "events"}
          <rect x="3.5" y="5" width="17" height="15" rx="2" />
          <path d="M3.5 10h17M8 3v4M16 3v4" />
        {:else}
          <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        {/if}
      </svg>
    </button>
  {/each}
</div>

<style>
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 12px;
    padding: 3px;
    border: 2px solid var(--line);
    border-radius: var(--r);
    background: var(--card);
  }
  .tab {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 5px 0;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .tab:hover { color: var(--pink-deep); }
  .tab[aria-selected="true"] { background: var(--pink); color: var(--on-pink); }
</style>
