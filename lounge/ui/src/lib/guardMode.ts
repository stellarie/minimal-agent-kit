import type { GuardMode } from "./api.ts";

export const GUARD_MODE_LABELS: Record<GuardMode, string> = {
  normal: "Normal",
  auto: "Auto",
  bypass: "Bypass",
};

export interface ModeView {
  // The warning bar under the header.
  bar: boolean;
  // The soft badge next to the switch.
  badge: boolean;
  label: string;
  // What the mode does, for the title of the switch.
  help: string;
}

const HELP: Record<GuardMode, string> = {
  normal: "Risky calls open a card for you.",
  auto: "A judge allows the calls it finds safe. It opens a card for the rest.",
  bypass: "Risky calls run with no card. Hard blocks still deny. Bypass ends when the core restarts.",
};

export function modeView(mode: GuardMode): ModeView {
  return { bar: mode === "bypass", badge: mode === "auto", label: GUARD_MODE_LABELS[mode], help: HELP[mode] };
}
