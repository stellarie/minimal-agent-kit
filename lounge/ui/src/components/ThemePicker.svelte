<script lang="ts">
  import { onMount } from "svelte";
  import {
    COLOR_KEYS,
    COLOR_LABELS,
    MAX_THEMES,
    MIN_CONTRAST,
    PATTERNS,
    PATTERN_LABELS,
    SAMPLES,
    SYSTEM,
    exportThemes,
    importThemes,
    lowContrast,
    newThemeId,
    parseCustom,
    themeVars,
    type Theme,
  } from "../lib/themes.ts";

  const THEME_KEY = "agent-lounge.theme";
  const CUSTOM_KEY = "agent-lounge.themes";

  // inline: show the list on a page, no popover.
  let { inline = false }: { inline?: boolean } = $props();

  let open = $state(false);
  let chosen = $state(SYSTEM);
  let custom = $state<Theme[]>([]);
  let draft = $state<Theme | null>(null);
  let importing = $state(false);
  let importText = $state("");
  let notice = $state("");
  let applied: string[] = [];
  let panel = $state<HTMLElement>();

  const all = $derived([...SAMPLES, ...custom]);
  const current = $derived(all.find((t) => t.id === chosen));
  const warnings = $derived(draft ? lowContrast(draft) : []);

  function apply(theme: Theme | undefined) {
    const root = document.documentElement;
    for (const name of applied) root.style.removeProperty(name);
    applied = [];
    if (!theme) {
      delete root.dataset.theme;
      return;
    }
    for (const [name, value] of Object.entries(themeVars(theme))) {
      root.style.setProperty(name, value);
      applied.push(name);
    }
    root.dataset.theme = theme.dark ? "dark" : "light";
  }

  function choose(id: string) {
    chosen = id;
    localStorage.setItem(THEME_KEY, id);
    apply(all.find((t) => t.id === id));
  }

  function saveCustom() {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  }

  function startNew() {
    const base = current ?? (matchMedia("(prefers-color-scheme: dark)").matches ? SAMPLES[1] : SAMPLES[0]);
    draft = { id: newThemeId(custom), name: "My theme", dark: base.dark, pattern: base.pattern, colors: { ...base.colors }, custom: true };
    apply(draft);
  }

  function edit(theme: Theme) {
    draft = { ...theme, colors: { ...theme.colors } };
    apply(draft);
  }

  function commit(e: SubmitEvent) {
    e.preventDefault();
    if (!draft) return;
    const theme = { ...draft, name: draft.name.trim().slice(0, 40) || "My theme" };
    const i = custom.findIndex((t) => t.id === theme.id);
    custom = i < 0 ? [...custom, theme] : custom.map((t) => (t.id === theme.id ? theme : t));
    saveCustom();
    draft = null;
    choose(theme.id);
  }

  function cancel() {
    draft = null;
    apply(current);
  }

  function remove(theme: Theme) {
    if (!confirm(`Delete the theme "${theme.name}"?`)) return;
    custom = custom.filter((t) => t.id !== theme.id);
    saveCustom();
    if (chosen === theme.id) choose(SYSTEM);
  }

  async function exportAll() {
    try {
      await navigator.clipboard.writeText(exportThemes(custom));
      notice = `Copied ${count(custom.length)} to the clipboard.`;
    } catch {
      notice = "The browser did not allow the copy.";
    }
  }

  function runImport() {
    const got = importThemes(importText, custom);
    if (!got.ok) {
      notice = got.error;
      return;
    }
    notice = `Imported ${count(got.themes.length - custom.length)}.`;
    custom = got.themes;
    saveCustom();
    importText = "";
    importing = false;
  }

  function count(n: number): string {
    return `${n} ${n === 1 ? "theme" : "themes"}`;
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape" || !open) return;
    if (draft) cancel();
    else open = false;
  }

  function onPointer(e: PointerEvent) {
    if (open && !draft && panel && !panel.contains(e.target as Node)) open = false;
  }

  onMount(() => {
    custom = parseCustom(localStorage.getItem(CUSTOM_KEY));
    const saved = localStorage.getItem(THEME_KEY) ?? SYSTEM;
    chosen = saved === SYSTEM || [...SAMPLES, ...custom].some((t) => t.id === saved) ? saved : SYSTEM;
    apply([...SAMPLES, ...custom].find((t) => t.id === chosen));
  });
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onPointer} />

