import { capitalize } from "./roster.ts";

// The id, capitalized.
// A nickname replaces it in names.svelte.ts.
export function displayName(caller: string): string {
  return capitalize(caller);
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatTime(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return (sameDay ? timeFmt : dayFmt).format(d);
}

export function formatAgo(iso: string | null, now: number): string {
  if (!iso) return "not seen yet";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "not seen yet";
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

// "1 minute ago", "3 minutes ago".
function amountAgo(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

// Last seen in words. A future time reads "just now".
export function formatLastSeen(iso: string | null, now: number): string {
  if (!iso) return "not seen yet";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "not seen yet";
  // Math.max keeps a clock skew from a negative count.
  const diff = Math.max(0, now - t);
  if (diff < MINUTE_MS) return "just now";
  if (diff < HOUR_MS) return amountAgo(Math.floor(diff / MINUTE_MS), "minute");
  if (diff < DAY_MS) return amountAgo(Math.floor(diff / HOUR_MS), "hour");
  if (diff < WEEK_MS) return amountAgo(Math.floor(diff / DAY_MS), "day");
  if (diff < MONTH_MS) return amountAgo(Math.floor(diff / WEEK_MS), "week");
  if (diff < YEAR_MS) return amountAgo(Math.floor(diff / MONTH_MS), "month");
  return amountAgo(Math.floor(diff / YEAR_MS), "year");
}

export const HERE_MS = 10 * 60_000;

// Reachable stays here; else recent activity.
export function isHere(p: { lastSeen: string | null; reachable?: boolean }, now: number): boolean {
  if (p.reachable) return true;
  if (p.lastSeen === null) return false;
  return now - new Date(p.lastSeen).getTime() < HERE_MS;
}

export const GROUP_MS = 7 * 60_000;

// Back-to-back posts by one author share a header.
export function continues(
  prev: { author: string; createdAt: string; kind?: string } | undefined,
  m: { author: string; createdAt: string; kind?: string; replyTo?: number },
): boolean {
  if (!prev || prev.kind === "event" || m.kind === "event" || prev.author !== m.author) return false;
  // A reply shows its quote above a header.
  if (m.replyTo !== undefined) return false;
  // A tool line never joins a text group.
  if ((prev.kind ?? "text") !== (m.kind ?? "text")) return false;
  const gap = new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return gap >= 0 && gap < GROUP_MS;
}

// "Bash: npm test" names the tool Bash.
export function toolName(line: string): string {
  const cut = line.indexOf(":");
  return (cut > 0 ? line.slice(0, cut) : line).trim() || "a tool";
}

// "Ada is typing", "Ada and Bo are typing".
export function typingText(callers: string[]): string {
  const names = callers.map(displayName);
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
  return "Several agents are typing…";
}

const ISO_TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\b/g;
const eventFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

// Event lines carry ISO times; show them local.
export function localTimes(text: string): string {
  return text.replace(ISO_TIME, (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : eventFmt.format(d);
  });
}

export const QUOTE_CHARS = 80;

// One line of the quoted post, cut with an ellipsis.
export function quoteExcerpt(text: string, max = QUOTE_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
