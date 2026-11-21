<script lang="ts">
  import type { Banner, UpdateAction } from "../lib/update.ts";

  let { banner, onAction }: { banner: Banner; onAction: (action: UpdateAction) => Promise<void> } = $props();

  let busy = $state(false);

  async function run(action: UpdateAction) {
    busy = true;
    try {
      await onAction(action);
    } finally {
      busy = false;
    }
  }
</script>

<div class="update" role="status">
  <span>{banner.text}</span>
  {#if banner.action}
    <button class="btn btn--soft small" type="button" disabled={busy} onclick={() => run(banner.action!)}>
      {banner.label}
    </button>
  {/if}
</div>

<style>
  .update {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 6px 16px;
    background: var(--pink-soft);
    font-weight: 700;
  }
</style>
