export const LATEST_URL = "https://api.github.com/repos/stellarie/minimal-agent-kit/releases/latest";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseAsset {
  name: string;
  url: string;
}

export type CheckResult =
  | { state: "off" }
  | { state: "none" }
  | { state: "available"; version: string; assets: ReleaseAsset[] }
  | { state: "error"; reason: string };

export function compareSemver(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! > right[i]! ? 1 : -1;
  }
  return 0;
}

export async function checkLatest(opts: { fetch: Fetch; current: string; enabled: boolean }): Promise<CheckResult> {
  if (!opts.enabled) return { state: "off" };
  let res: Response;
  try {
    res = await opts.fetch(LATEST_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "agent-lounge" },
    });
  } catch {
    return { state: "error", reason: "network" };
  }
  if (res.status === 404) return { state: "none" };
  if (!res.ok) return { state: "error", reason: `http ${res.status}` };
  let body: { tag_name?: unknown; assets?: { name: string; browser_download_url: string }[] };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { state: "error", reason: "body" };
  }
  const tag = body.tag_name;
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+$/.test(tag)) return { state: "error", reason: "tag" };
  const version = tag.slice(1);
  if (compareSemver(version, opts.current) <= 0) return { state: "none" };
  const assets = (body.assets ?? []).map((a) => ({ name: a.name, url: a.browser_download_url }));
  return { state: "available", version, assets };
}
