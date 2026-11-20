<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, type LoungeClient, type PluginInfo } from "../lib/api.ts";
  import { panelSrc } from "../lib/guard.ts";
  import CodexSignIn from "./CodexSignIn.svelte";

  let { client }: { client: LoungeClient } = $props();

  let plugins = $state<PluginInfo[] | null>(null);
  let problem = $state("");
  let busy = $state("");

  function reason(err: unknown): string {
    return err instanceof ApiError ? err.message : "Cannot reach the core.";
  }

  async function run(key: string, call: () => Promise<PluginInfo[]>): Promise<void> {
    busy = key;
    problem = "";
    try {
      plugins = await call();
    } catch (err) {
      problem = reason(err);
    } finally {
      busy = "";
    }
  }

  onMount(() => {
    client.plugins().then(
      (list) => (plugins = list),
      (err) => (problem = reason(err)),
    );
  });
</script>

<section class="plugins" aria-labelledby="plugins-title">
  <h1 id="plugins-title" class="view-title">plugins</h1>
  <div class="sticker">
    <div class="head">
      <p class="hint">
        A plugin adds tools, guard rules, panels, and runtimes. Its code runs in the core with full access, so
        enable only plugins you trust. A plugin tool shows as a row in Permissions. A bundled plugin ships with
        the lounge.
      </p>
      <button
        class="btn btn--soft"
        type="button"
        disabled={busy !== ""}
        onclick={() => void run("reload", () => client.reloadPlugins())}
      >
        Reload
      </button>
    </div>
    {#if problem}
      <p class="error" role="alert">{problem}</p>
    {/if}
    <div class="plugin builtin">
      <div class="row">
        <h2 class="name">Lounge guard</h2>
        <span class="chip">built in</span>
        <span class="on">Always on</span>
      </div>
      <p class="desc">
        Checks every shell, write, and read call before it runs. It blocks wipes and asks you about risky calls.
        Recent decisions show in Permissions.
      </p>
      <p class="meta">A runtime with a guard hook runs it on every turn.</p>
    </div>
    <CodexSignIn {client} />
    {#if plugins}
      {#if plugins.length === 0}
        <p class="hint">No plugins found. Put one in the plugins folder of the lounge home, then press Reload.</p>
      {:else}
        <ul class="list">
          {#each plugins as p (p.id)}
            {@const src = p.enabled ? panelSrc(p.panel) : null}
            <li class="plugin">
              <div class="row">
                <h2 class="name">{p.name}</h2>
                {#if p.version}<span class="chip">v{p.version}</span>{/if}
                {#if p.bundled}<span class="chip">Bundled</span>{/if}
                <code class="id">{p.id}</code>
                <button
                  class="switch"
                  type="button"
                  aria-pressed={p.enabled}
                  disabled={busy !== ""}
                  onclick={() => void run(p.id, () => client.setPlugin(p.id, !p.enabled))}
                >
                  Enabled<span class="sr-only">: {p.name}</span>
                </button>
              </div>
              {#if p.description}<p class="desc">{p.description}</p>{/if}
              {#if p.error}<p class="error" role="alert">{p.error}</p>{/if}
              {#if p.runtimes.length > 0}
                <p class="meta">
                  Runtimes:
                  {#each p.runtimes as rt (rt)}<code class="tool">{rt}</code>{/each}
                </p>
              {/if}
              <p class="meta">
                {#if p.tools.length > 0}
                  Tools:
                  {#each p.tools as tool (tool)}<code class="tool">{tool}</code>{/each}
                {:else}
                  No tools.
                {/if}
                <span class="guards">{p.guards} guard {p.guards === 1 ? "rule" : "rules"}</span>
              </p>
              {#if src}
                <iframe class="panel" title="{p.name} panel" sandbox="allow-scripts" referrerpolicy="no-referrer" {src}></iframe>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:else if !problem}
      <p class="hint">Loading…</p>
    {/if}
  </div>
</section>

<style>
  .plugins { max-width: 820px; margin: 0 auto; padding: 0 16px 24px; }
  .sticker { padding: 16px 20px 20px; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .hint { margin: 0; color: var(--muted); }
  .list { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 12px; }
  .plugin {
    padding: 10px 12px;
    background: var(--bg);
    border: 2px solid var(--line);
    border-left: 5px solid var(--pink);
    border-radius: var(--r-lg);
  }
  .builtin { margin-top: 14px; border-left-color: var(--tape-2); }
  .on { margin-left: auto; font-size: .85rem; font-weight: 700; }
  .row { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
  .name { margin: 0; font-size: 1.05rem; }
  .row .switch { margin-left: auto; }
  code { font-family: var(--font-mono); font-size: .8rem; }
  .id { color: var(--muted); }
  .desc { margin: 4px 0 0; overflow-wrap: anywhere; }
  .meta { margin: 6px 0 0; color: var(--muted); font-size: .85rem; }
  .tool { margin-right: 6px; padding: 0 6px; background: var(--pink-soft); color: var(--ink); border-radius: var(--r-sm); }
  .guards { margin-left: 6px; }
  .panel {
    display: block;
    width: 100%;
    height: 220px;
    margin-top: 10px;
    background: var(--card);
    border: 2px solid var(--line);
    border-radius: var(--r);
  }
  @media (max-width: 599px) {
    .head { flex-direction: column; }
    .row .switch { margin-left: 0; }
  }
</style>
