<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, type LoginView, type LoungeClient } from "../lib/api.ts";
  import { loginBusy, loginSummary } from "../lib/skills.ts";

  let { client }: { client: LoungeClient } = $props();

  const POLL_MS = 1500;

  let view = $state<LoginView | null>(null);
  let problem = $state("");
  let busy = $state(false);

  const running = $derived(view !== null && loginBusy(view));

  function reason(err: unknown): string {
    return err instanceof ApiError ? err.message : "Cannot reach the core.";
  }

  async function run(call: () => Promise<LoginView>): Promise<void> {
    busy = true;
    problem = "";
    try {
      view = await call();
    } catch (err) {
      problem = reason(err);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void run(() => client.codexLogin());
  });

  // The sign-in ends in the browser, so poll while it runs.
  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      client.codexLogin().then(
        (next) => (view = next),
        (err: unknown) => (problem = reason(err)),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  });
</script>

<div class="plugin codex" role="group" aria-labelledby="codex-title">
  <div class="row">
    <h2 id="codex-title" class="name">Codex sign-in</h2>
    <span class="chip">lounge login</span>
  </div>
  <p class="desc">
    Codex agents run with their own login in the lounge folder, so your own Codex login stays untouched. Sign in once
    here.
  </p>
  {#if problem}
    <p class="error" role="alert">{problem}</p>
  {/if}
  {#if view}
    <p class="meta" role="status">{loginSummary(view)}</p>
    {#if running && view.url}
      <p class="meta">
        If the browser did not open, use
        <a href={view.url} target="_blank" rel="noopener noreferrer">this sign-in page</a>.
      </p>
    {/if}
  {/if}
  <div class="actions">
    <button class="btn" type="button" disabled={busy || running} onclick={() => void run(() => client.startCodexLogin())}>
      Sign in to Codex
    </button>
    {#if running}
      <button class="btn btn--soft" type="button" disabled={busy} onclick={() => void run(() => client.cancelCodexLogin())}>
        Cancel
      </button>
    {/if}
  </div>
</div>

<style>
  .codex {
    margin-top: 14px;
    padding: 10px 12px;
    background: var(--bg);
    border: 2px solid var(--line);
    border-left: 5px solid var(--tape-2);
    border-radius: var(--r-lg);
  }
  .row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
  .name { margin: 0; font-size: 1.05rem; }
  .desc { margin: 4px 0 0; overflow-wrap: anywhere; }
  .meta { margin: 6px 0 0; color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }
  .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
</style>
