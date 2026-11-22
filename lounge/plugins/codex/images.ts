import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { TurnFile } from "../../core/src/adapters/types.ts";
import { codexHomeOf } from "../../core/src/api/codex-login.ts";
import { MAX_PER_MESSAGE, mimeOf } from "../../core/src/lounge/attachments.ts";

// codex 0.167 saves each image of its image tool as <CODEX_HOME>/generated_images/<thread id>/exec-<uuid>.png.
// `exec --json` emits no event for it, so the files are the only signal.
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const THREAD_ID = /^[A-Za-z0-9-]{1,64}$/;

// Unset when the id is not a plain id, so it never leaves the folder.
export function generatedImageDir(loungeHome: string, threadId: string): string | undefined {
  if (!THREAD_ID.test(threadId)) return undefined;
  return join(codexHomeOf(loungeHome), "generated_images", threadId);
}

function imageFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMAGE_EXT.has(extname(e.name).toLowerCase()))
      .map((e) => e.name);
  } catch {
    // No folder yet: the thread made no image.
    return [];
  }
}

// The image names that a thread holds now. Take it before a resumed turn.
export function imageNames(loungeHome: string, threadId: string): Set<string> {
  const dir = generatedImageDir(loungeHome, threadId);
  return new Set(dir === undefined ? [] : imageFiles(dir));
}

// The images that a thread holds beyond `before`: oldest first, the newest ten at most.
export function newImages(loungeHome: string, threadId: string, before: ReadonlySet<string>): TurnFile[] {
  const dir = generatedImageDir(loungeHome, threadId);
  if (dir === undefined) return [];
  const found: { name: string; path: string; at: number }[] = [];
  for (const name of imageFiles(dir)) {
    if (before.has(name)) continue;
    const path = join(dir, name);
    try {
      found.push({ name, path, at: statSync(path).mtimeMs });
    } catch {
      // Removed since the listing.
    }
  }
  found.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  return found.slice(-MAX_PER_MESSAGE).map((f) => ({ name: f.name, path: f.path, mime: mimeOf(f.name) }));
}
