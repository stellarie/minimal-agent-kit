<script lang="ts">
  import { onMount } from "svelte";
  import type { Approval } from "../lib/api.ts";
  import { DANGER_WORD, isDanger } from "../lib/approvalToasts.ts";
  import { minutesLeft } from "../lib/guard.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { whoColor } from "../lib/roster.svelte.ts";

  let {
    approval,
    now,
    busy,
    error,
    onDecide,
    onClose,
  }: {
    approval: Approval;
    now: number;
    busy: boolean;
    error: string | undefined;
    onDecide: (allow: boolean) => void;
    onClose: () => void;
  } = $props();

  let dialog = $state<HTMLDialogElement>();

  onMount(() => {
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  });

  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) onClose();
  }

  // The app window must not see this Escape.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="details"
  class:danger={isDanger(approval)}
  style:--who={whoColor(approval.agent)}
  aria-labelledby="apd-title"
  onkeydown={onKeydown}
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
  onclick={onBackdrop}
>
  <div class="box">
    <header class="head">
      <h2 id="apd-title">
        {nameOf(approval.agent)} needs approval{#if isDanger(approval)}
          <span class="flag">{DANGER_WORD}</span>{/if}
      </h2>
      <button class="icon-btn" type="button" onclick={onClose}
        ><span aria-hidden="true">✕</span><span class="sr-only">Close</span></button
      >
    </header>
    <p class="line">
      <span class="chip">{approval.tool}</span>
      <span class="left">times out in {minutesLeft(approval.expiresAt, now)} min</span>
    </p>
    {#if isDanger(approval)}
      <p class="warn" role="note">This call is blocked by the guard. Allow runs it once.</p>
    {/if}
    <p class="reason">{approval.reason}</p>
    {#if approval.cwd}
      <p class="cwd"><span class="section-title">Folder</span> <code>{approval.cwd}</code></p>
    {/if}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <pre class="cmd" tabindex="0" aria-label="Command">{approval.summary}</pre>
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
    <div class="foot">
      <button class="btn btn--soft" type="button" disabled={busy} onclick={() => onDecide(false)}>Deny</button>
      <button class="btn" type="button" disabled={busy} onclick={() => onDecide(true)}>Allow</button>
    </div>
  </div>
</dialog>

<style>
  .details {
    width: min(760px, 94vw);
    max-height: 88dvh;
    padding: 0;
    border: 2px solid var(--line);
    border-top: 8px solid var(--who, var(--tape-1));
    border-radius: var(--r-lg);
    background: var(--card);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  .details.danger {
    background: var(--danger-soft);
    border-color: var(--danger);
    border-top-color: var(--danger);
  }
  .details.danger .head { border-bottom-color: var(--danger); }
  .flag {
    margin-left: 6px;
    padding: 0 8px;
    background: var(--danger);
    border-radius: var(--r-sm);
    color: var(--on-danger);
    font-size: .75rem;
    font-weight: 800;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .warn { margin: 0 14px; color: var(--danger); font-weight: 700; }
  .details::backdrop { background: color-mix(in srgb, var(--ink) 55%, transparent); }
  .box { display: flex; flex-direction: column; gap: 10px; max-height: calc(88dvh - 12px); padding: 0 0 14px; }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 2px solid var(--line);
  }
  h2 { flex: 1; margin: 0; font-size: 1rem; overflow-wrap: anywhere; }
  .line, .reason, .cwd, .error { margin: 0 14px; }
  .line { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; }
  .left { color: var(--muted); font-size: .8rem; }
  .reason { font-weight: 700; overflow-wrap: anywhere; }
  .cwd { font-size: .85rem; overflow-wrap: anywhere; }
  code, .cmd { font-family: var(--font-mono); }
  .cmd {
    flex: 1 1 auto;
    min-height: 80px;
    margin: 0 14px;
    padding: 8px 10px;
    overflow: auto;
    background: var(--bg);
    border: 2px solid var(--line);
    border-radius: var(--r);
    font-size: .8rem;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 0 14px; }
</style>
