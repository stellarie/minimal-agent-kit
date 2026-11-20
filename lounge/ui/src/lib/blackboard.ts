import type { BoardItem } from "./api.ts";

export function progress(items: BoardItem[]): string {
  if (items.length === 0) return "no items";
  return `${items.filter((i) => i.done).length} of ${items.length} done`;
}
