<script lang="ts">
  import { onMount } from "svelte";
  import { ApiError, type LoungeClient, type RoomFile } from "../lib/api.ts";
  import { attachmentUrl, formatSize } from "../lib/embeds.ts";
  import { renderMarkdown } from "../lib/markdown.ts";
  import { previewKind, readTextPrefix } from "../lib/preview.ts";

  let { file, client, onClose }: { file: RoomFile; client: LoungeClient; onClose: () => void } = $props();

  const kind = $derived(previewKind(file.mime, file.name));
  const src = $derived(attachmentUrl(file));

  let dialog = $state<HTMLDialogElement>();
  let text = $state("");
  let cut = $state(false);
  let pdf = $state("");
  let loading = $state(false);
  let failed = $state(false);
  let revealError = $state("");

  onMount(() => {
    const opener = document.activeElement;
    dialog?.showModal();
    // The dialog leaves the page without a close call.
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  });

  // Text and PDF come from one fetch each; the rest load by src.
  $effect(() => {
    const type = kind;
    const url = src;
    if (type !== "markdown" && type !== "text" && type !== "pdf") return;
    const abort = new AbortController();
    let blobUrl = "";
    loading = true;
    failed = false;
    text = "";
    cut = false;
    pdf = "";
    void (async () => {
      try {
        const res = await fetch(url, { signal: abort.signal });
        if (!res.ok) throw new Error(String(res.status));
        if (type === "pdf") {
          const bytes = await res.arrayBuffer();
          blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          if (abort.signal.aborted) {
            URL.revokeObjectURL(blobUrl);
            return;
          }
          pdf = blobUrl;
        } else if (res.body) {
          const out = await readTextPrefix(res.body);
          text = out.text;
          cut = out.cut;
        } else {
          text = await res.text();
        }
      } catch {
        if (!abort.signal.aborted) failed = true;
      } finally {
        if (!abort.signal.aborted) loading = false;
      }
    })();
    return () => {
      abort.abort();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  });

  async function reveal() {
    revealError = "";
    try {
      await client.reveal(file.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 501) revealError = "Only on Windows";
      else if (err instanceof ApiError && err.status === 404) revealError = "The stored file is gone.";
      else if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        revealError = "The core rejected this token.";
      } else revealError = "Explorer did not open.";
    }
  }

  // A click on the backdrop lands on the dialog itself.
  function onBackdrop(e: MouseEvent) {
    if (e.target === dialog) onClose();
  }

  // The app window must not see this Escape: it would close the drawer.
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
  class="preview"
  aria-labelledby="preview-name"
  onkeydown={onKeydown}
  oncancel={(e) => {
    e.preventDefault();
    onClose();
  }}
  onclick={onBackdrop}
>
  <div class="box">
    <header class="head">
      <div class="who">
        <h2 id="preview-name" class="name">{file.name}</h2>
        <span class="size">{formatSize(file.size)}</span>
      </div>
      <button class="icon-btn" type="button" onclick={reveal} aria-label="Show in Explorer" title="Show in Explorer">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
        </svg>
      </button>
      <a class="icon-btn" href={src} download={file.name} aria-label="Download" title="Download">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" />
        </svg>
      </a>
      <button class="icon-btn" type="button" onclick={onClose} aria-label="Close" title="Close">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </header>
    {#if revealError}
      <p class="error" role="alert">{revealError}</p>
    {/if}
    <div class="body">
      {#if kind === "image"}
        <img class="media" {src} alt={file.name} />
      {:else if kind === "video"}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="media" {src} controls preload="metadata"></video>
      {:else if kind === "audio"}
        <audio {src} controls preload="metadata"></audio>
      {:else if kind === "none"}
        <div class="card">
          <span class="card-icon" aria-hidden="true">📦</span>
          <strong class="card-name">{file.name}</strong>
          <span class="card-meta">{file.mime} · {formatSize(file.size)}</span>
          <span class="card-meta">No preview for this file.</span>
        </div>
      {:else if loading}
        <p class="note" role="status">Loading…</p>
      {:else if failed}
        <p class="note" role="alert">The file did not load.</p>
      {:else if kind === "pdf"}
        <iframe class="frame" src={pdf} title={file.name}></iframe>
      {:else if kind === "markdown"}
        <div class="md">{@html renderMarkdown(text)}</div>
      {:else}
        <pre class="text">{text}</pre>
      {/if}
      {#if cut && !loading && !failed}
        <p class="note">Only the first 1 MiB shows. Download the file for the rest.</p>
      {/if}
    </div>
    {#if kind === "pdf" || kind === "none"}
      <footer class="foot">
        <a class="btn" href={src} download={file.name}>Download</a>
      </footer>
    {/if}
  </div>
</dialog>

<style>
  .preview {
    width: min(920px, 94vw);
    max-height: 90dvh;
    padding: 0;
    border: 2px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--card);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  .preview::backdrop { background: color-mix(in srgb, var(--ink) 55%, transparent); }
  .box { display: grid; grid-template-rows: auto auto minmax(0, 1fr) auto; max-height: 90dvh; }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 2px solid var(--line);
  }
  .who { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; }
  .name { margin: 0; font-size: 1rem; overflow-wrap: anywhere; }
  .size { flex: none; color: var(--muted); font-size: .8rem; }
  .head :global(.icon-btn) { text-decoration: none; }
  .error { margin: 6px 14px 0; }
  .body { padding: 14px; overflow: auto; min-height: 0; }
  .media { display: block; max-width: 100%; max-height: 70dvh; margin: 0 auto; }
  img.media, video.media { border-radius: var(--r); background: var(--bg); }
  audio { width: 100%; }
  .frame { width: 100%; height: 70dvh; border: 2px solid var(--line); border-radius: var(--r); background: var(--bg); }
  .text {
    margin: 0;
    font-family: var(--font-mono);
    font-size: .85rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .md { overflow-wrap: anywhere; }
  .md :global(pre) { overflow-x: auto; }
  .note { margin: 8px 0 0; color: var(--muted); font-size: .85rem; }
  .card { display: grid; justify-items: center; gap: 4px; padding: 24px 12px; text-align: center; }
  .card-icon { font-size: 2.4rem; }
  .card-name { overflow-wrap: anywhere; }
  .card-meta { color: var(--muted); font-size: .85rem; }
  .foot { padding: 10px 14px 14px; text-align: center; }
  .foot .btn { display: inline-block; text-decoration: none; }
</style>
