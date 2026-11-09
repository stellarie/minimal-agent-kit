export const DEFAULTS = Object.freeze({
  initialStability: 2,
  maxStability: 365,
  growth: 2,
  hotThreshold: 0.5,
  fadingThreshold: 0.15,
  budget: 100,
  nudgeEveryTurns: 10,
});

export function retention(entry, session) {
  if (!entry) return 0;
  const elapsed = Math.max(0, session - entry.last);
  return Math.exp(-elapsed / entry.s);
}

// A recall near the edge of forgetting grows stability the most.
export function refresh(entry, session, config = DEFAULTS) {
  if (!entry) {
    return { s: config.initialStability, last: session, uses: 1 };
  }
  if (entry.last === session) return entry;
  const r = retention(entry, session);
  const s = Math.min(
    config.maxStability,
    entry.s * (1 + config.growth * (1 - r)) + 1,
  );
  return { s, last: session, uses: (entry.uses ?? 0) + 1 };
}

export function tier(memory, entry, session, config = DEFAULTS) {
  if (!memory.valid) return "invalid";
  if (memory.pinned) return "pinned";
  const r = retention(entry, session);
  if (r >= config.hotThreshold) return "hot";
  if (r >= config.fadingThreshold) return "fading";
  return "cold";
}
