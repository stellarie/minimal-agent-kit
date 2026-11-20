import type { Caller } from "../config.ts";

export type Action =
  | "lounge_read"
  | "lounge_post"
  | "lounge_who"
  | "lounge_channels"
  | "lounge_nick"
  | "event_list"
  | "event_create"
  | "event_cancel"
  | "thread_start"
  | "lounge_files"
  | "lounge_skill"
  | "session_list"
  | "session_open"
  | "session_message"
  | "session_status"
  | "session_close";

export interface Identity {
  caller: Caller;
  restricted: boolean;
}

const LOUNGE_ACTIONS: readonly Action[] = [
  "lounge_read",
  "lounge_post",
  "lounge_who",
  "lounge_channels",
  "lounge_nick",
  "event_list",
  "event_create",
  "event_cancel",
  "thread_start",
  "lounge_files",
  "lounge_skill",
];
const SESSION_READ: readonly Action[] = ["session_list", "session_status"];
// A chat runtime must not drive other sessions.
const SESSION_DRIVE: readonly Action[] = ["session_open", "session_message", "session_close"];

export function can(identity: Identity, action: Action): boolean {
  const { restricted } = identity;
  if (LOUNGE_ACTIONS.includes(action)) return true;
  if (SESSION_READ.includes(action)) return true;
  if (SESSION_DRIVE.includes(action)) return !restricted;
  return false;
}
