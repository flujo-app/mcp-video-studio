import { randomBytes } from "node:crypto";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "@mcp-video-studio/media";
import { startGateway } from "./gateway.js";
import { startMcpHttp } from "./http.js";
import { createMcpServer } from "./mcp.js";
import { StudioRuntime } from "./runtime.js";
import { validateToken } from "./security.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv[2] === "doctor") {
    const runtime = new StudioRuntime(config);
    await runtime.initialize();
    process.stdout.write(`${JSON.stringify(await runtime.doctor(), null, 2)}\n`);
    return;
  }
  if (process.argv.includes("--http") && !config.mcpToken) throw new Error("VIDEO_STUDIO_MCP_TOKEN is required for HTTP mode.");
  const configuredToken = process.env.VIDEO_STUDIO_GATEWAY_TOKEN?.trim();
  const gatewayToken = configuredToken ? validateToken(configuredToken) : randomBytes(32).toString("hex");
  const runtime = new StudioRuntime(config);
  await runtime.initialize();
  const gateway = await startGateway(runtime, gatewayToken);
  process.stderr.write(`mcp-video-studio editor: ${gateway.origin} (use open_studio for access)\n`);
  let closeTransport: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = () => closing ??= (async () => {
    // Abort owned jobs immediately; gateway thumbnail decoders also need time to close.
    // A stdio client may terminate this process while waiting for EOF shutdown.
    await Promise.all([
      runtime.jobs.close(),
      closeTransport?.(),
      gateway.close().catch(() => undefined),
    ]);
  })();
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  if (process.argv.includes("--http")) {
    const port = Number(process.env.VIDEO_STUDIO_MCP_PORT || 8787);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("VIDEO_STUDIO_MCP_PORT must be an integer from 0 to 65535.");
    const http = await startMcpHttp(runtime, gateway, port, config.gatewayHost);
    closeTransport = http.close;
    process.stderr.write(`mcp-video-studio MCP: ${http.url}\n`);
  } else {
    const handle = serveStdio(() => createMcpServer(runtime, gateway));
    closeTransport = handle.close;
    process.stdin.once("end", () => void shutdown());
  }
}
main().catch(error => {
  process.stderr.write(`mcp-video-studio: ${error instanceof Error && /^VIDEO_STUDIO_|^Studio access tokens/.test(error.message) ? error.message : "Startup failed; run doctor to inspect configuration and dependencies."}\n`);
  process.exitCode = 1;
});
