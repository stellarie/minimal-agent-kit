<script lang="ts">
  // The phase of a work thread, set by its latest gate.
  let { phase }: { phase?: string } = $props();
</script>

{#if phase}
  <p class="phase" aria-label="Thread phase">Phase: <strong>{phase}</strong></p>
{/if}

<style>
  .phase {
    margin: 0;
    padding: 2px 16px;
    background: var(--card);
    border-bottom: 2px solid var(--line);
    color: var(--muted);
    font-size: .85rem;
  }
  .phase strong { color: var(--pink-deep); }
</style>
