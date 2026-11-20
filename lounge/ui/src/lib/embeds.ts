import type { Attachment } from "./api.ts";

export type MediaKind = "image" | "video" | "audio" | "file";

export function kindOfMime(mime: string): MediaKind {
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime)) return "image";
  if (/^video\/(mp4|webm)$/.test(mime)) return "video";
  if (/^audio\//.test(mime)) return "audio";
  return "file";
}

export function attachmentUrl(att: Attachment): string {
  return `/api/attachments/${att.id}/${encodeURIComponent(att.name)}`;
}

export function formatSize(bytes: number): string {
  // A bad size from the server must not print "NaN"
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
