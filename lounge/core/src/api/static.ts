import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { join, resolve, sep } from "node:path";

const CACHE_IMMUTABLE = "max-age=31536000, immutable";
const CACHE_REVALIDATE = "no-cache";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveTarget(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const base = resolve(root);
  const parts = decoded.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return null;
  const target = resolve(base, ...parts);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export function contentType(file: string): string {
  const dot = file.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function sendBody(res: ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer): void {
  const head = res.req?.method === "HEAD";
  res.writeHead(status, { ...headers, "content-length": String(body.length) });
  res.end(head ? undefined : body);
}

function sendNotFound(res: ServerResponse): void {
  const body = JSON.stringify({ error: "not_found", message: "no file for that path" });
  sendBody(res, 404, { "content-type": "application/json" }, body);
}

function sendFile(res: ServerResponse, file: string, cache: string): void {
  sendBody(res, 200, { "content-type": contentType(file), "cache-control": cache }, readFileSync(file));
}

export function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  const indexFile = join(root, "index.html");
  if (!existsSync(indexFile)) return false;
  const target = resolveTarget(root, pathname);
  if (target === null) {
    sendNotFound(res);
    return true;
  }
  // Hashed asset names never collide, so they cache forever.
  if (pathname.startsWith("/assets/")) {
    if (!isFile(target)) {
      sendNotFound(res);
      return true;
    }
    sendFile(res, target, CACHE_IMMUTABLE);
    return true;
  }
  if (isFile(target)) {
    sendFile(res, target, CACHE_REVALIDATE);
    return true;
  }
  sendFile(res, indexFile, CACHE_REVALIDATE);
  return true;
}
