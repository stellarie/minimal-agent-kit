// A theme sets the CSS color variables of theme.css and one background pattern.
export const COLOR_KEYS = [
  "bg",
  "card",
  "ink",
  "muted",
  "pink",
  "pink-deep",
  "pink-soft",
  "line",
  "on-pink",
  "tape-1",
  "tape-2",
  "tape-3",
  "tape-4",
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number];

// The variable names stay from the first UI. "pink" is the accent.
export const COLOR_LABELS: Record<ColorKey, string> = {
  bg: "Background",
  card: "Panels",
  ink: "Text",
  muted: "Soft text",
  pink: "Accent",
  "pink-deep": "Accent text",
  "pink-soft": "Highlight",
  line: "Borders",
  "on-pink": "Text on accent",
  "tape-1": "Label 1",
  "tape-2": "Label 2",
  "tape-3": "Label 3",
  "tape-4": "Label 4",
};

export const PATTERNS = ["rules", "grid", "contour", "dots", "none"] as const;

export type Pattern = (typeof PATTERNS)[number];

export const PATTERN_LABELS: Record<Pattern, string> = {
  rules: "Ruled lines",
  grid: "Grid",
  contour: "Contour lines",
  dots: "Dots",
  none: "Plain",
};

export interface Theme {
  id: string;
  name: string;
  dark: boolean;
  pattern: Pattern;
  colors: Record<ColorKey, string>;
  custom?: boolean;
}

// The theme that follows the system light or dark mode: Ledger or Ledger Night.
export const SYSTEM = "system";
export const MAX_THEMES = 30;
export const HIGH_CONTRAST = "high-contrast";
const HEX = /^#[0-9a-f]{6}$/i;

export const SAMPLES: Theme[] = [
  {
    id: "ledger",
    name: "Ledger",
    dark: false,
    pattern: "rules",
    colors: {
      bg: "#f5f2ea", card: "#fffdf8", ink: "#1d2733", muted: "#586270",
      pink: "#2b7a68", "pink-deep": "#1c5c4d", "pink-soft": "#e2eee8", line: "#d6d0be",
      "on-pink": "#ffffff", "tape-1": "#efe3b9", "tape-2": "#d4e2ee", "tape-3": "#dde8cf", "tape-4": "#efd6cc",
    },
  },
  {
    id: "ledger-night",
    name: "Ledger Night",
    dark: true,
    pattern: "rules",
    colors: {
      bg: "#13171a", card: "#1b2125", ink: "#e9e6dd", muted: "#a2acb4",
      pink: "#62bba5", "pink-deep": "#82d2bd", "pink-soft": "#22342f", line: "#2e3a40",
      "on-pink": "#0c1815", "tape-1": "#4a4125", "tape-2": "#25405a", "tape-3": "#2f4a2e", "tape-4": "#553229",
    },
  },
  {
    id: "blueprint",
    name: "Blueprint",
    dark: true,
    pattern: "grid",
    colors: {
      bg: "#0e2a4b", card: "#133562", ink: "#eaf3ff", muted: "#aac4e4",
      pink: "#7cc4ff", "pink-deep": "#a3d7ff", "pink-soft": "#1b4a7e", line: "#3a679c",
      "on-pink": "#06213f", "tape-1": "#3d4f7a", "tape-2": "#1d5f8a", "tape-3": "#2e6b6b", "tape-4": "#5b4a7a",
    },
  },
  {
    id: "harbor",
    name: "Harbor",
    dark: false,
    pattern: "contour",
    colors: {
      bg: "#edf2f4", card: "#ffffff", ink: "#12303d", muted: "#4a6370",
      pink: "#1d6a86", "pink-deep": "#155067", "pink-soft": "#dbe9ef", line: "#c2d4db",
      "on-pink": "#ffffff", "tape-1": "#d3e4ec", "tape-2": "#cfe5e0", "tape-3": "#e4e0d0", "tape-4": "#dcd8e8",
    },
  },
  {
    id: "terracotta",
    name: "Terracotta",
    dark: false,
    pattern: "dots",
    colors: {
      bg: "#faf0e8", card: "#fffaf5", ink: "#3a2218", muted: "#765748",
      pink: "#a94a28", "pink-deep": "#8c3a1b", "pink-soft": "#f5ddd0", line: "#e4c8b6",
      "on-pink": "#ffffff", "tape-1": "#f2d4c2", "tape-2": "#e8dcb8", "tape-3": "#d7e0c5", "tape-4": "#e4d0d8",
    },
  },
  {
    id: "graphite",
    name: "Graphite",
    dark: true,
    pattern: "none",
    colors: {
      bg: "#1d1e21", card: "#26282c", ink: "#ececec", muted: "#a8acb2",
      pink: "#9fb0c6", "pink-deep": "#b9c7d9", "pink-soft": "#353a42", line: "#3e4249",
      "on-pink": "#14171b", "tape-1": "#44464c", "tape-2": "#364654", "tape-3": "#3f4b3c", "tape-4": "#4d3d46",
    },
  },
  {
    id: HIGH_CONTRAST,
    name: "High contrast",
    dark: true,
    pattern: "none",
    colors: {
      bg: "#000000", card: "#0a0a0a", ink: "#ffffff", muted: "#d4d4d4",
      pink: "#ffd60a", "pink-deep": "#ffe25c", "pink-soft": "#1c1c1c", line: "#ffffff",
      "on-pink": "#000000", "tape-1": "#2e2a00", "tape-2": "#00264d", "tape-3": "#003b1f", "tape-4": "#400033",
    },
  },
];

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function isPattern(value: unknown): value is Pattern {
  return PATTERNS.some((p) => p === value);
}

