<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, RULES_MAX_BYTES } from "../lib/api.ts";
  import type { LoungeClient } from "../lib/api.ts";
  import { rulesState } from "../lib/rules.ts";

  let { client }: { client: LoungeClient } = $props();

  let text = $state("");
  let saved = $state("");
  let loaded = $state(false);
  let problem = $state("");
  let busy = $state(false);
  let done = $state(false);

  const check = $derived(rulesState(text, saved));

  function reason(err: unknown): string {
    return err instanceof ApiError ? err.message : "Cannot reach the core.";
  }

  async function save(): Promise<void> {
    busy = true;
    problem = "";
    done = false;
    try {
      const body = await client.saveLoungeRules(text);
      saved = body.text;
      text = body.text;
      done = true;
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
    done = false;
  }

  onMount(() => {
    client.loungeRules().then(
      (body) => {
        saved = body.text;
        text = body.text;
        loaded = true;
      },
      (err: unknown) => {
        problem = reason(err);
      },
    );
  });
</script>

<section class="rules" aria-labelledby="rules-title">
  <h1 id="rules-title" class="view-title">lounge rules</h1>

  <div class="sticker editor">
    <h2 class="tape">Rules for every agent</h2>

    {#if problem}
      <p class="error" role="alert">{problem}</p>
    {/if}

    <label for="rules-text">Lounge rules</label>
    <p id="rules-hint" class="hint">
      Every agent gets this text in its system prompt, on each turn. The built-in reply rules come after it and win.
      A saved change applies from the next turn.
    </p>
    <textarea
      id="rules-text"
      class="field text"
      spellcheck="false"
      aria-describedby="rules-hint"
      disabled={!loaded || busy}
      bind:value={text}
    ></textarea>

    <div class="row">
      <span class="count" class:over={check.over}>
        {check.bytes} / {RULES_MAX_BYTES} bytes
        {#if check.over}(over the limit){/if}
      </span>
      <span class="spacer"></span>
      <button class="btn btn--soft" type="button" disabled={busy || !check.dirty} onclick={revert}>Revert</button>
      <button class="btn" type="button" disabled={busy || !check.canSave} onclick={() => void save()}>
        {busy ? "Saving" : "Save"}
      </button>
    </div>
    {#if done && !check.dirty}
      <p class="muted">Saved.</p>
    {/if}
  </div>
</section>

<style>
  .rules { max-width: 1080px; margin: 0 auto; padding: 0 16px 24px; }
  .editor { padding: 16px; }
  h2 { margin: 0 0 10px; font-family: var(--font); font-size: .95rem; font-weight: 400; line-height: 1.6; }
  label { font-weight: 700; }
  .hint { margin: 2px 0 10px; color: var(--muted); font-size: .9rem; }
  .error { margin: 0 0 10px; }
  .text {
    width: 100%;
    min-height: 46dvh;
    padding: 12px;
    resize: vertical;
    font-family: var(--font-mono);
    font-size: .9rem;
    line-height: 1.5;
  }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .count { color: var(--muted); font-size: .85rem; }
  .count.over { color: var(--pink-deep); font-weight: 700; }
  .muted { margin: 6px 0 0; color: var(--muted); font-size: .85rem; }
</style>
