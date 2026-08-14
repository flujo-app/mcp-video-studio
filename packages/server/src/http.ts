import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Gateway } from "./gateway.js";
import { createMcpServer } from "./mcp.js";
import type { StudioRuntime } from "./runtime.js";

export async function startMcpHttp(runtime: StudioRuntime, gateway: Gateway, port: number, host: string): Promise<{ url: string; close(): Promise<void> }> {
  const http = createServer(async (req, res) => {
    if (new URL(req.url ?? "/", `http://${req.headers.host ?? host}`).pathname !== "/mcp") {
      res.writeHead(404).end(); return;
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    const server = createMcpServer(runtime, gateway);
    try {
      await server.connect(transport as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(req, res);
      res.once("close", () => { void transport.close(); void server.close(); });
    } catch (error) {
      process.stderr.write(`mcp-video-studio HTTP error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    }
  });
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(port, host, resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("MCP HTTP server did not bind a TCP port.");
  return { url: `http://${host}:${address.port}/mcp`, close: async () => new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())) };
}
