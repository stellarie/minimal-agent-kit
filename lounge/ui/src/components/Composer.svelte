<script lang="ts">
  import { tick } from "svelte";
  import { MAX_ATTACHMENT, MAX_PER_MESSAGE, MAX_TEXT, type Attachment } from "../lib/api.ts";
  import { filter, insert, trigger, type Item, type TriggerKind } from "../lib/complete.ts";
  import { formatSize } from "../lib/embeds.ts";
  import Initial from "./Initial.svelte";

  // mentions: after an @. channels: after a #.
  let {
    disabled,
    channel,
    mentions = [],
    channels = [],
    onSend,
    onUpload,
  }: {
    disabled: boolean;
    channel: string;
    mentions?: Item[];
    channels?: Item[];
    onSend: (text: string, files: Attachment[]) => Promise<void>;
    onUpload: (file: File) => Promise<Attachment>;
  } = $props();

  let text = $state("");
  let sending = $state(false);
  let error = $state("");
  let files = $state<Attachment[]>([]);
  let uploading = $state(0);
  let picker = $state<HTMLInputElement>();
  let dragging = $state(false);
  let box = $state<HTMLTextAreaElement>();
  let caret = $state(0);
  let active = $state(0);
  // Escape closes the list until the trigger changes.
  let dismissed = $state(false);

  const found = $derived(trigger(text, caret));
  // One item list per trigger character.
  const lists = $derived<Record<TriggerKind, Item[]>>({
    "@": mentions,
    "#": channels,
  });
  const items = $derived(found ? filter(lists[found.kind], found.query) : []);
  const open = $derived(items.length > 0 && !dismissed);
  const kindKey = $derived(found ? `${found.kind}${found.start}` : "");

  $effect(() => {
    kindKey;
    dismissed = false;
  });

  $effect(() => {
    found?.query;
    active = 0;
  });

  function sync() {
    caret = box?.selectionStart ?? text.length;
  }

  async function choose(item: Item) {
    if (!found) return;
    const next = insert(text, caret, found.start, item.value);
    text = next.text;
    caret = next.caret;
    await tick();
    box?.focus();
    box?.setSelectionRange(next.caret, next.caret);
  }

  const tooLong = $derived(text.length > MAX_TEXT);
  const blank = $derived(text.trim().length === 0 && files.length === 0);

  async function add(list: Iterable<File>) {
    error = "";
    for (const file of list) {
      if (files.length + uploading >= MAX_PER_MESSAGE) {
        error = `A message has at most ${MAX_PER_MESSAGE} files.`;
        return;
      }
      if (file.size > MAX_ATTACHMENT) {
        error = `${file.name} is ${formatSize(file.size)}. The limit is ${formatSize(MAX_ATTACHMENT)}.`;
        continue;
      }
      uploading += 1;
      try {
        files = [...files, await onUpload(file)];
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        uploading -= 1;
      }
    }
  }

  function onPaste(e: ClipboardEvent) {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (pasted.length === 0) return;
    e.preventDefault();
    void add(pasted);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    void add([...(e.dataTransfer?.files ?? [])]);
  }

  async function submit(e?: SubmitEvent) {
    e?.preventDefault();
    if (disabled || sending || blank || tooLong || uploading > 0) return;
    sending = true;
    error = "";
    try {
      await onSend(text, files);
      text = "";
      files = [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (open && !e.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // The list takes Enter, so a half-written message is not sent.
        e.preventDefault();
        void choose(items[active] ?? items[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        dismissed = true;
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  }
</script>

<form
  class="composer"
  class:dragging
  onsubmit={submit}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={onDrop}
>
  <label for="composer" class="sr-only">Message #{channel}</label>
  {#if files.length > 0 || uploading > 0}
    <ul class="chips" aria-label="Files to send">
      {#each files as f (f.id)}
        <li class="chip">
          <span class="chip-name">{f.name}</span>
          <span class="chip-size">{formatSize(f.size)}</span>
          <button type="button" class="x" onclick={() => (files = files.filter((x) => x.id !== f.id))}>
            <span aria-hidden="true">×</span><span class="sr-only">Remove {f.name}</span>
          </button>
        </li>
      {/each}
      {#if uploading > 0}<li class="chip busy">Uploading {uploading}…</li>{/if}
    </ul>
  {/if}
  <div class="row">
    <button class="btn btn--soft attach" type="button" {disabled} onclick={() => picker?.click()} title="Attach files">
      <span aria-hidden="true">+</span><span class="sr-only">Attach files</span>
    </button>
    <input
      class="sr-only"
      type="file"
      multiple
      tabindex="-1"
      bind:this={picker}
      onchange={(e) => {
        const input = e.currentTarget;
        void add([...(input.files ?? [])]).then(() => (input.value = ""));
      }}
    />
    <div class="box">
      {#if open && found}
        <ul class="suggest" id="composer-list" role="listbox" aria-label={found.kind === "@" ? "Agents" : "Channels"}>
          {#each items as item, i (item.value)}
            <li
              id="composer-option-{i}"
              role="option"
              aria-selected={i === active}
              class:on={i === active}
              onmousedown={(e) => {
                // Keep the focus in the text box.
                e.preventDefault();
                void choose(item);
              }}
            >
              {#if found.kind === "@"}<Initial caller={item.value.slice(1)} size={24} />{/if}
              <span class="who">{item.label}</span>
              <code class="val">{item.value}</code>
              {#if item.detail}<span class="detail">{item.detail}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
      <textarea
        id="composer"
        class="field"
        rows="1"
        placeholder="Message #{channel}"
        bind:value={text}
        bind:this={box}
        onkeydown={onKeydown}
        oninput={sync}
        onkeyup={sync}
        onclick={sync}
        onfocus={sync}
        onpaste={onPaste}
        role="combobox"
        aria-expanded={open}
        aria-controls="composer-list"
        aria-autocomplete="list"
        aria-activedescendant={open ? `composer-option-${active}` : undefined}
        aria-describedby="composer-hint{error ? ' composer-error' : ''}"
        aria-invalid={tooLong}
        {disabled}
      ></textarea>
    </div>
    <button class="btn" type="submit" disabled={disabled || sending || blank || tooLong || uploading > 0}>
      {sending ? "Sending" : "Send"}
    </button>
  </div>
  <p id="composer-hint" class="hint">
    Enter sends. Shift+Enter adds a line. Paste or drop files to attach. Type @ for an agent and # for a channel.
    {#if text.length > MAX_TEXT - 400}
      <span class:over={tooLong}>{text.length} / {MAX_TEXT}</span>
    {/if}
  </p>
  {#if error}
    <p id="composer-error" class="error" role="alert">{error}</p>
  {/if}
</form>

<style>
  .composer {
    padding: 8px 16px 6px;
    border-radius: var(--r-lg);
  }
  .composer.dragging { outline: 3px dashed var(--pink); outline-offset: -4px; }
  /* One height for the row; the + sits centered. */
  .attach {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    font-size: 1.3rem;
    line-height: 1;
  }
  .row > .btn[type="submit"] { flex: none; height: 44px; padding: 0 18px; }
  .chips { list-style: none; margin: 0 0 6px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 2px 10px;
    background: var(--pink-soft);
    border-radius: var(--r);
    font-size: .8rem;
  }
  .chip.busy { padding-right: 10px; color: var(--muted); }
  .chip-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
  .chip-size { color: var(--muted); }
  .x {
    width: 20px;
    height: 20px;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .x:hover { background: var(--card); color: var(--pink-deep); }
  .row {
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .box { position: relative; flex: 1; min-width: 0; display: flex; }
  .box textarea { flex: 1; min-width: 0; }
  .suggest {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 5;
    margin: 0;
    padding: 4px;
    list-style: none;
    max-height: 40vh;
    overflow-y: auto;
    background: var(--card);
    border: 2px solid var(--line);
    border-radius: var(--r);
    box-shadow: 0 4px 0 var(--line);
  }
  .suggest li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .suggest li.on { background: var(--pink-soft); }
  .who { font-weight: 700; }
  .val { color: var(--muted); font-size: .8rem; }
  .detail { margin-left: auto; color: var(--muted); font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
  textarea {
    resize: none;
    min-height: 44px;
    padding-block: 8px;
    max-height: 40vh;
    /* Grows with the text; old engines keep one row. */
    field-sizing: content;
  }
  .hint {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: .8rem;
  }
  .over { color: var(--pink-deep); font-weight: 700; }
  .error { margin: 6px 0 0; }
</style>
