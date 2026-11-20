<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, type LoungeClient, type SkillList } from "../lib/api.ts";
  import { SKILL_NAME_HINT, skillState } from "../lib/skills.ts";

  let { client }: { client: LoungeClient } = $props();

  // "" is the new skill form.
  const NEW = "";

  let list = $state<SkillList | null>(null);
  let selected = $state(NEW);
  let name = $state("");
  let description = $state("");
  let body = $state("");
  let text = $state("");
  let saved = $state("");
  let problem = $state("");
  let busy = $state(false);
  let confirmRemove = $state(false);
  let done = $state("");

  const adding = $derived(selected === NEW);
  const form = $derived(
    adding ? skillState({ mode: "new", name, description, body }) : skillState({ mode: "edit", text, saved }),
  );

  function reason(err: unknown): string {
    return err instanceof ApiError ? err.message : "Cannot reach the core.";
  }

  async function reload(): Promise<void> {
    try {
      list = await client.skills();
    } catch (err) {
      problem = reason(err);
    }
  }

  async function pick(next: string): Promise<void> {
    selected = next;
    problem = "";
    done = "";
    confirmRemove = false;
    if (next === NEW) {
      name = "";
      description = "";
      body = "";
      return;
    }
    try {
      const skill = await client.skill(next);
      text = skill.text;
      saved = skill.text;
    } catch (err) {
      problem = reason(err);
    }
  }

  async function save(): Promise<void> {
    busy = true;
    problem = "";
    done = "";
    try {
      if (adding) {
        const made = await client.createSkill({ name, description, body });
        await reload();
        await pick(made.name);
        done = "Created.";
      } else {
        const skill = await client.saveSkill(selected, text);
        saved = skill.text;
        text = skill.text;
        await reload();
        done = "Saved.";
      }
    } catch (err) {
      // The text stays, so a failed save loses nothing.
      problem = reason(err);
    } finally {
      busy = false;
    }
  }

  async function remove(): Promise<void> {
    busy = true;
    problem = "";
    try {
      await client.removeSkill(selected);
      await reload();
      await pick(NEW);
      done = "Removed. The folder moved to .removed.";
    } catch (err) {
      problem = reason(err);
    } finally {
      busy = false;
      confirmRemove = false;
    }
  }

  onMount(() => {
    void reload();
  });
</script>

<section class="skills" aria-labelledby="skills-title">
  <h1 id="skills-title" class="view-title">skills</h1>
  <div class="sticker box">
    <p class="hint">
      Lounge skills belong to the lounge only. Agents here never see the skills of Claude Code or Codex on this PC.
      Each turn lists the name and description of each skill. An agent loads a body with the lounge_skill tool, and
      a $name in your post attaches that body to the turn.
    </p>
    {#if list}
      <p class="hint">Folder: <code>{list.folder}</code></p>
    {/if}
    {#if problem}
      <p class="error" role="alert">{problem}</p>
    {/if}
    <div class="cols">
      <nav class="names" aria-label="Skills">
        <button class="item" type="button" aria-current={adding} onclick={() => void pick(NEW)}>+ New skill</button>
        {#if list}
          {#each list.skills as s (s.name)}
            <button class="item" type="button" aria-current={selected === s.name} onclick={() => void pick(s.name)}>
              <span class="n">{s.name}</span>
              <span class="d">{s.description}</span>
            </button>
          {/each}
          {#if list.skills.length === 0}
            <p class="hint">No skills yet.</p>
          {/if}
        {:else if !problem}
          <p class="hint">Loading…</p>
        {/if}
      </nav>
      <div class="editor">
        {#if adding}
          <h2 class="head">New skill</h2>
          <label for="skill-name">Name</label>
          <input id="skill-name" class="field" spellcheck="false" autocomplete="off" bind:value={name} />
          {#if form.hint}<p class="error">{form.hint}</p>{:else}<p class="hint">{SKILL_NAME_HINT}</p>{/if}
          <label for="skill-description">Description</label>
          <input id="skill-description" class="field" autocomplete="off" bind:value={description} />
          <label for="skill-body">Body</label>
          <textarea id="skill-body" class="field text" spellcheck="false" bind:value={body}></textarea>
        {:else}
          <h2 class="head">{selected}</h2>
          <label for="skill-text">SKILL.md</label>
          <textarea id="skill-text" class="field text" spellcheck="false" bind:value={text}></textarea>
        {/if}
        <div class="row">
          {#if !adding}
            {#if confirmRemove}
              <span class="hint">Move this skill to .removed?</span>
              <button class="btn btn--soft" type="button" disabled={busy} onclick={() => void remove()}>Yes, remove</button>
              <button class="btn btn--soft" type="button" disabled={busy} onclick={() => (confirmRemove = false)}>No</button>
            {:else}
              <button class="btn btn--soft" type="button" disabled={busy} onclick={() => (confirmRemove = true)}>Remove</button>
            {/if}
          {/if}
          <span class="spacer"></span>
          <button class="btn" type="button" disabled={busy || !form.canSave} onclick={() => void save()}>
            {busy ? "Saving" : adding ? "Create" : "Save"}
          </button>
        </div>
        {#if done}<p class="hint" role="status">{done}</p>{/if}
      </div>
    </div>
    {#if list && list.skipped.length > 0}
      <h2 class="head">Skipped folders</h2>
      <ul class="skipped">
        {#each list.skipped as s (s.name)}
          <li><code>{s.name}</code>: {s.reason}</li>
        {/each}
      </ul>
    {/if}
  </div>
</section>

<style>
  .skills { max-width: 1080px; margin: 0 auto; padding: 0 16px 24px; }
  .box { padding: 16px; }
  .hint { margin: 2px 0 10px; color: var(--muted); font-size: .9rem; overflow-wrap: anywhere; }
  .cols { display: grid; grid-template-columns: minmax(180px, 260px) 1fr; gap: 16px; }
  .names { display: grid; align-content: start; gap: 6px; }
  .item {
    display: grid;
    gap: 2px;
    padding: 8px 10px;
    text-align: left;
    background: var(--bg);
    color: var(--ink);
    border: 2px solid var(--line);
    border-radius: var(--r);
    cursor: pointer;
  }
  .item[aria-current="true"] { border-color: var(--pink-deep); background: var(--pink-soft); }
  .n { font-weight: 700; }
  .d { color: var(--muted); font-size: .85rem; overflow-wrap: anywhere; }
  .editor label { display: block; margin-top: 8px; font-weight: 700; }
  .head { margin: 0 0 8px; font-size: 1.05rem; }
  .field { width: 100%; padding: 8px 10px; }
  .text { min-height: 40dvh; resize: vertical; font-family: var(--font-mono); font-size: .9rem; line-height: 1.5; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  .skipped { margin: 0; padding-left: 18px; color: var(--muted); font-size: .9rem; }
  code { font-family: var(--font-mono); font-size: .85rem; }
  @media (max-width: 599px) {
    .cols { grid-template-columns: 1fr; }
  }
</style>
