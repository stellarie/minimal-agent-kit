<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError } from "../lib/api.ts";
  import type { AgentEntry, AgentPatch, AgentView, LoungeClient, NewAgent, RuntimeChoices } from "../lib/api.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { modelMode } from "../lib/modelChoice.ts";
  import { MODE_HELP, MODE_LABELS, NO_MODES_NOTE, defaultMode, modeChoices, type ToolMode } from "../lib/toolModes.ts";
  import { roster, setRoster, whoColor } from "../lib/roster.svelte.ts";
  import { RUNTIME_OPTION_KEYS, TAPE_SLOTS, capitalize, tapeVar, validId } from "../lib/roster.ts";

  // onChange: reload the roster and who is here.
  let { client, onChange }: { client: LoungeClient; onChange: () => void } = $props();

  const NEW = "";
  const CUSTOM = "__custom__";

  let selected = $state(NEW);
  let id = $state("");
  let displayName = $state("");
  let runtime = $state("");
  let model = $state("");
  let effort = $state("");
  let customModel = $state(false);
  let tape = $state<AgentEntry["tape"]>(1);
  let toolMode = $state<ToolMode>("full");
  let enabled = $state(true);
  let reply = $state("");
  let choices = $state<RuntimeChoices>({ efforts: [], models: [] });
  let problem = $state("");
  let busy = $state(false);
  let confirmRetire = $state(false);

  const adding = $derived(selected === NEW);
  const entry = $derived<AgentView | undefined>(roster.agents.find((e) => e.id === selected));
  const idOk = $derived(validId(id));
  const kindInfo = $derived(roster.runtimes.find((r) => r.id === runtime));
  // A runtime that is not loaded keeps the mode the agent has.
  const supportsModes = $derived(
    kindInfo?.toolModes === true || (kindInfo === undefined && entry?.runtime === runtime && entry.toolMode !== "full"),
  );
  const modes = $derived(modeChoices(supportsModes));
  const idHint = $derived(id !== "" && !idOk ? "2 to 24 characters: a-z, 0-9, hyphen. Start with a letter." : "");

  function reason(err: unknown): string {
    return err instanceof ApiError ? err.message : "Cannot reach the core.";
  }

  async function reload(): Promise<void> {
    try {
      const list = await client.agents();
      setRoster(list.agents, list.runtimes, list.retired);
    } catch (err) {
      problem = reason(err);
    }
  }

  // The runtime sets the efforts and models.
  async function loadChoices(): Promise<void> {
    try {
      choices = await client.runtimeOptions(runtime, { model, effort, options: reply ? { reply } : {} });
      if (effort !== "" && !choices.efforts.includes(effort)) effort = "";
    } catch (err) {
      problem = reason(err);
    }
  }

  const modelSelect = $derived(customModel ? CUSTOM : modelMode(model, choices.models) === "custom" ? CUSTOM : model);

  function onModelSelect(e: Event): void {
    const value = (e.currentTarget as HTMLSelectElement).value;
    customModel = value === CUSTOM;
    if (!customModel) model = value;
    void loadChoices();
  }

  async function refresh(): Promise<void> {
    busy = true;
    try {
      await client.reloadPlugins();
      await loadChoices();
      onChange();
    } catch (err) {
      problem = reason(err);
    } finally {
      busy = false;
    }
  }

  function fill(e: AgentView | undefined): void {
    customModel = false;
    problem = "";
    confirmRetire = false;
    if (e === undefined) {
      id = "";
      displayName = "";
      runtime = roster.runtimes[0]?.id ?? "";
      model = "";
      effort = "";
      tape = (((roster.agents.length % 4) + 1) as AgentEntry["tape"]);
      toolMode = defaultMode(roster.runtimes.find((r) => r.id === runtime)?.toolModes === true);
      enabled = true;
      reply = "";
      void loadChoices();
    } else {
      id = e.id;
      displayName = "";
      runtime = e.runtime;
      model = e.model;
      effort = e.effort;
      tape = e.tape;
      toolMode = e.toolMode;
      enabled = e.enabled;
      reply = typeof e.options.reply === "string" ? e.options.reply : "";
      choices = { efforts: e.efforts, models: e.models };
    }
  }

  function pick(next: string): void {
    selected = next;
    fill(roster.agents.find((e) => e.id === next));
  }

  async function changeRuntime(): Promise<void> {
    // The core resets the mode when the new runtime ignores modes.
    if (!supportsModes) toolMode = "full";
    else if (adding && toolMode === "full") toolMode = defaultMode(true);
    await loadChoices();
  }

  function optionsFor(): AgentEntry["options"] {
    const base = { ...(entry?.options ?? {}) };
    // Old runtime options mean nothing to a new one.
    if (entry !== undefined && entry.runtime !== runtime) {
      for (const key of RUNTIME_OPTION_KEYS) delete base[key];
    }
    if (runtime === "stub") base.reply = reply;
    else delete base.reply;
    return base;
  }

  async function save(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    busy = true;
    problem = "";
    try {
      if (adding) {
        const draft: NewAgent = { id, runtime, model, effort, enabled, tape, toolMode, options: optionsFor() };
        if (displayName.trim() !== "") draft.displayName = displayName.trim();
        const created = await client.addAgent(draft);
        await reload();
        onChange();
        selected = created.id;
        fill(roster.agents.find((x) => x.id === created.id));
      } else {
        const patch: AgentPatch = { runtime, model, effort, enabled, tape, toolMode, options: optionsFor() };
        if (displayName.trim() !== "") patch.displayName = displayName.trim();
        await client.updateAgent(selected, patch);
        await reload();
        onChange();
        fill(roster.agents.find((x) => x.id === selected));
      }
    } catch (err) {
      problem = reason(err);
    } finally {
      busy = false;
    }
  }

  async function retire(): Promise<void> {
    if (!confirmRetire) {
      confirmRetire = true;
      return;
    }
    busy = true;
    problem = "";
    try {
      await client.retireAgent(selected);
      await reload();
      onChange();
      pick(NEW);
    } catch (err) {
      problem = reason(err);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void reload().then(() => pick(roster.agents[0]?.id ?? NEW));
  });
