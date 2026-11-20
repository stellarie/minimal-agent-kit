import type { Approval } from "./api.ts";

export const MAX_TOASTS = 3;
export const MAX_LINE_REASON = 120;
const GAP = 8;
const FLOOR = 12;

// Oldest first: the core lists approvals in order of arrival.
export function visibleToasts(list: Approval[]): { shown: Approval[]; more: number } {
  const shown = list.slice(0, MAX_TOASTS);
  return { shown, more: list.length - shown.length };
}

export const DANGER_WORD = "dangerous";

export function isDanger(a: Approval): boolean {
  return a.danger === true;
}

export function toastLine(a: Approval, name: string): string {
  const flat = a.reason.replace(/\s+/g, " ").trim();
  const reason = flat.length > MAX_LINE_REASON ? `${flat.slice(0, MAX_LINE_REASON - 1)}…` : flat;
  const mark = isDanger(a) ? `${DANGER_WORD} · ` : "";
  return `${name} · ${mark}${a.tool} · ${reason}`;
}

// The offset from the window bottom. No composer on screen: the floor.
export function toastBottom(composer: { top: number; bottom: number } | null, viewport: number): number {
  if (composer === null || composer.bottom <= 0 || composer.top >= viewport) return FLOOR;
  return Math.max(FLOOR, Math.round(viewport - composer.top + GAP));
}

export const MAX_TOAST_WIDTH = 640;

// Center on the composer, or on the window without one.
export function toastSpan(
  composer: { left: number; width: number; top: number; bottom: number } | null,
  viewport: { width: number; height: number },
): { center: number; width: number } {
  const shown = composer !== null && composer.bottom > 0 && composer.top < viewport.height && composer.width > 0;
  if (!shown) return { center: viewport.width / 2, width: Math.min(MAX_TOAST_WIDTH, viewport.width - 16) };
  return { center: composer.left + composer.width / 2, width: Math.min(MAX_TOAST_WIDTH, composer.width) };
}
