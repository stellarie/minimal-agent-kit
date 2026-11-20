<script lang="ts">
  import type { Attachment } from "../lib/api.ts";
  import { attachmentUrl, formatSize, kindOfMime } from "../lib/embeds.ts";

  let { attachments = [] }: { attachments?: Attachment[] } = $props();
</script>

{#if attachments.length > 0}
  <div class="embeds">
    {#each attachments as att (att.id)}
      {@const kind = kindOfMime(att.mime)}
      {@const src = attachmentUrl(att)}
      {#if kind === "image"}
        <a class="media" href={src} target="_blank" rel="noopener noreferrer" title={att.name}>
          <img {src} alt={att.name} loading="lazy" />
        </a>
      {:else if kind === "video"}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video class="media" {src} controls preload="metadata" title={att.name}></video>
      {:else if kind === "audio"}
        <audio {src} controls preload="metadata" title={att.name}></audio>
      {:else}
        <a class="file" href={src} download={att.name}>
          <span class="file-name">{att.name}</span>
          <span class="size">{formatSize(att.size)}</span>
        </a>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .embeds { display: grid; gap: 6px; justify-items: start; margin-top: 4px; }
  .media { display: block; max-width: min(420px, 100%); }
  .media img, video.media {
    display: block;
    max-width: 100%;
    max-height: 320px;
    border: 1px solid var(--line);
    border-radius: var(--r-lg);
    background: var(--bg);
  }
  audio { max-width: 100%; }
  .file {
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(420px, 100%);
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--line);
    border-left: 4px solid var(--pink);
    border-radius: var(--r-lg);
    color: var(--ink);
    text-decoration: none;
  }
  .file:hover { border-color: var(--pink); }
  .file-name { font-weight: 600; overflow-wrap: anywhere; }
  .size { color: var(--muted); font-size: .75rem; }
</style>
