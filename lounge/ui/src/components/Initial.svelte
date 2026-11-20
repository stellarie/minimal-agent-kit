<script lang="ts">
  import { nameOf } from "../lib/names.svelte.ts";
  import { whoColor } from "../lib/roster.svelte.ts";

  // A square chip with the first letter of the name, in the label color of the caller.
  let {
    caller,
    size = 40,
    border = "var(--line)",
  }: { caller: string; size?: number; border?: string } = $props();
</script>

<span
  class="mark"
  aria-hidden="true"
  style:width="{size}px"
  style:height="{size}px"
  style:background={whoColor(caller)}
  style:--border={border}
>{nameOf(caller).slice(0, 1).toUpperCase()}</span>

<style>
  .mark {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    flex: none;
    border: 1px solid var(--border);
    border-radius: var(--r);
    font-family: var(--font-pop);
    font-weight: 600;
    color: var(--ink);
  }
</style>
