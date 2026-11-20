import type { Category, Channel, Layout, LayoutBody } from "./api.ts";

export type Drop = { kind: "before"; id: string } | { kind: "into"; category: string | null };

export interface Group {
  // null: the channels with no category.
  category: Category | null;
  channels: Channel[];
}

// No-category channels first, then each category.
export function groups(layout: Layout): Group[] {
  const tops = layout.channels.filter((c) => !c.parent);
  const known = new Set(layout.categories.map((c) => c.id));
  const loose = tops.filter((c) => !c.category || !known.has(c.category));
  return [
    { category: null, channels: loose },
    ...layout.categories.map((category) => ({
      category,
      channels: tops.filter((c) => c.category === category.id),
    })),
  ];
}

export function toBody(layout: Layout): LayoutBody {
  return {
    categories: layout.categories.map((c) => c.id),
    channels: groups(layout).flatMap((g) => g.channels.map((c) => ({ id: c.id, category: g.category?.id ?? null }))),
  };
}

export function sameBody(a: LayoutBody, b: LayoutBody): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function moveChannel(layout: Layout, id: string, drop: Drop): LayoutBody {
  const body = toBody(layout);
  const items = body.channels;
  const from = items.findIndex((x) => x.id === id);
  if (from < 0 || (drop.kind === "before" && drop.id === id)) return body;
  const [item] = items.splice(from, 1);
  if (drop.kind === "before") {
    const at = items.findIndex((x) => x.id === drop.id);
    if (at < 0) {
      items.splice(from, 0, item!);
      return body;
    }
    item!.category = items[at]!.category;
    items.splice(at, 0, item!);
    return body;
  }
  item!.category = drop.category;
  let last = -1;
  items.forEach((x, k) => {
    if (x.category === drop.category) last = k;
  });
  items.splice(last < 0 ? items.length : last + 1, 0, item!);
  return body;
}

// beforeId null: last.
export function moveCategory(layout: Layout, id: string, beforeId: string | null): LayoutBody {
  const body = toBody(layout);
  const from = body.categories.indexOf(id);
  if (from < 0 || beforeId === id) return body;
  body.categories.splice(from, 1);
  const at = beforeId === null ? -1 : body.categories.indexOf(beforeId);
  body.categories.splice(at < 0 ? body.categories.length : at, 0, id);
  return body;
}

// One place up or down; group edges cross groups.
export function stepChannel(layout: Layout, id: string, dir: -1 | 1): LayoutBody {
  const gs = groups(layout);
  const g = gs.findIndex((x) => x.channels.some((c) => c.id === id));
  if (g < 0) return toBody(layout);
  const list = gs[g]!.channels;
  const i = list.findIndex((c) => c.id === id);
  if (dir < 0) {
    if (i > 0) return moveChannel(layout, id, { kind: "before", id: list[i - 1]!.id });
    if (g === 0) return toBody(layout);
    return moveChannel(layout, id, { kind: "into", category: gs[g - 1]!.category?.id ?? null });
  }
  if (i < list.length - 2) return moveChannel(layout, id, { kind: "before", id: list[i + 2]!.id });
  if (i === list.length - 2) return moveChannel(layout, id, { kind: "into", category: gs[g]!.category?.id ?? null });
  const next = gs[g + 1];
  if (!next) return toBody(layout);
  const first = next.channels[0];
  return first
    ? moveChannel(layout, id, { kind: "before", id: first.id })
    : moveChannel(layout, id, { kind: "into", category: next.category?.id ?? null });
}

export function stepCategory(layout: Layout, id: string, dir: -1 | 1): LayoutBody {
  const ids = layout.categories.map((c) => c.id);
  const i = ids.indexOf(id);
  if (i < 0) return toBody(layout);
  if (dir < 0) return i === 0 ? toBody(layout) : moveCategory(layout, id, ids[i - 1]!);
  if (i === ids.length - 1) return toBody(layout);
  return moveCategory(layout, id, ids[i + 2] ?? null);
}

// The layout a body gives, for an instant UI update.
export function applyBody(layout: Layout, body: LayoutBody): Layout {
  const cats = new Map(layout.categories.map((c) => [c.id, c]));
  const byId = new Map(layout.channels.map((c) => [c.id, c]));
  const tops: Channel[] = [];
  for (const item of body.channels) {
    const c = byId.get(item.id);
    if (!c) continue;
    const next: Channel = { ...c };
    if (item.category) next.category = item.category;
    else delete next.category;
    tops.push(next);
  }
  return {
    categories: body.categories.map((id) => cats.get(id)).filter((c): c is Category => c !== undefined),
    channels: [...tops, ...layout.channels.filter((c) => c.parent)],
  };
}
