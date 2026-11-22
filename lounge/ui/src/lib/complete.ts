export type TriggerKind = "@" | "#" | "$";

export interface Trigger {
  kind: TriggerKind;
  query: string;
  // Index of the trigger character.
  start: number;
}

export interface Item {
  value: string;
  label: string;
  detail?: string;
}

export const MAX_ITEMS = 8;

const QUERY_CHAR = /[a-z0-9-]/i;

// A query starts with a letter. A channel id or a skill name can start with a digit.
const QUERY_START: Record<TriggerKind, RegExp> = {
  "@": /^[a-z]/i,
  "#": /^[a-z0-9]/i,
  $: /^[a-z0-9]/i,
};

// The word before the caret, when it starts with @, #, or $.
export function trigger(text: string, caret: number): Trigger | null {
  let at = Math.min(Math.max(caret, 0), text.length);
  const end = at;
  while (at > 0 && QUERY_CHAR.test(text[at - 1]!)) at -= 1;
  if (at === 0) return null;
  const kind = text[at - 1];
  if (kind !== "@" && kind !== "#" && kind !== "$") return null;
  const start = at - 1;
  // A mail address or a markdown heading is no trigger.
  if (start > 0 && !/\s/.test(text[start - 1]!)) return null;
  const query = text.slice(at, end);
  if (query !== "" && !QUERY_START[kind].test(query)) return null;
  return { kind, query, start };
}

// "@nana" matches "na" by its name, not by its @.
function bare(value: string): string {
  return /^[@#$]/.test(value) ? value.slice(1) : value;
}

// Prefix matches first, then substring matches. Each group keeps its order.
export function filter(items: readonly Item[], query: string): Item[] {
  const q = query.toLowerCase();
  if (q === "") return items.slice(0, MAX_ITEMS);
  const prefix: Item[] = [];
  const inside: Item[] = [];
  for (const item of items) {
    const names = [bare(item.value).toLowerCase(), item.label.toLowerCase()];
    if (names.some((n) => n.startsWith(q))) prefix.push(item);
    else if (names.some((n) => n.includes(q))) inside.push(item);
  }
  return [...prefix, ...inside].slice(0, MAX_ITEMS);
}

// Replaces the trigger and the query with the value and one space.
export function insert(
  text: string,
  caret: number,
  start: number,
  value: string,
): { text: string; caret: number } {
  const next = `${text.slice(0, start)}${value} ${text.slice(caret)}`;
  return { text: next, caret: start + value.length + 1 };
}
