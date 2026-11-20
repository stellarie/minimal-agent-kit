// The core's id rule: lounge/core/src/roster/types.ts.
export const ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
// The last two guard lookups in plain objects.
export const RESERVED_IDS: readonly string[] = ["owner", "constructor", "prototype", "__proto__"];

// Options of one runtime mean nothing to another.
export const RUNTIME_OPTION_KEYS: readonly string[] = ["command", "commandArgs", "reply", "softMs", "hardMs"];

export function validId(id: string): boolean {
  return ID_PATTERN.test(id) && !RESERVED_IDS.includes(id);
}

export const TAPE_SLOTS = [1, 2, 3, 4] as const;

// The owner has no label slot.
export const OWNER_TAPE = "var(--pink-soft)";

// The label color of a slot, for --who.
export function tapeVar(entry: { tape: number }): string {
  const slot = TAPE_SLOTS.find((n) => n === entry.tape) ?? TAPE_SLOTS[0];
  return `var(--tape-${slot})`;
}

// "nana" becomes "Nana".
export function capitalize(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}
