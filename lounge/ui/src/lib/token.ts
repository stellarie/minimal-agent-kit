export function takeFragmentToken(loc: Location, hist: History): string | null {
  const raw = loc.hash.startsWith("#") ? loc.hash.slice(1) : loc.hash;
  const token = new URLSearchParams(raw).get("token");
  if (!token) return null;
  hist.replaceState(null, "", loc.pathname + loc.search);
  return token;
}
