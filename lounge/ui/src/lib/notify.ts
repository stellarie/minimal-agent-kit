import { SESSION_ROOM_PREFIX, type Approval, type Message } from "./api.ts";

// The Tauri plugin returns undefined, not a Promise.
export interface Notifier {
  sendNotification(opts: { title: string; body: string }): void;
}

export interface NotifyEnv {
  hidden: boolean;
  notifier?: Notifier;
  // The display name for the title.
  name?: (caller: string) => string;
}

export function notify(message: Message, env: NotifyEnv): void {
  // Session rooms, events, and tool lines stay quiet.
  if (message.roomId.startsWith(SESSION_ROOM_PREFIX) || message.kind !== undefined) return;
  if (message.author === "owner" || !env.hidden || !env.notifier) return;
  try {
    const title = env.name ? env.name(message.author) : message.author;
    env.notifier.sendNotification({ title, body: message.text.slice(0, 120) });
  } catch {
    // A failed notification must not drop the message.
  }
}

export function notifyApproval(approval: Approval, env: NotifyEnv): void {
  if (!env.hidden || !env.notifier) return;
  try {
    const who = env.name ? env.name(approval.agent) : approval.agent;
    env.notifier.sendNotification({
      title: `${who} needs approval`,
      body: `${approval.tool}: ${approval.summary}`.slice(0, 120),
    });
  } catch {
    // A failed notification must not drop the card.
  }
}
