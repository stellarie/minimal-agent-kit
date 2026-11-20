<script lang="ts">
  import { untrack } from "svelte";
  import type { LoungeClient, Message, RoomFile } from "../lib/api.ts";
  import { formatSize } from "../lib/embeds.ts";
  import { formatTime } from "../lib/format.ts";
  import { nameOf } from "../lib/names.svelte.ts";
  import { previewKind, type PreviewKind } from "../lib/preview.ts";

  let {
    client,
    roomId,
    messages,
    now,
    onOpen,
    onError,
  }: {
    client: LoungeClient;
    roomId: string;
    // The loaded messages of the room, for files that arrive live.
    messages: Message[];
    now: number;
    onOpen: (file: RoomFile) => void;
    onError: (err: unknown) => void;
  } = $props();

  const ICONS: Record<PreviewKind, string> = {
    image: "🖼",
    video: "🎞",
    audio: "🎵",
    markdown: "📝",
    text: "📄",
    pdf: "📕",
    none: "📦",
  };

  let files = $state<RoomFile[]>([]);
  let next = $state<number | null>(null);
  let status = $state<"loading" | "more" | "idle">("loading");
  let failed = $state(false);
  // The newest message this list has seen.
  let top = 0;
  // Drops the answer of a request that a newer one replaced.
  let round = 0;

  function mine(list: RoomFile[], extra: RoomFile[]): RoomFile[] {
    const seen = new Set(list.map((f) => `${f.messageId}/${f.id}`));
    const fresh = extra.filter((f) => !seen.has(`${f.messageId}/${f.id}`));
    return [...list, ...fresh].sort((a, b) => b.messageId - a.messageId);
  }

  async function load(room: string, before?: number) {
    const mark = ++round;
    status = before === undefined ? "loading" : "more";
    failed = false;
    try {
      const page = await client.roomFiles(room, before);
      if (mark !== round) return;
      files = mine(before === undefined ? [] : files, page.files);
      next = page.next;
      status = "idle";
    } catch (err) {
      if (mark !== round) return;
      status = "idle";
      failed = true;
      onError(err);
    }
  }

  $effect(() => {
    const room = roomId;
    untrack(() => {
      files = [];
      next = null;
      top = messages.reduce((m, x) => Math.max(m, x.id), 0);
      void load(room);
    });
  });

  // A message that arrives while the tab is open adds its files.
  $effect(() => {
    const list = messages;
    untrack(() => {
      const added: RoomFile[] = [];
      for (const m of list) {
        if (m.id <= top) continue;
        top = Math.max(top, m.id);
        if (m.roomId !== roomId || m.kind !== undefined) continue;
        for (const att of m.attachments ?? []) {
          added.push({ ...att, author: m.author, messageId: m.id, createdAt: m.createdAt });
        }
      }
      if (added.length > 0) files = mine(files, added);
    });
  });
</script>

<div class="files">
  <h2 class="section-title">Files</h2>
  {#if status === "loading"}
    <p class="note" role="status">Loading files…</p>
  {:else if files.length === 0 && failed}
    <p class="note">The file list did not load.</p>
    <button class="more" type="button" onclick={() => void load(roomId)}>Try again</button>
  {:else if files.length === 0}
    <p class="note">No files in this channel yet.</p>
  {:else}
    <ul class="list">
      {#each files as file (file.messageId + "/" + file.id)}
        <li>
          <button class="row" type="button" onclick={() => onOpen(file)} title={file.name}>
            <span class="icon" aria-hidden="true">{ICONS[previewKind(file.mime, file.name)]}</span>
            <span class="text">
              <span class="name">{file.name}</span>
              <span class="meta">{formatSize(file.size)} · {nameOf(file.author)} · {formatTime(file.createdAt, now)}</span>
            </span>
          </button>
        </li>
      {/each}
    </ul>
    {#if next !== null}
      <button class="more" type="button" disabled={status === "more"} onclick={() => void load(roomId, next ?? undefined)}>
        {status === "more" ? "Loading…" : "Load more"}
      </button>
    {/if}
  {/if}
</div>

<style>
  .files { display: grid; gap: 8px; }
  .note { margin: 0; color: var(--muted); font-size: .85rem; }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 7px 10px;
    border: 2px solid var(--line);
    border-left: 5px solid var(--pink);
    border-radius: var(--r-lg);
    background: var(--bg);
    color: var(--ink);
    text-align: left;
    cursor: pointer;
  }
  .row:hover { border-color: var(--pink); }
  .icon { flex: none; font-size: 1.2rem; }
  .text { display: grid; gap: 1px; min-width: 0; }
  .name { font-weight: 700; font-size: .85rem; overflow-wrap: anywhere; }
  .meta { color: var(--muted); font-size: .75rem; }
  .more {
    justify-self: start;
    padding: 4px 12px;
    border: 2px dashed var(--line);
    border-radius: var(--r);
    background: var(--card);
    color: var(--ink);
    font-size: .8rem;
    cursor: pointer;
  }
  .more:disabled { opacity: .5; cursor: default; }
</style>
