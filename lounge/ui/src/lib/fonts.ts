export interface FontChoice {
  id: string;
  name: string;
  note: string;
  // First family in the stack. Empty: system font.
  family: string;
}

export const DEFAULT_FONT = "ibm-plex-sans";
export const FONT_KEY = "agent-lounge.font";

// Each Plex face is bundled, so the app needs no network.
export const FONTS: readonly FontChoice[] = [
  { id: DEFAULT_FONT, name: "IBM Plex Sans", note: "Clear and even", family: "IBM Plex Sans" },
  { id: "ibm-plex-mono", name: "IBM Plex Mono", note: "Fixed width, like a terminal", family: "IBM Plex Mono" },
  { id: "system", name: "System", note: "Your system font", family: "" },
];

const SYSTEM = 'system-ui, -apple-system, "Segoe UI", sans-serif';

export function fontById(id: string | null): FontChoice {
  return FONTS.find((f) => f.id === id) ?? FONTS.find((f) => f.id === DEFAULT_FONT)!;
}

export function fontStack(font: FontChoice): string {
  return font.family ? `"${font.family}", ${SYSTEM}` : SYSTEM;
}