</script>

<section class="agents" aria-labelledby="agents-title">
  <h1 id="agents-title" class="view-title">agents</h1>

  <div class="grid">
    <nav class="picker sticker" aria-label="Agents">
      {#each roster.agents as e (e.id)}
        <button class="pick" type="button" aria-pressed={e.id === selected} onclick={() => pick(e.id)}>
          <span class="swatch" style:--who={tapeVar(e)} aria-hidden="true"></span>
          <span class="pick-name">{nameOf(e.id)}</span>
          <span class="pick-meta" title={e.reason}>{!e.available ? "unavailable" : e.enabled ? e.runtime : "off"}</span>
        </button>
      {/each}
      <button class="pick pick--new" type="button" aria-pressed={adding} onclick={() => pick(NEW)}>
        <span class="plus" aria-hidden="true">+</span>
        <span class="pick-name">Add an agent</span>
      </button>
    </nav>

    <form class="sticker editor" onsubmit={save}>
      <h2 class="tape" style:--who={adding ? tapeVar({ tape }) : whoColor(selected)}>
        {adding ? "New agent" : nameOf(selected)}
      </h2>

      {#if problem}
        <p class="error" role="alert">{problem}</p>
      {/if}

      <div class="fields">
        <label>
          <span>Id</span>
          <input
            class="field"
            bind:value={id}
            disabled={!adding}
            required
            maxlength="24"
            autocomplete="off"
            spellcheck="false"
            aria-describedby="id-hint"
          />
          <small id="id-hint" class="hint" class:over={idHint !== ""}>
            {adding ? (idHint || "The id never changes. A retired id stays taken.") : "The id never changes."}
          </small>
        </label>

        <label>
          <span>Display name</span>
          <input
            class="field"
            bind:value={displayName}
            maxlength="32"
            placeholder={capitalize(id || "name")}
          />
        </label>

        <label>
          <span>Runtime</span>
          <select class="field" bind:value={runtime} onchange={() => void changeRuntime()}>
            {#each roster.runtimes as r (r.id)}<option value={r.id}>{r.label}</option>{/each}
            {#if !roster.runtimes.some((r) => r.id === runtime)}<option value={runtime}>{runtime} (missing)</option>{/if}
          </select>
          {#if entry && !entry.available && entry.runtime === runtime}
            <small class="hint over" role="status">{entry.reason}</small>
          {/if}
        </label>

        <label>
          <span>Model</span>
          <select class="field" value={modelSelect} onchange={onModelSelect}>
            <option value="">Runtime default</option>
            {#each choices.models as m (m)}<option value={m}>{m}</option>{/each}
            <option value={CUSTOM}>Custom…</option>
          </select>
        </label>
        {#if modelSelect === CUSTOM}
          <label>
            <span>Custom model</span>
            <input class="field" bind:value={model} onchange={() => void loadChoices()} placeholder="Model name" autocomplete="off" />
          </label>
        {/if}
        <button class="btn btn--soft refresh" type="button" disabled={busy} onclick={() => void refresh()}>Refresh</button>
        <small class="hint">Refresh reads the model lists of Claude Code and Codex again.</small>

        {#if choices.efforts.length > 0}
          <label>
            <span>Effort</span>
            <select class="field" bind:value={effort}>
              <option value="">Runtime default</option>
              {#each choices.efforts as level (level)}<option value={level}>{level}</option>{/each}
            </select>
          </label>
        {/if}

        <label>
          <span>Tool mode</span>
          <select class="field" bind:value={toolMode} disabled={!supportsModes} aria-describedby="mode-help">
            {#each modes as m (m)}<option value={m}>{MODE_LABELS[m]}</option>{/each}
          </select>
          <small id="mode-help" class="hint">{supportsModes ? MODE_HELP[toolMode] : NO_MODES_NOTE}</small>
        </label>

        <label>
          <span>Label color</span>
          <span class="tape-row">
            <span class="swatch" style:--who={tapeVar({ tape })} aria-hidden="true"></span>
            <select class="field" bind:value={tape}>
              {#each TAPE_SLOTS as slot (slot)}<option value={slot}>Label {slot}</option>{/each}
            </select>
          </span>
        </label>

        {#if runtime === "stub"}
          <label class="wide">
            <span>Reply</span>
            <input class="field" bind:value={reply} placeholder="Empty: the agent stays silent" maxlength="8000" />
          </label>
        {/if}
      </div>

      <div class="row">
        <button class="switch" type="button" aria-pressed={enabled} onclick={() => (enabled = !enabled)}>
          Enabled
        </button>
        <span class="spacer"></span>
        {#if !adding}
          <button class="btn btn--soft" type="button" disabled={busy} onclick={() => void retire()}>
            {confirmRetire ? "Confirm retire" : "Retire"}
          </button>
        {/if}
        <button class="btn" type="submit" disabled={busy || (adding && !idOk)}>
          {busy ? "Saving" : adding ? "Add" : "Save"}
        </button>
      </div>
      {#if !adding}
        <p class="hint">
          A change applies from the next turn. Retire stops the agent's turns and closes its token. Old messages stay.
        </p>
      {/if}
    </form>
  </div>
</section>

<style>
  .agents { max-width: 1080px; margin: 0 auto; padding: 0 16px 24px; }
  .grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 20px; align-items: start; }
  .picker { display: grid; gap: 6px; padding: 16px 12px 12px; }
  .pick {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    background: var(--card);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: var(--r);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .pick[aria-pressed="true"] { background: var(--pink-soft); border-color: var(--pink); }
  .pick-name { flex: 1; font-weight: 600; overflow-wrap: anywhere; }
  .pick-meta { color: var(--muted); font-size: .75rem; }
  .plus { width: 18px; text-align: center; color: var(--pink-deep); font-weight: 600; }
  .swatch {
    flex: none;
    width: 18px;
    height: 18px;
    background: var(--who);
    border: 1px solid var(--line);
    border-radius: var(--r-sm);
  }
  .editor { display: grid; gap: 12px; padding-bottom: 18px; }
  .fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; }
  label { display: grid; gap: 4px; font-weight: 600; align-content: start; }
  label > span:first-child { font-size: .85rem; }
  .wide { grid-column: 1 / -1; }
  .tape-row { display: flex; align-items: center; gap: 8px; }
  .tape-row .field { flex: 1; }
  .hint { margin: 0; color: var(--muted); font-size: .8rem; font-weight: 400; }
  .hint.over { color: var(--pink-deep); }
  .refresh { justify-self: start; }
  .row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
  .spacer { flex: 1; }
  @media (max-width: 799px) {
    .grid { grid-template-columns: minmax(0, 1fr); }
    .fields { grid-template-columns: minmax(0, 1fr); }
  }
</style>