// Stored data is untrusted: keep only valid themes.
export function parseCustom(raw: string | null): Theme[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Theme[] = [];
  for (const item of data.slice(0, MAX_THEMES)) {
    const t = item as Partial<Theme> | null;
    if (!t || typeof t.id !== "string" || typeof t.name !== "string" || !t.colors) continue;
    const colors = {} as Record<ColorKey, string>;
    if (!COLOR_KEYS.every((k) => isHex((colors[k] = (t.colors as Record<string, unknown>)[k] as string)))) continue;
    const pattern = isPattern(t.pattern) ? t.pattern : "none";
    out.push({ id: t.id, name: t.name.slice(0, 40) || "Custom", dark: t.dark === true, pattern, colors, custom: true });
  }
  return out;
}

export function newThemeId(taken: readonly Theme[]): string {
  let n = taken.length + 1;
  while (taken.some((t) => t.id === `custom-${n}`)) n++;
  return `custom-${n}`;
}

// WCAG relative luminance of a #rrggbb color.
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// WCAG contrast ratio, from 1 to 21.
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const MIN_CONTRAST = 4.5;
export const MIN_HIGH_CONTRAST = 7;

// The floor of one theme. Only the shipped High contrast theme takes 7:1.
export function minContrast(theme: Theme): number {
  return theme.id === HIGH_CONTRAST && theme.custom !== true ? MIN_HIGH_CONTRAST : MIN_CONTRAST;
}

// Text and surface pairs that the UI draws together.
export const PAIRS: [text: ColorKey, surface: ColorKey, label: string][] = [
  ["ink", "bg", "Text on background"],
  ["ink", "card", "Text on panels"],
  ["muted", "card", "Soft text on panels"],
  ["muted", "bg", "Soft text on background"],
  ["pink-deep", "card", "Accent text on panels"],
  ["pink-deep", "pink-soft", "Accent text on highlight"],
  ["on-pink", "pink", "Text on accent"],
  ["ink", "pink-soft", "Text on highlight"],
  ["muted", "pink-soft", "Soft text on highlight"],
  ["ink", "tape-1", "Text on label 1"],
  ["ink", "tape-2", "Text on label 2"],
  ["ink", "tape-3", "Text on label 3"],
  ["ink", "tape-4", "Text on label 4"],
];

// The pairs under the floor of the theme, with their ratio.
export function lowContrast(theme: Theme): { label: string; ratio: number }[] {
  const floor = minContrast(theme);
  const out: { label: string; ratio: number }[] = [];
  for (const [text, surface, label] of PAIRS) {
    const ratio = contrastRatio(theme.colors[text], theme.colors[surface]);
    if (ratio < floor) out.push({ label, ratio: Math.round(ratio * 10) / 10 });
  }
  return out;
}

function svg(width: number, height: number, body: string): string {
  return `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'%3E${body}%3C/svg%3E")`;
}

// The background tile of a pattern, drawn in the border and accent colors.
export function patternFor(pattern: Pattern, colors: Record<ColorKey, string>): string {
  const line = colors.line.replace("#", "%23");
  const accent = colors.pink.replace("#", "%23");
  switch (pattern) {
    case "rules":
      return svg(8, 28, `%3Cpath d='M0 27.5H8' stroke='${line}' stroke-width='1' fill='none'/%3E`);
    case "grid":
      return svg(32, 32, `%3Cpath d='M32 .5H0V32' stroke='${line}' stroke-width='1' fill='none' opacity='.55'/%3E`);
    case "contour":
      // Three waves per tile, each a full period wide, so the tile joins without a seam.
      return svg(
        160,
        72,
        `%3Cg fill='none' stroke='${accent}' stroke-width='1' opacity='.2'%3E` +
          "%3Cpath d='M0 10Q40-2 80 10T160 10'/%3E%3Cpath d='M0 34Q40 10 80 34T160 34'/%3E" +
          "%3Cpath d='M0 58Q40 46 80 58T160 58'/%3E%3C/g%3E",
      );
    case "dots":
      return svg(24, 24, `%3Ccircle cx='12' cy='12' r='1.2' fill='${accent}' opacity='.4'/%3E`);
    case "none":
      return "none";
  }
}

// A soft one-pixel edge, so a panel lifts off the page without a heavy shadow.
export function shadowFor(colors: Record<ColorKey, string>): string {
  return `0 1px 2px color-mix(in srgb, ${colors.ink} 22%, transparent)`;
}

// The variables to set on the root element.
export function themeVars(theme: Theme): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const key of COLOR_KEYS) vars[`--${key}`] = theme.colors[key];
  vars["--shadow"] = shadowFor(theme.colors);
  vars["--pattern"] = patternFor(theme.pattern, theme.colors);
  return vars;
}
