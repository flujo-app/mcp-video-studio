import { secretVariants } from "../packages/server/src/generation-privacy.js";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { loadConfig, importMedia } from "@mcp-video-studio/media";
import {
  secondsToTicks,
  defaultTransform,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { StudioRuntime } from "../packages/server/src/runtime.js";
import { startGateway } from "../packages/server/src/gateway.js";
import { startMcpHttp } from "../packages/server/src/http.js";
export const providerSecret = "fixture-provider-canary-7c56d9",
  mcpToken = "fixture-mcp-token-123456789012345678901234",
  uiToken = "fixture-ui-token-123456789012345678901234";
export function wav(seconds = 4) {
  const rate = 48000,
    data = Buffer.alloc(44 + Math.round(rate * seconds) * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < (data.length - 44) / 2; i++)
    data.writeInt16LE(
      Math.round(
        8000 *
          Math.sin(
            (2 * Math.PI * (220 * 2 ** Math.floor(i / rate)) * i) / rate,
          ),
      ),
      44 + i * 2,
    );
  return data;
}
function encodeFixtureJson(value: unknown, mode: string) {
  let text = JSON.stringify(value);
  if (mode === "echo-encoded")
    text = text.replaceAll(
      providerSecret,
      Buffer.from(providerSecret).toString("base64"),
    );
  if (mode === "echo-mislabel")
    text = text.replaceAll(providerSecret, "\\u0066" + providerSecret.slice(1));
  return text;
}
export async function until(
  check: () => boolean | Promise<boolean>,
  timeout = 30000,
) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Generation fixture timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
export async function generationFixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "studio-generation-live-fixture-"),
  );
  let mode = "ok",
    gate: (() => void) | undefined;
  const calls: Array<{ url: string; body: Buffer }> = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(Buffer.from(p));
    const body = Buffer.concat(parts),
      url = req.url ?? "";
    calls.push({ url, body });
    if (mode === "hold") {
      await new Promise<void>((resolve) => (gate = resolve));
    }
    if (mode === "error") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: providerSecret }));
      return;
    }
    if (url.includes("speech-to-text") || url.includes("transcriptions")) {
      const text = mode.startsWith("echo")
        ? providerSecret
        : "Fixture caption.";
      res.writeHead(200, {
        "content-type":
          mode === "echo-mislabel"
            ? "application/octet-stream"
            : "application/json",
        "x-request-id": providerSecret,
      });
      res.end(
        encodeFixtureJson(
          {
            text,
            words: [{ text, word: text, start: 0, end: 0.8, type: "word" }],
          },
          mode,
        ),
      );
    } else if (url.includes("responses") || url.includes("chat/completions")) {
      const text = mode.startsWith("echo") ? providerSecret : "Generated shape";
      const animation = {
        id: "provider",
        name: text,
        mode: "declarative",
        durationTick: secondsToTicks(1),
        canvas: { width: 320, height: 180, background: "transparent" },
        seed: 1,
        nodes: [
          {
            id: "box",
            name: text,
            type: "rect",
            properties: { width: 100, height: 80, fill: "#ff0044" },
            transform: { ...defaultTransform(), position: [160, 90] },
          },
        ],
        operations: [],
      };
      res.writeHead(200, {
        "content-type":
          mode === "echo-mislabel"
            ? "application/octet-stream"
            : "application/json",
        "x-request-id": providerSecret,
      });
      res.end(
        encodeFixtureJson(
          {
            output_text: JSON.stringify(animation),
            choices: [{ message: { content: JSON.stringify(animation) } }],
          },
          mode,
        ),
      );
    } else {
      res.writeHead(200, {
        "content-type": "audio/wav",
        "request-id": providerSecret,
      });
      res.end(
        mode.startsWith("echo")
          ? Buffer.concat([
              wav(),
              Buffer.from(
                mode === "echo-encoded"
                  ? Buffer.from(providerSecret).toString("base64")
                  : providerSecret,
              ),
            ])
          : wav(),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const config = loadConfig({
    VIDEO_STUDIO_DATA_DIR: root,
    VIDEO_STUDIO_OPENAI_BASE_URL: base,
    VIDEO_STUDIO_ELEVENLABS_BASE_URL: base,
    VIDEO_STUDIO_LANGUAGE_BASE_URL: base,
    VIDEO_STUDIO_OPENAI_API_KEY: providerSecret,
    VIDEO_STUDIO_ELEVENLABS_API_KEY: providerSecret,
    VIDEO_STUDIO_ELEVENLABS_VOICE_ID: "fixture-voice",
    VIDEO_STUDIO_MCP_TOKEN: mcpToken,
    VIDEO_STUDIO_MAX_CONCURRENT_JOBS: "1",
  });
  const runtime = new StudioRuntime(config);
  await runtime.initialize();
  const created = await runtime.createProject("Generation acceptance"),
    projectPath = String(created.projectPath),
    store = runtime.store(projectPath);
  await store.replace(
    0,
    (draft) => {
      draft.settings.raster = { width: 320, height: 180 };
    },
    {
      sequences: [],
      tracks: [],
      clips: [],
      media: [],
      animations: [],
      generatedArtifacts: [],
    },
  );
  const source = path.join(root, "source.wav");
  await writeFile(source, wav());
  const imported = await importMedia(store, source, "managed", 1, config);
  const gateway = await startGateway(runtime, uiToken),
    http = await startMcpHttp(runtime, gateway, 0, "127.0.0.1");
  const clients: Client[] = [];
  return {
    root,
    config,
    runtime,
    store,
    projectPath,
    sourceMediaId: imported.asset.media.id,
    gateway,
    http,
    calls,
    get mode() {
      return mode;
    },
    set mode(v: string) {
      mode = v;
    },
    release() {
      gate?.();
      gate = undefined;
    },
    async client(mode: "auto" | "legacy" = "auto") {
      const client = new Client(
        { name: "generation-session", version: "1" },
        { versionNegotiation: { mode } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(http.url), {
          requestInit: { headers: { authorization: "Bearer " + mcpToken } },
        }),
      );
      clients.push(client);
      return client;
    },
    async call(client: Client, name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result));
      return result.structuredContent as Record<string, any>;
    },
    async done(id: string) {
      await until(() =>
        ["completed", "failed", "cancelled"].includes(
          runtime.jobs.get(id)?.status ?? "",
        ),
      );
      const job = runtime.jobs.get(id)!;
      if (job.status !== "completed") throw new Error(JSON.stringify(job));
      return job;
    },
    async close() {
      gate?.();
      await Promise.allSettled(clients.map((c) => c.close()));
      await http.close();
      await gateway.close();
      await runtime.jobs.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
export async function secretFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await secretFiles(file)));
    else if (entry.isFile()) {
      const data = await readFile(file);
      if (
        secretVariants([providerSecret]).some((secret) => data.includes(secret))
      )
        found.push(file);
    }
  }
  return found;
}
export function generationInput(
  project: StudioProject,
  kind: string,
  sourceMediaId: string,
) {
  const sequence = project.sequences[0]!,
    track = sequence.tracks.find((t) =>
      kind === "captions"
        ? t.type === "caption"
        : kind === "animation"
          ? t.type === "overlay" || t.type === "video"
          : t.type === "audio",
    )!;
  return {
    expectedRevision: project.revision,
    sequenceId: sequence.id,
    trackId: track.id,
    startTick: 0,
    durationTick: secondsToTicks(4),
    name: "Fixture " + kind,
    ...(kind === "narration"
      ? { provider: "openai", text: "First narration." }
      : kind === "music"
        ? { prompt: "Instrumental fixture." }
        : kind === "captions"
          ? { provider: "elevenlabs", sourceMediaId }
          : { prompt: "A red rectangle." }),
  };
}
