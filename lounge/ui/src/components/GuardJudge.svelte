<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, type GuardJudge, type LoungeClient } from "../lib/api.ts";
  import { modelMode } from "../lib/modelChoice.ts";

  let { client }: { client: LoungeClient } = $props();

  const CUSTOM = "\u0000custom";

  // Null until the core answers.
  let saved = $state<GuardJudge | null>(null);
  let model = $state("");
  let effort = $state("");
  let policy = $state("");
  let customModel = $state(false);
  let busy = $state(false);
  let problem = $state("");
  let note = $state("");

  const models = $derived(saved?.models ?? []);
  const modelSelect = $derived(customModel || modelMode(model, models) === "custom" ? CUSTOM : model);
  const dirty = $derived(
    saved !== null && (model !== saved.model || effort !== saved.effort || policy !== saved.policy),
  );

  function reason(err: unknown): string {
    return err instanceof ApiError ? err.message : "Cannot reach the core.";
  }

  function take(next: GuardJudge): void {
    saved = next;
    model = next.model;
    effort = next.effort;
    policy = next.policy;
    customModel = false;
  }

  async function load(): Promise<void> {
    try {
      take(await client.guardJudge());
      problem = "";
    } catch (err) {
      problem = reason(err);
    }
  }

  async function save(): Promise<void> {
    busy = true;
    note = "";
    try {
      take(await client.setGuardJudge({ runtime: "claude-code", model, effort, policy }));
      problem = "";
      note = "Saved. The next judged call uses it.";
    } catch (err) {
      problem = reason(err);
    } finally {
      busy = false;
    }
  }

  function onModelSelect(e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value;
    customModel = value === CUSTOM;
    if (!customModel) model = value;
  }

  onMount(() => {
    void load();
  });
</script>

<section class="sticker judge" aria-labelledby="judge-title">
  <h2 id="judge-title" class="section-title">Guard judge</h2>
  <p class="hint">
    In Auto mode, this Claude model rates each rule ask. An exact SAFE allows it with no card. Anything else opens a
    card. The policy lists cases that you allow or never allow. Where the policy names a case, it decides.
  </p>
  {#if problem}
    <p class="error" role="alert">{problem}</p>
  {/if}
  {#if saved}
    <label>
      <span>Model</span>
      <select class="field" value={modelSelect} onchange={onModelSelect}>
        {#each models as m (m)}<option value={m}>{m}</option>{/each}
        <option value={CUSTOM}>Custom…</option>
      </select>
    </label>
    {#if modelSelect === CUSTOM}
      <label>
        <span>Custom model</span>
        <input class="field" bind:value={model} placeholder="Model name" autocomplete="off" maxlength="100" />
      </label>
    {/if}
    <label>
      <span>Effort</span>
      <select class="field" bind:value={effort}>
        <option value="">Model default</option>
        {#each saved.efforts as level (level)}<option value={level}>{level}</option>{/each}
      </select>
    </label>
    <label>
      <span>Policy</span>
      <textarea class="field" rows="10" maxlength="4096" bind:value={policy}></textarea>
    </label>
    <div class="actions">
      <button class="btn" type="button" disabled={busy || !dirty || model.trim() === ""} onclick={() => void save()}>Save</button>
      <button class="btn btn--soft" type="button" disabled={busy || policy === saved.defaultPolicy} onclick={() => (policy = saved!.defaultPolicy)}>
        Restore default policy
      </button>
      <small class="hint">{policy.length} / 4096</small>
    </div>
    {#if note}
      <p class="hint" role="status">{note}</p>
    {/if}
  {:else if !problem}
    <p class="hint">Loading…</p>
  {/if}
</section>

<style>
  .judge { margin-top: 28px; padding: 14px 20px 20px; display: grid; gap: 10px; }
  .hint { margin: 0; color: var(--muted); }
  label { display: grid; gap: 4px; font-weight: 700; }
  textarea { font-family: var(--font-mono); font-size: .85rem; resize: vertical; }
  .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
</style>
