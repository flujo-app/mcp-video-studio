import { createServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Gateway } from "./gateway.js";
import { createMcpServer } from "./mcp.js";
import type { StudioRuntime } from "./runtime.js";
import { hostAuthorities, httpOrigin, jsonBody, requestBoundary, tokenMatches, validateToken } from "./security.js";

export async function startMcpHttp(runtime: StudioRuntime, gateway: Gateway, port: number, host: string): Promise<{ url: string; close(): Promise<void> }> {
  const token = runtime.config.mcpToken;
  if (!token) throw new Error("VIDEO_STUDIO_MCP_TOKEN is required for HTTP mode (32-512 URL-safe characters).");
  validateToken(token);
  let hosts = new Set<string>();
  const origins = new Set([httpOrigin(gateway.origin), ...(runtime.config.allowedOrigins ?? []).map(httpOrigin)]);
  const handler = toNodeHandler(createMcpHandler(() => createMcpServer(runtime, gateway), { legacy: "stateless" }));
  let active = 0;
  const http = createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    if (!requestBoundary(req, res, hosts, origins)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/mcp") { res.writeHead(404).end(); return; }
    if (req.headers.origin) {
      res.setHeader("access-control-allow-origin", req.headers.origin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Mcp-Method, Mcp-Name" }).end(); return;
    }
    const supplied = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
    if (!tokenMatches(supplied, token)) { res.writeHead(401, { "www-authenticate": "Bearer" }).end("Unauthorized"); return; }
    if (active >= 32) { res.writeHead(503, { "retry-after": "1" }).end("Too many active requests"); return; }
    active++;
    try {
      if (req.method === "POST" && !req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        res.writeHead(415).end("Content-Type must be application/json"); return;
      }
      const parsed = req.method === "POST" ? await jsonBody(req) : undefined;
      if (!req.method || !req.url) { res.writeHead(400).end("Invalid HTTP request"); return; }
      await handler(Object.assign(req, { method: req.method, url: req.url }), res, parsed);
    } catch (error) {
      const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: status === 400 ? -32700 : -32603, message: status === 413 ? "Request too large" : status === 400 ? "Invalid JSON" : "Internal server error" } }));
      else res.destroy();
    } finally { active--; }
  });
  http.maxConnections = 64;
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, host, resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("MCP HTTP server did not bind a TCP port.");
  hosts = hostAuthorities(host, address.port, runtime.config.allowedHosts);
  for (const authority of hostAuthorities(host, address.port)) origins.add(new URL("http://" + authority).origin);
  const bindName = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
  return { url: `http://${bindName}:${address.port}/mcp`, close: async () => {
    http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
  } };
}
