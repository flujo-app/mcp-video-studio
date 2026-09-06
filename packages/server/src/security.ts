import { timingSafeEqual, createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export function validateToken(value: string): string {
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(value)) throw new Error("Studio access tokens must contain 32-512 URL-safe characters.");
  return value;
}
export function tokenMatches(value: string | undefined, expected: string): boolean {
  if (!value || value.length > 512) return false;
  return timingSafeEqual(createHash("sha256").update(value).digest(), createHash("sha256").update(expected).digest());
}
export function httpOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("Public/allowed origins must be bare HTTP(S) origins.");
  return url.origin;
}
export function hostAuthorities(host: string, port: number, extras: string[] = []): Set<string> {
  const bare = host.replace(/^\[|\]$/g, "");
  const names = ["0.0.0.0", "::", "127.0.0.1", "localhost", "::1"].includes(bare) ? ["127.0.0.1", "localhost", "[::1]"] : [bare.includes(":") ? "[" + bare + "]" : bare];
  return new Set([...names.map(name => new URL("http://" + name + ":" + port).host), ...extras.map(value => {
    const parsed = new URL("http://" + value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("Allowed hosts must be exact host[:port] authorities.");
    return parsed.host;
  })].map(value => value.toLowerCase()));
}
export function requestBoundary(req: IncomingMessage, res: ServerResponse, hosts: Set<string>, origins: Set<string>): boolean {
  const host = req.headers.host?.toLowerCase();
  if (!host || !hosts.has(host)) { res.writeHead(421).end("Invalid Host"); return false; }
  const origin = req.headers.origin;
  if (origin) {
    let normalized: string;
    try { normalized = httpOrigin(origin); } catch { res.writeHead(403).end("Invalid Origin"); return false; }
    if (!origins.has(normalized)) { res.writeHead(403).end("Invalid Origin"); return false; }
  }
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");
  return true;
}
export async function jsonBody(req: IncomingMessage, maxBytes = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    const data = Buffer.from(chunk); bytes += data.length;
    if (bytes > maxBytes) throw Object.assign(new Error("Request body exceeds the configured limit."), { statusCode: 413 });
    chunks.push(data);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; }
  catch { throw Object.assign(new Error("Invalid JSON request body."), { statusCode: 400 }); }
}
