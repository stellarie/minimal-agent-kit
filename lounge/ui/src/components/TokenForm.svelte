<script lang="ts">
  import { OWNER_TAPE } from "../lib/roster.ts";

  let { problem, onSave }: { problem: string; onSave: (token: string) => void } = $props();

  let value = $state("");

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const token = value.trim();
    if (token) onSave(token);
  }
</script>

<form class="sticker token" onsubmit={submit}>
  <h2 class="tape" style:--who={OWNER_TAPE}>Sign in</h2>
  <label for="token">Owner token</label>
  <p id="token-hint" class="hint">
    Copy the <code>owner</code> value from <code>~/.agent-lounge/tokens.json</code>.
    The page keeps it in this tab only.
  </p>
  {#if problem}
    <p class="error" role="alert">{problem}</p>
  {/if}
  <div class="row">
    <input
      id="token"
      class="field"
      type="password"
      autocomplete="off"
      spellcheck="false"
      aria-describedby="token-hint"
      bind:value
    />
    <button class="btn" type="submit" disabled={!value.trim()}>Save</button>
  </div>
</form>

<style>
  .token {
    max-width: 560px;
    margin: 28px auto;
  }
  .tape {
    font-family: var(--font);
    font-size: .95rem;
    line-height: 1.6;
  }
  label { font-weight: 600; }
  .hint { margin: 2px 0 10px; color: var(--muted); font-size: .9rem; }
  .error { margin: 0 0 10px; }
  .row { display: flex; gap: 10px; }
  code {
    padding: 0 4px;
    background: var(--pink-soft);
    border-radius: var(--r-sm);
    font-size: .9em;
  }
</style>
