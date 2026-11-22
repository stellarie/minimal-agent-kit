<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, type Agent, type GrantTable, type LoungeClient } from "../lib/api.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { roster, whoColor } from "../lib/roster.svelte.ts";
  import GuardRuleAsks from "./GuardRuleAsks.svelte";
  import GuardBlockAsks from "./GuardBlockAsks.svelte";
  import GuardJudge from "./GuardJudge.svelte";
  import GuardLog from "./GuardLog.svelte";

  let { client, pending, changes }: { client: LoungeClient; pending: number; changes: number } = $props();

  let table = $state<GrantTable | null>(null);
  let problem = $state("");
  let saving = $state("");

  function reason(err: unknown): string {
    return err instanceof ApiError ? err.message : "Cannot reach the core.";
  }

  async function toggle(name: Agent, id: string, on: boolean): Promise<void> {
    if (!table) return;
    saving = `${name}.${id}`;
    problem = "";
    try {
      table.grants[name] = await client.setGrants(name, { [id]: on });
    } catch (err) {
      problem = reason(err);
    } finally {
      saving = "";
    }
  }

  onMount(() => {
    client.grants().then(
      (t) => (table = t),
      (err) => (problem = reason(err)),
    );
  });
</script>

<section class="permissions" aria-labelledby="perm-title">
  <h1 id="perm-title" class="view-title">permissions</h1>
  <div class="sticker">
    <p class="hint">
      The lounge tools each agent may use. A change applies from its next turn. Its own runtime tools stay as its
      settings say.
    </p>
    {#if problem}
      <p class="error" role="alert">{problem}</p>
    {/if}
    {#if table}
    <table>
      <thead>
        <tr>
          <th scope="col">Tool</th>
          {#each roster.agents as { id: name } (name)}
            <th scope="col"><span class="chip" style:--who={whoColor(name)}>{nameOf(name)}</span></th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each table.groups as group (group.id)}
          <tr>
            <th scope="row">{group.label}</th>
            {#each roster.agents as { id: name } (name)}
              <td>
                <input
                  type="checkbox"
                  aria-label="{group.label} for {nameOf(name)}"
                  checked={table.grants[name]?.[group.id] ?? true}
                  disabled={saving === `${name}.${group.id}`}
                  onchange={(e) => void toggle(name, group.id, e.currentTarget.checked)}
                />
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
    {:else if !problem}
      <p class="hint">Loading…</p>
    {/if}
  </div>
  <GuardRuleAsks {client} />
  <GuardBlockAsks {client} />
  <GuardJudge {client} />
  <GuardLog {client} {pending} {changes} />
</section>

<style>
  .permissions { max-width: 820px; margin: 0 auto; padding: 0 16px 24px; }
  .sticker { padding: 16px 20px 20px; }
  .hint { margin: 0; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid var(--line); }
  thead th { text-align: center; }
  tbody th { text-align: left; font-weight: 600; }
  tbody tr:hover { background: var(--pink-soft); }
  td { text-align: center; }
  input { width: 18px; height: 18px; accent-color: var(--pink); cursor: pointer; }
  @media (max-width: 599px) {
    th, td { padding: 6px 4px; }
    .chip { padding: 0 6px; font-size: .7rem; }
  }
</style>
