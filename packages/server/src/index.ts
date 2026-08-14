import { randomBytes } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "@mcp-video-studio/media";
import { startGateway } from "./gateway.js";
import { startMcpHttp } from "./http.js";
import { createMcpServer } from "./mcp.js";
import { StudioRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (process.argv[2] === "doctor") {
    const runtime = new StudioRuntime(config);
    await runtime.initialize();
    process.stdout.write(`${JSON.stringify(await runtime.doctor(), null, 2)}\n`);
    return;
  }
  const runtime = new StudioRuntime(config);
  await runtime.initialize();
  const configuredToken = process.env.VIDEO_STUDIO_GATEWAY_TOKEN?.trim();
  const gateway = await startGateway(runtime, configuredToken && configuredToken.length >= 32 ? configuredToken : randomBytes(32).toString("hex"));
  process.stderr.write(`mcp-video-studio editor: ${gateway.origin}/?token=${gateway.token}\n`);

  const shutdown = async () => { await gateway.close().catch(() => undefined); };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  if (process.argv.includes("--http")) {
    const port = Number(process.env.VIDEO_STUDIO_MCP_PORT || 8787);
    const http = await startMcpHttp(runtime, gateway, port, config.gatewayHost);
    process.stderr.write(`mcp-video-studio MCP: ${http.url}\n`);
    return;
  }
  const server = createMcpServer(runtime, gateway);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`mcp-video-studio fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
