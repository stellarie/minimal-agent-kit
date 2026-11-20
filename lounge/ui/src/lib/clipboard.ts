import type { Message } from "./api.ts";

// The clipboard as this page sees it.
export interface ClipboardApi {
  writeText(text: string): Promise<void>;
}

// Who sent it and when. The caller formats the time.
export interface CopyHead {
  name: string;
  time: string;
}

// The text that one copy puts on the clipboard.
export function copyText(message: Message, head: CopyHead): string {
  const files = (message.attachments ?? []).map((a) => `[file] ${a.name}`);
  const stamp = [head.name, head.time].filter((part) => part !== "").join(" · ");
  const lines = [stamp, message.text.trim(), ...files];
  return lines.filter((line) => line !== "").join("\n");
}

// True when the text reached the clipboard.
export async function copyMessage(api: ClipboardApi | undefined, text: string): Promise<boolean> {
  if (!api || text === "") return false;
  try {
    await api.writeText(text);
    return true;
  } catch {
    // A refused copy must not break the row.
    return false;
  }
}
