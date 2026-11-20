import { displayName } from "./format.ts";

// Names the callers chose. Templates that read it update.
export const nicknames: Record<string, string> = $state({});

export function nameOf(caller: string): string {
  return (Object.hasOwn(nicknames, caller) && nicknames[caller]) || displayName(caller);
}

export function setNickname(caller: string, name: string): void {
  if (name) nicknames[caller] = name;
  else delete nicknames[caller];
}