<div class="picker" class:inline bind:this={panel}>
  {#if !inline}
  <button
    class="btn btn--soft"
    type="button"
    aria-expanded={open}
    aria-controls="theme-panel"
    aria-label="Theme: {current?.name ?? 'System'}"
    onclick={() => (open = !open)}
  >
    <span aria-hidden="true">◐</span><span class="label" aria-hidden="true">Theme: {current?.name ?? "System"}</span>
  </button>
  {/if}

  {#if open || inline}
    <div id="theme-panel" class="panel" role="dialog" aria-label="Themes">
      {#if draft}
        <form class="editor" onsubmit={commit}>
          <h2>{custom.some((t) => t.id === draft?.id) ? "Edit theme" : "New theme"}</h2>
          <label class="line">
            <span>Name</span>
            <input class="field" maxlength="40" bind:value={draft.name} />
          </label>
          <label class="line">
            <span>Background pattern</span>
            <select class="field" bind:value={draft.pattern} onchange={() => apply(draft ?? undefined)}>
              {#each PATTERNS as p (p)}<option value={p}>{PATTERN_LABELS[p]}</option>{/each}
            </select>
          </label>
          <label class="check">
            <input type="checkbox" bind:checked={draft.dark} onchange={() => apply(draft ?? undefined)} />
            Dark theme (dark scroll bars and form controls)
          </label>
          <div class="colors">
            {#each COLOR_KEYS as key (key)}
              <label class="color">
                <input type="color" bind:value={draft.colors[key]} oninput={() => apply(draft ?? undefined)} />
                <span>{COLOR_LABELS[key]}</span>
              </label>
            {/each}
          </div>
          <p class="contrast" aria-live="polite">
            {#if warnings.length === 0}
              All text pairs reach {MIN_CONTRAST}:1 contrast.
            {:else}
              Hard to read: {warnings.map((w) => `${w.label} (${w.ratio}:1)`).join(", ")}.
            {/if}
          </p>
          <div class="actions">
            <button class="btn" type="submit">Save theme</button>
            <button class="btn btn--soft" type="button" onclick={cancel}>Cancel</button>
          </div>
        </form>
      {:else}
        <ul class="list">
          <li>
            <button class="option" type="button" aria-pressed={chosen === SYSTEM} onclick={() => choose(SYSTEM)}>
              <span class="swatch swatch--system" aria-hidden="true"></span>
              <span class="label">System <small>Ledger, light or dark</small></span>
            </button>
          </li>
          {#each all as theme (theme.id)}
            <li>
              <button class="option" type="button" aria-pressed={chosen === theme.id} onclick={() => choose(theme.id)}>
                <span class="swatch" aria-hidden="true">
                  <i style:background={theme.colors.bg}></i>
                  <i style:background={theme.colors.card}></i>
                  <i style:background={theme.colors.pink}></i>
                  <i style:background={theme.colors.ink}></i>
                </span>
                <span class="label">{theme.name}<small>{PATTERN_LABELS[theme.pattern]}{theme.custom ? ", custom" : ""}</small></span>
              </button>
              {#if theme.custom}
                <span class="row-actions">
                  <button class="link" type="button" onclick={() => edit(theme)}>Edit<span class="sr-only"> {theme.name}</span></button>
                  <button class="link" type="button" onclick={() => remove(theme)}>Delete<span class="sr-only"> {theme.name}</span></button>
                </span>
              {/if}
            </li>
          {/each}
        </ul>
        <button class="btn new" type="button" disabled={custom.length >= MAX_THEMES} onclick={startNew}>
          + New theme from this one
        </button>
        <div class="transfer">
          <button class="btn btn--soft" type="button" disabled={custom.length === 0} onclick={exportAll}>Export custom themes</button>
          <button class="btn btn--soft" type="button" aria-expanded={importing} onclick={() => (importing = !importing)}>Import themes</button>
        </div>
        {#if importing}
          <label class="line">
            <span>Paste theme JSON</span>
            <textarea class="field" rows="6" bind:value={importText}></textarea>
          </label>
          <button class="btn" type="button" disabled={importText.trim() === ""} onclick={runImport}>Add themes</button>
        {/if}
        {#if notice}<p class="contrast" role="status">{notice}</p>{/if}
      {/if}
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
    width: min(360px, 92vw);
    max-height: 75dvh;
    overflow-y: auto;
    padding: 12px;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    box-shadow: var(--shadow);
  }
  .list { list-style: none; margin: 0 0 10px; padding: 0; display: grid; gap: 4px; }
  .list li { display: flex; align-items: center; gap: 6px; }
  .option {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border: 1px solid transparent;
    border-radius: var(--r-lg);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .option:hover { background: var(--pink-soft); }
  .option[aria-pressed="true"] { border-color: var(--pink); background: var(--pink-soft); font-weight: 600; }
  .swatch {
    display: grid;
    grid-template-columns: repeat(4, 10px);
    height: 22px;
    border: 1px solid var(--line);
    border-radius: var(--r);
    overflow: hidden;
  }
  .swatch--system { width: 44px; background: linear-gradient(135deg, #f5f2ea 50%, #13171a 50%); }
  .label small { margin-left: 6px; color: var(--muted); font-size: .75rem; font-weight: 400; }
  .row-actions { display: flex; gap: 8px; }
  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--pink-deep);
    font-size: .8rem;
    text-decoration: underline;
    cursor: pointer;
  }
  .new { width: 100%; }
  .transfer { display: flex; gap: 8px; margin: 8px 0; }
  .transfer .btn { flex: 1; }
  h2 { margin: 0 0 10px; font-size: 1rem; }
  .line { display: grid; gap: 4px; margin-bottom: 8px; font-weight: 600; font-size: .85rem; }
  .line .field { padding: 6px 10px; border-radius: var(--r); font-weight: 400; }
  .check { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-size: .85rem; }
  .colors { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
  .color { display: flex; align-items: center; gap: 8px; font-size: .85rem; }
  .color input {
    width: 36px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--r);
    background: none;
    cursor: pointer;
  }
  .contrast { margin: 10px 0 0; color: var(--muted); font-size: .8rem; }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
</style>
