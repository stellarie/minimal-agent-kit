<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "./api.ts";
  import type { LoungeClient, WikiFinding } from "./api.ts";

  let { client }: { client: LoungeClient } = $props();

  let folder = $state("");
  let pages = $state<string[]>([]);
  // The open page. Null with `creating` set is a new page.
  let open = $state<string | null>(null);
  let creating = $state(false);
  let newName = $state("");
  let text = $state("");
  let saved = $state("");
  let findings = $state<WikiFinding[] | null>(null);
  let failed = $state(false);
  let problem = $state("");
  let busy = $state(false);

  const dirty = $derived(text !== saved);
  const target = $derived(creating ? newName.trim() : (open ?? ""));
  const canSave = $derived(!busy && target !== "" && (creating || dirty));

  function reason(err: unknown): string {
    return err instanceof ApiError ? err.message : "Cannot reach the core.";
  }

  async function refresh(): Promise<void> {
    const list = await client.wikiPages();
    folder = list.folder;
    pages = list.pages;
  }

  function leave(): boolean {
    return !dirty || confirm("Discard the unsaved changes?");
  }

  async function pick(name: string): Promise<void> {
    if (!leave()) return;
    problem = "";
    try {
      const page = await client.wikiPage(name);
      open = page.name;
      creating = false;
      text = page.text;
      saved = page.text;
      findings = null;
    } catch (err) {
      problem = reason(err);
    }
  }

  function start(): void {
    if (!leave()) return;
    open = null;
    creating = true;
    newName = "";
    text = "";
    saved = "";
    findings = null;
    problem = "";
  }

  async function save(): Promise<void> {
    busy = true;
    problem = "";
    try {
      const done = await client.saveWikiPage(target, text);
      saved = text;
      open = done.name;
      creating = false;
      findings = done.findings;
      failed = done.fail;
      await refresh();
    } catch (err) {
      // The text stays, so a failed save loses nothing.
      problem = reason(err);
    } finally {
      busy = false;
    }
  }

  function revert(): void {
    text = saved;
    problem = "";
  }

  onMount(() => {
    refresh().catch((err: unknown) => {
      problem = reason(err);
    });
  });
</script>

<section class="wiki" aria-labelledby="wiki-title">
  <h1 id="wiki-title" class="view-title">wiki</h1>

  {#if problem}
    <p class="error" role="alert">{problem}</p>
  {/if}

  <div class="cols">
    <div class="sticker list">
      <h2 class="tape">Pages</h2>
      {#if folder}<p class="hint">{folder}</p>{/if}
      <ul>
        {#each pages as name (name)}
          <li>
            <button class="page" class:on={name === open} type="button" aria-current={name === open ? "page" : undefined} onclick={() => void pick(name)}>
              {name}
            </button>
          </li>
        {:else}
          <li class="hint">No pages yet.</li>
        {/each}
      </ul>
      <button class="btn btn--soft" type="button" onclick={start}>New page</button>
    </div>

    <div class="sticker editor">
      {#if open === null && !creating}
        <p class="hint">Pick a page, or start a new one.</p>
      {:else}
        <h2 class="tape">{creating ? "New page" : open}</h2>
        {#if creating}
          <label for="wiki-name">File name</label>
          <input id="wiki-name" class="field" spellcheck="false" placeholder="topic-name.md" bind:value={newName} />
        {/if}
        <label for="wiki-text">Page text</label>
        <textarea id="wiki-text" class="field text" spellcheck="false" disabled={busy} bind:value={text}></textarea>
        <div class="row">
          <span class="spacer"></span>
          <button class="btn btn--soft" type="button" disabled={busy || !dirty} onclick={revert}>Revert</button>
          <button class="btn" type="button" disabled={!canSave} onclick={() => void save()}>{busy ? "Saving" : "Save"}</button>
        </div>

        {#if findings !== null}
          <h3>
            Wiki check
            {#if failed}(fail){:else if findings.length === 0}(clean){/if}
          </h3>
          <ul class="findings" aria-label="Wiki check findings">
            {#each findings as f}
              <li class="finding {f.level}">
                <strong>{f.level}</strong>
                {#if f.file}<code>{f.file}{f.line ? `:${f.line}` : ""}</code>{/if}
                {f.detail}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </div>
  </div>
</section>

<style>
  .wiki { max-width: 1080px; margin: 0 auto; padding: 0 16px 24px; }
  .cols { display: grid; grid-template-columns: minmax(180px, 1fr) 3fr; gap: 16px; align-items: start; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } }
  .list, .editor { padding: 16px; }
  h2 { margin: 0 0 10px; font-family: var(--font); font-size: .95rem; font-weight: 400; line-height: 1.6; }
  h3 { margin: 14px 0 6px; font-size: .95rem; }
  label { display: block; margin-top: 6px; font-weight: 700; }
  .hint { margin: 2px 0 10px; color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }
  .error { margin: 0 0 10px; }
  ul { margin: 0 0 10px; padding: 0; list-style: none; }
  .page { width: 100%; padding: 4px 6px; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
  .page.on { font-weight: 700; }
  .text { width: 100%; min-height: 40dvh; padding: 12px; resize: vertical; font-family: var(--font-mono); font-size: .9rem; line-height: 1.5; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .finding { padding: 3px 0; font-size: .9rem; overflow-wrap: anywhere; }
  .finding.fail strong { color: var(--pink-deep); }
  .finding.not-run strong { color: var(--muted); }
</style>
