<script lang="ts">
  import { onMount } from "svelte";
  import { FONT_KEY, FONTS, fontById, fontStack, type FontChoice } from "../lib/fonts.ts";

  // inline: show the list on a page, no popover.
  let { inline = false }: { inline?: boolean } = $props();

  let open = $state(false);
  let chosen = $state<FontChoice>(fontById(null));
  let panel = $state<HTMLElement>();

  function apply(font: FontChoice) {
    const root = document.documentElement;
    const stack = fontStack(font);
    root.style.setProperty("--font", stack);
    root.style.setProperty("--font-pop", stack);
  }

  function choose(font: FontChoice) {
    chosen = font;
    localStorage.setItem(FONT_KEY, font.id);
    apply(font);
  }

  onMount(() => {
    chosen = fontById(localStorage.getItem(FONT_KEY));
    apply(chosen);
  });
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") open = false;
  }}
  onpointerdown={(e) => {
    if (open && panel && !panel.contains(e.target as Node)) open = false;
  }}
/>

<div class="picker" class:inline bind:this={panel}>
  {#if !inline}
  <button
    class="btn btn--soft"
    type="button"
    aria-expanded={open}
    aria-controls="font-panel"
    aria-label="Font: {chosen.name}"
    onclick={() => (open = !open)}
  >
    <span aria-hidden="true">Aa</span><span class="label" aria-hidden="true">Font: {chosen.name}</span>
  </button>
  {/if}
  {#if open || inline}
    <div id="font-panel" class="panel" role="dialog" aria-label="Fonts">
      <ul class="list">
        {#each FONTS as font (font.id)}
          <li>
            <button
              class="option"
              type="button"
              aria-pressed={chosen.id === font.id}
              style:font-family={fontStack(font)}
              onclick={() => choose(font)}
            >
              <span class="name">{font.name} <small>{font.note}</small></span>
              <span class="sample">Quick brown fox, 0123 <b>Ledger</b></span>
            </button>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>

<style>
  .inline .panel { position: static; width: auto; max-height: none; box-shadow: none; }
  .picker { position: relative; }
  .picker > .btn { padding: 4px 12px; font-size: .85rem; white-space: nowrap; }
  .label { margin-left: 6px; }
  @media (max-width: 959px) {
    .label { display: none; }
    .picker { position: static; }
    .panel { left: 10px; right: 10px; width: auto; }
  }
  .panel {
    position: absolute;
    right: 0;
    top: calc(100% + 8px);
    z-index: 20;
    width: min(380px, 92vw);
    max-height: 75dvh;
    overflow-y: auto;
    padding: 10px;
    background: var(--card);
    border: 2px solid var(--line);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow);
  }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
  .option {
    display: grid;
    gap: 2px;
    width: 100%;
    padding: 8px 12px;
    border: 2px solid transparent;
    border-radius: var(--r-lg);
    background: none;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }
  .option:hover { background: var(--pink-soft); }
  .option[aria-pressed="true"] { border-color: var(--pink); background: var(--pink-soft); }
  .name { font-size: .8rem; font-weight: 700; }
  .name small { color: var(--muted); font-weight: 400; }
  .sample { font-size: 1.05rem; }
</style>
