<script lang="ts">
  import type { Message } from "../lib/api.ts";
  import { formatTime, localTimes, quoteExcerpt } from "../lib/format.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import Initial from "./Initial.svelte";
  import Embeds from "./Embeds.svelte";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { copyMessage, copyText } from "../lib/clipboard.ts";
  import { onDestroy } from "svelte";

  let {
    message,
    now,
    grouped,
    quoted,
  }: {
    message: Message;
    now: number;
    grouped: boolean;
    quoted?: Message;
  } = $props();

  const name = $derived(nameOf(message.author));

  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  onDestroy(() => clearTimeout(copyTimer));

  // The word shows for a moment, then the button goes quiet again.
  async function copy(): Promise<void> {
    const text = copyText(message, { name, time: formatTime(message.createdAt, now) });
    copied = await copyMessage(navigator.clipboard, text);
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = false), 1500);
  }

  // The original may sit above the loaded page.
  function jump(): void {
    if (message.replyTo === undefined) return;
    const target = document.getElementById(`msg-${message.replyTo}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("flash");
    void target.offsetWidth;
    target.classList.add("flash");
  }
</script>

{#if message.kind === "tool"}
  <div class="tool" role="note">
    <span class="gear" aria-hidden="true">⚙</span>
    <strong>{name}</strong>
    <code>{message.text}</code>
    <time datetime={message.createdAt}>{formatTime(message.createdAt, now)}</time>
  </div>
{:else if message.kind === "event"}
  <div class="event" role="note">
    <span class="dot" aria-hidden="true">•</span>
    <span>
      <strong>{name}</strong> {localTimes(message.text)}
    </span>
    <time datetime={message.createdAt}>{formatTime(message.createdAt, now)}</time>
  </div>
{:else if grouped}
  <article id="msg-{message.id}" class="row row--more" aria-label="{name}, {formatTime(message.createdAt, now)}">
    <time class="side-time" datetime={message.createdAt}>{formatTime(message.createdAt, now)}</time>
    <div>
      {#if message.text}<div class="text">{@html renderMarkdown(message.text)}</div>{/if}
      <Embeds attachments={message.attachments} />
      {@render copyBtn()}
    </div>
  </article>
{:else}
  <article id="msg-{message.id}" class="row" aria-labelledby="msg-{message.id}-who">
    {#if message.replyTo !== undefined}
      <button
        class="quote"
        type="button"
        onclick={jump}
        disabled={!quoted}
        title={quoted ? "Jump to the original message" : "The original message is not loaded"}
      >
        <span class="hook" aria-hidden="true"></span>
        {#if quoted}
          <strong class="quote-who">{nameOf(quoted.author)}</strong>
          <span class="quote-text">{quoteExcerpt(quoted.text) || "(files)"}</span>
        {:else}
          <span class="quote-text">Original message not loaded</span>
        {/if}
      </button>
    {/if}
    <span class="slot"><Initial caller={message.author} /></span>
    <div class="body">
      <h3 class="head">
        <span class="who" id="msg-{message.id}-who" title={message.author}>{name}</span>
        <time class="time" datetime={message.createdAt}>{formatTime(message.createdAt, now)}</time>
        {@render copyBtn()}
      </h3>
      {#if message.text}<div class="text">{@html renderMarkdown(message.text)}</div>{/if}
      <Embeds attachments={message.attachments} />
    </div>
  </article>
{/if}

{#snippet copyBtn()}
  <button
    class="copy"
    type="button"
    onclick={copy}
    aria-label="Copy the text of this message"
    title={copied ? "Copied to the clipboard" : "Copy the text of this message"}
  >
    {copied ? "copied" : "copy"}
  </button>
{/snippet}

<style>
  .row {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    column-gap: 14px;
    margin-top: 22px;
    padding: 2px 16px;
    border-radius: var(--r-lg);
    animation: pop .2s ease-out;
  }
  .row--more { margin-top: 6px; }
  .row:global(.flash) { animation: flash 1.2s ease-out; }
  .quote {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin: 0 0 2px 20px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: .8rem;
    text-align: left;
    cursor: pointer;
  }
  .quote:disabled { cursor: default; }
  .quote:not(:disabled):hover .quote-text { color: var(--ink); }
  .quote:focus-visible { outline: 2px solid var(--pink-deep); outline-offset: 2px; }
  .hook {
    flex: none;
    width: 30px;
    height: 10px;
    margin-top: 8px;
    border-top: 1px solid var(--line);
    border-left: 1px solid var(--line);
    border-top-left-radius: 6px;
  }
  .quote-who { flex: none; color: var(--pink-deep); font-weight: 600; }
  .quote-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row:hover { background: var(--pink-soft); }
  .slot {
    display: flex;
    margin-top: 2px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0;
    font-family: var(--font);
    font-size: .95rem;
  }
  .who { font-weight: 600; }
  .time, .side-time { color: var(--muted); font-size: .75rem; font-weight: 400; }
  .copy {
    padding: 0 6px;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: .7rem;
    font-weight: 600;
    cursor: pointer;
    opacity: 0;
  }
  .row:hover .copy, .row:focus-within .copy, .copy:focus-visible { opacity: 1; }
  .copy:hover { color: var(--pink-deep); }
  .side-time {
    align-self: center;
    text-align: right;
    visibility: hidden;
  }
  .row--more:hover .side-time { visibility: visible; }
  .text {
    margin: 0;
    font-size: .9rem;
    line-height: 1.55;
    overflow-wrap: anywhere;
  }
  .text :global(p) { margin: 0; }
  .text :global(p + p), .text :global(ul), .text :global(ol), .text :global(pre), .text :global(blockquote) {
    margin: 6px 0 0;
  }
  .text :global(ul), .text :global(ol) { padding-left: 22px; }
  .text :global(h1), .text :global(h2), .text :global(h3), .text :global(h4) {
    margin: 8px 0 2px;
    font-size: 1rem;
    font-weight: 600;
  }
  .text :global(code) {
    padding: 1px 5px;
    border-radius: var(--r-sm);
    background: var(--pink-soft);
    font-family: var(--font-mono);
    font-size: .85em;
  }
  .text :global(pre) {
    padding: 8px 12px;
    border-radius: var(--r);
    background: var(--bg);
    border: 1px solid var(--line);
    overflow-x: auto;
  }
  .text :global(pre code) { padding: 0; background: none; }
  .text :global(blockquote) {
    padding-left: 10px;
    border-left: 3px solid var(--pink);
    color: var(--muted);
  }
  .text :global(a) { color: var(--pink-deep); }
  .text :global(table) { border-collapse: collapse; margin-top: 6px; }
  .text :global(th), .text :global(td) { padding: 3px 8px; border: 1px solid var(--line); }
  .event {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-top: 14px;
    padding: 2px 16px 2px 28px;
    color: var(--muted);
    font-size: .9rem;
  }
  .event .dot { color: var(--pink); }
  .tool {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 16px 0 30px;
    color: var(--muted);
    font-size: .8rem;
  }
  .tool strong { font-weight: 600; color: var(--ink); }
  .tool code {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  .gear { color: var(--pink-deep); }
  .tool time { font-size: .7rem; }
  .event time { font-size: .75rem; }
  @keyframes flash {
    from { background: var(--pink-soft); }
    to { background: transparent; }
  }
  @keyframes pop {
    from { transform: translateY(4px); }
    to { transform: none; }
  }
</style>
