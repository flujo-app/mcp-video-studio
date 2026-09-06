import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "@mcp-video-studio/media";
import { StudioRuntime } from "../packages/server/src/runtime.js";
import { startGateway } from "../packages/server/src/gateway.js";
import { startMcpHttp } from "../packages/server/src/http.js";

const mcpToken = "mcp-fixture-token-01234567890123456789";
const uiToken = "ui-fixture-token-01234567890123456789";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup.length = 0; });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-http-"));
  const runtime = new StudioRuntime(loadConfig({ VIDEO_STUDIO_DATA_DIR: root, VIDEO_STUDIO_MCP_TOKEN: mcpToken }));
  await runtime.initialize();
  const gateway = await startGateway(runtime, uiToken);
  const http = await startMcpHttp(runtime, gateway, 0, "127.0.0.1");
  cleanup.push(async () => { await http.close(); await gateway.close(); await runtime.jobs.close(); await rm(root, { recursive: true, force: true }); });
  return { root, runtime, gateway, http };
}
const modern = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
function headers(extra: Record<string, string> = {}) {
  return { authorization: "Bearer " + mcpToken, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list", ...extra };
}
function catalog(extra: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: headers(extra), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: modern } }) };
}
describe("actual HTTP and gateway access boundaries", () => {
  it("requires separate MCP bearer authorization and validates Host/Origin before dispatch", async () => {
    const { http, gateway } = await fixture();
    expect((await fetch(http.url, catalog({ authorization: "" }))).status).toBe(401);
    expect((await fetch(http.url, catalog({ authorization: "Bearer " + uiToken }))).status).toBe(401);
    expect((await fetch(http.url + "?token=" + mcpToken, catalog({ authorization: "" }))).status).toBe(401);
    expect((await fetch(http.url, catalog({ origin: "https://hostile.invalid" }))).status).toBe(403);
    expect((await fetch(http.url, catalog({ origin: "null" }))).status).toBe(403);
    const hostileHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(http.url, { method: 'POST', headers: headers({ host: 'hostile.invalid' }) }, res => { res.resume(); res.once('end', () => resolve(res.statusCode ?? 0)); });
      req.once('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modern } }));
    });
    expect(hostileHost).toBe(421);
    const good = await fetch(http.url, catalog({ origin: new URL(http.url).origin }));
    expect(good.status).toBe(200);
    const payload = await good.text(); expect(payload).toContain("open_studio"); expect(payload).not.toContain(mcpToken);
    expect((await fetch(gateway.origin + "/api/projects?token=" + uiToken, { headers: { origin: "https://hostile.invalid" } })).status).toBe(403);
    expect((await fetch(gateway.origin + "/api/projects", { headers: { authorization: "Bearer " + mcpToken } })).status).toBe(401);
    expect((await fetch(gateway.origin + "/api/projects", { headers: { authorization: "Bearer " + uiToken, origin: gateway.origin } })).status).toBe(200);
    expect((await fetch(gateway.origin + "/api/project/create?token=" + uiToken, { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"untrusted"}' })).status).toBe(401);
  });
  it("rejects malformed and oversized JSON before invoking tools", async () => {
    const { http } = await fixture();
    expect((await fetch(http.url, { method: "POST", headers: headers(), body: "{" })).status).toBe(400);
    expect((await fetch(http.url, { method: "POST", headers: headers(), body: "x".repeat(2_000_001) })).status).toBe(413);
    expect((await fetch(http.url, { method: "POST", headers: headers({ "content-type": "text/plain" }), body: "{}" })).status).toBe(415);
  });
  for (const mode of ["auto", "legacy"] as const) {
    it("serves real SDK " + mode + " clients, revision-safe edits and MCP Apps resources", async () => {
      const { http } = await fixture();
      const clients = await Promise.all([1, 2].map(async i => {
        const client = new Client({ name: "fixture-" + i, version: "1" }, { versionNegotiation: { mode } });
        await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { authorization: "Bearer " + mcpToken } } }));
        return client;
      }));
      try {
        for (const client of clients) {
          expect(client.getProtocolEra()).toBe(mode === "auto" ? "modern" : "legacy");
          expect(client.getServerVersion()?.version).toBe("0.1.1");
          expect((await client.listTools()).tools.length).toBeGreaterThan(40);
        }
        const created = await clients[0]!.callTool({ name: "create_project", arguments: { name: "HTTP fixture" } });
        expect(created.isError).not.toBe(true);
        const data = created.structuredContent as { projectPath: string; project: { revision: number } };
        const first = await clients[0]!.callTool({ name: "apply_timeline_transaction", arguments: { projectPath: data.projectPath, expectedRevision: data.project.revision, commands: [{ type: "project.rename", name: "New name" }] } });
        expect(first.isError).not.toBe(true);
        const stale = await clients[1]!.callTool({ name: "apply_timeline_transaction", arguments: { projectPath: data.projectPath, expectedRevision: data.project.revision, commands: [{ type: "project.rename", name: "Lost update" }] } });
        expect(stale.isError).toBe(true); expect(JSON.stringify(stale)).toContain("REVISION_CONFLICT");
        const resource = await clients[0]!.readResource({ uri: "ui://mcp-video-studio/studio-v1.html" });
        expect(resource.contents[0]?.mimeType).toBe("text/html;profile=mcp-app");
        expect(resource.contents[0]?._meta).toHaveProperty("ui");
        expect(JSON.stringify(resource)).not.toContain(mcpToken);
      } finally { await Promise.all(clients.map(client => client.close())); }
    });
  }
});
