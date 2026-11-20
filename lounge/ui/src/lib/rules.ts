import { RULES_MAX_BYTES } from "./api.ts";

export interface RulesState {
  bytes: number;
  over: boolean;
  dirty: boolean;
  canSave: boolean;
}

// Save is off if unchanged or over the limit.
export function rulesState(text: string, saved: string): RulesState {
  const bytes = new TextEncoder().encode(text).length;
  const over = bytes > RULES_MAX_BYTES;
  const dirty = text !== saved;
  return { bytes, over, dirty, canSave: dirty && !over };
}
