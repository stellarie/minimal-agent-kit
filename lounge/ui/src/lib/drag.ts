import type { Drop } from "./layout.ts";

// Where a drop would land. The channel hint is the Drop that moveChannel takes.
export type Hint = { kind: "channel"; drop: Drop } | { kind: "category"; before: string | null };

export type Row =
  // A visible top-level channel, with its threads. mid: the middle of the channel line.
  | { kind: "channel"; id: string; category: string | null; top: number; mid: number; bottom: number }
  // A group section. headMid: the middle of its header, set for a category only.
  | { kind: "group"; category: string | null; top: number; bottom: number; headMid?: number };

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Dragged {
  kind: "channel" | "category";
  id: string;
}

export interface Session extends Dragged {
  phase: "pressed" | "dragging";
  ox: number;
  oy: number;
}

// A move shorter than this is a click.
export const DRAG_START_PX = 4;

const within = (top: number, bottom: number, y: number) => top <= y && y < bottom;

// Rows are in page order. A hidden row is not in the list.
export function hintAt(drag: Dragged, x: number, y: number, rows: readonly Row[], box: Box): Hint | null {
  if (x < box.left || x >= box.right || !within(box.top, box.bottom, y)) return null;
  const groups = rows.filter((r) => r.kind === "group");
  if (drag.kind === "channel") {
    const channels = rows.filter((r) => r.kind === "channel");
    const at = channels.find((r) => within(r.top, r.bottom, y));
    if (at) {
      if (y < at.mid) return { kind: "channel", drop: { kind: "before", id: at.id } };
      const next = channels.find((r, i) => i > channels.indexOf(at) && r.category === at.category);
      return { kind: "channel", drop: next ? { kind: "before", id: next.id } : { kind: "into", category: at.category } };
    }
    const g = groups.find((r) => within(r.top, r.bottom, y));
    return g ? { kind: "channel", drop: { kind: "into", category: g.category } } : null;
  }
  const last = groups.at(-1);
  if (!last || y >= last.bottom) return { kind: "category", before: null };
  const g = groups.filter((r) => r.top <= y).at(-1) ?? groups[0]!;
  const cats = groups.filter((r) => r.category !== null);
  if (g.category === null) return { kind: "category", before: cats[0]?.category ?? null };
  if (y < (g.headMid ?? g.top)) return { kind: "category", before: g.category };
  return { kind: "category", before: cats[cats.indexOf(g) + 1]?.category ?? null };
}

export function press(kind: Dragged["kind"], id: string, x: number, y: number): Session {
  return { phase: "pressed", kind, id, ox: x, oy: y };
}

// Dragging stays on once it starts.
export function advance(s: Session, x: number, y: number): Session {
  if (s.phase === "dragging" || Math.hypot(x - s.ox, y - s.oy) < DRAG_START_PX) return s;
  return { ...s, phase: "dragging" };
}

// A drop needs a drag that started and a place to land.
export function finish(s: Session, hint: Hint | null): Hint | null {
  return s.phase === "dragging" ? hint : null;
}
