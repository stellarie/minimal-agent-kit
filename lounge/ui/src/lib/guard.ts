import type { Approval, AuditEntry } from "./api.ts";

export function newApprovals(known: readonly string[], next: readonly Approval[]): Approval[] {
  return next.filter((a) => !known.includes(a.id));
}

export function minutesLeft(expiresAt: string, now: number): number {
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.ceil((t - now) / 60_000));
}

export function sourceLabel(source: string): string {
  if (source === "mode") return "tool mode";
  if (source === "guard-mode") return "guard mode";
  return source.startsWith("plugin:") ? `plugin ${source.slice("plugin:".length)}` : source;
}

export const OUTCOMES: Record<AuditEntry["outcome"], string> = {
  allowed: "Allowed",
  denied: "Denied",
  blocked: "Blocked",
  timeout: "Timed out",
  "auto-allowed": "Auto-allowed",
  "bypass-allowed": "Bypass-allowed",
};

export function outcomeLabel(outcome: AuditEntry["outcome"]): string {
  return OUTCOMES[outcome] ?? outcome;
}

// Only lounge plugin paths may load.
export function panelSrc(panel: string | undefined): string | null {
  if (!panel) return null;
  return panel.startsWith("/plugins/") && !panel.includes("..") ? panel : null;
}
