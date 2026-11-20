<script lang="ts">
  import { ApiError, type Approval } from "../lib/api.ts";
  import { changeReady, isDanger, isGate, toastBottom, toastLine, toastSpan, visibleToasts } from "../lib/approvalToasts.ts";
  import { minutesLeft } from "../lib/guard.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { whoColor } from "../lib/roster.svelte.ts";
  import ApprovalDetails from "./ApprovalDetails.svelte";

  let {
    approvals,
    now,
    onDecide,
    onGate,
  }: {
    approvals: Approval[];
    now: number;
    onDecide: (id: string, allow: boolean) => Promise<void>;
    onGate: (id: string, decision: "approve" | "change", note: string) => Promise<void>;
  } = $props();

  // A key holds the draft note of a gate card that asks for a change.
  let notes = $state<Record<string, string>>({});
  let busy = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});
  let detailsId = $state<string | null>(null);
  let bottom = $state(12);
  let span = $state<{ center: number; width: number } | null>(null);

  const toasts = $derived(visibleToasts(approvals));
  // A decided or expired approval closes its modal.
  const details = $derived(approvals.find((a) => a.id === detailsId));

  // The toasts follow the composer, or sit low without one.
  function measure(): void {
    const el = document.querySelector("form.composer");
    const rect = el ? el.getBoundingClientRect() : null;
    bottom = toastBottom(rect, window.innerHeight);
    span = toastSpan(rect, { width: window.innerWidth, height: window.innerHeight });
  }

  $effect(() => {
    if (approvals.length === 0) return;
    // The clock tick re-runs this when the composer mounts late.
    void now;
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(document.body);
    const el = document.querySelector("form.composer");
    if (el) watcher.observe(el);
    return () => watcher.disconnect();
  });

  // Deny takes focus unless a field or toast has it.
  function focusDeny(node: HTMLButtonElement) {
    const active = document.activeElement;
    const held =
      active?.closest(".stack, dialog") != null ||
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      (active instanceof HTMLElement && active.isContentEditable);
    if (!held) node.focus();
  }

  async function decide(id: string, allow: boolean): Promise<void> {
    await settle(id, () => onDecide(id, allow));
  }

  async function decideGate(id: string, decision: "approve" | "change"): Promise<void> {
    await settle(id, () => onGate(id, decision, notes[id] ?? ""));
  }

  async function settle(id: string, send: () => Promise<void>): Promise<void> {
    busy[id] = true;
    delete errors[id];
    try {
      await send();
    } catch (err) {
      errors[id] = err instanceof ApiError ? err.message : "Cannot reach the core.";
    } finally {
      delete busy[id];
    }
  }
</script>

{#if approvals.length > 0}
  <section
    class="stack"
    style:bottom="{bottom}px"
    style:left={span ? `${span.center}px` : undefined}
    style:width={span ? `${span.width}px` : undefined}
    aria-label="Pending approvals"
    aria-live="assertive"
  >
    {#each toasts.shown as a (a.id)}
      <article class="toast" class:danger={isDanger(a)} style:--who={whoColor(a.agent)} aria-labelledby="ap-{a.id}">
        <div class="bar">
          <p class="text" id="ap-{a.id}" title={a.reason}>{toastLine(a, nameOf(a.agent))}</p>
          {#if isGate(a)}
            <button class="btn btn--soft" type="button" disabled={busy[a.id]} onclick={() => (notes[a.id] ??= "")}>
              Change
            </button>
            <button class="btn" type="button" disabled={busy[a.id]} onclick={() => void decideGate(a.id, "approve")}>
              Approve
            </button>
          {:else}
            <span class="left">times out in {minutesLeft(a.expiresAt, now)} min</span>
            <button
              class="link"
              type="button"
              aria-haspopup="dialog"
              onclick={() => (detailsId = a.id)}
            >
              Details
            </button>
            <button
              class="btn btn--soft"
              type="button"
              disabled={busy[a.id]}
              use:focusDeny
              onclick={() => void decide(a.id, false)}
            >
              Deny
            </button>
            <button class="btn" type="button" disabled={busy[a.id]} onclick={() => void decide(a.id, true)}>
              Allow
            </button>
          {/if}
        </div>
        {#if isGate(a) && notes[a.id] !== undefined}
          <form
            class="note"
            onsubmit={(e) => {
              e.preventDefault();
              void decideGate(a.id, "change");
            }}
          >
            <input class="field" aria-label="What should change?" placeholder="What should change?" bind:value={notes[a.id]} />
            <button class="btn" type="submit" disabled={busy[a.id] || !changeReady(notes[a.id] ?? "")}>Send change</button>
          </form>
        {/if}
        {#if errors[a.id]}
          <p class="error" role="alert">{errors[a.id]}</p>
        {/if}
      </article>
    {/each}
    {#if toasts.more > 0}
      <p class="more">{toasts.more} more waiting</p>
    {/if}
  </section>
{/if}

{#if details}
  <ApprovalDetails
    approval={details}
    {now}
    busy={busy[details.id] === true}
    error={errors[details.id]}
    onDecide={(allow) => void decide(details.id, allow)}
    onClose={() => (detailsId = null)}
  />
{/if}

<style>
  .stack {
    position: fixed;
    left: 50%;
    z-index: 40;
    display: grid;
    gap: 8px;
    width: min(640px, calc(100vw - 16px));
    max-height: calc(100dvh - 24px);
    overflow-y: auto;
    transform: translateX(-50%);
    scrollbar-color: var(--line) transparent;
    container-type: inline-size;
  }
  .toast {
    min-width: 0;
    padding: 8px 12px;
    background: var(--card);
    border: 2px solid var(--line);
    border-left: 8px solid var(--who, var(--tape-1));
    border-radius: var(--r);
    box-shadow: var(--shadow);
  }
  .toast.danger {
    background: var(--danger-soft);
    border-color: var(--danger);
    border-left-color: var(--danger);
  }
  .bar { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
  .text {
    flex: 1 1 200px;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .left { color: var(--muted); font-size: .8rem; white-space: nowrap; }
  /* A narrow chat column gets the text on its own row. */
  @container (max-width: 560px) {
    .text { flex-basis: 100%; }
    .left { margin-right: auto; }
  }
  .link {
    padding: 2px 4px;
    background: none;
    border: 0;
    color: var(--pink-deep);
    font-size: .85rem;
    font-weight: 700;
    text-decoration: underline;
    cursor: pointer;
  }
  .toast :global(.btn) { padding: 2px 14px; }
  .note { display: flex; gap: 8px; margin-top: 6px; }
  .note .field { flex: 1 1 auto; min-width: 0; }
  .more {
    justify-self: center;
    margin: 0;
    padding: 2px 12px;
    background: var(--card);
    border: 2px solid var(--line);
    border-radius: var(--r);
    color: var(--muted);
    font-size: .8rem;
    font-weight: 700;
  }
</style>
