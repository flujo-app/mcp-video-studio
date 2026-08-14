import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mediaPath } from "@mcp-video-studio/media";
import { asStudioError } from "@mcp-video-studio/core";
import type { ProjectCommand } from "@mcp-video-studio/contracts";
import type { StudioRuntime } from "./runtime.js";

interface JsonBody { [key: string]: unknown }

function json(res: ServerResponse, status: number, value: unknown): void {
  const data = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
  res.end(data);
}

async function body(req: IncomingMessage): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 2_000_000) throw new Error("Request body exceeds 2 MB.");
    chunks.push(buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonBody : {};
}

export interface Gateway {
  origin: string;
  token: string;
  close(): Promise<void>;
}

export async function startGateway(runtime: StudioRuntime, token: string): Promise<Gateway> {
  const studioDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "studio");
  const clients = new Set<ServerResponse>();
  const unsubscribe = runtime.jobs.subscribe((job) => {
    const event = `event: job\ndata: ${JSON.stringify(job)}\n\n`;
    for (const client of clients) client.write(event);
  });

  const server = createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
      const url = new URL(req.url ?? "/", origin);
      const supplied = url.searchParams.get("token") || req.headers.authorization?.replace(/^Bearer\s+/i, "");
      const isAsset = url.pathname === "/app.js" || url.pathname === "/app.css" || url.pathname === "/favicon.ico";
      if (!isAsset && supplied !== token) { json(res, 401, { success: false, error: { code: "UNAUTHORIZED", message: "Invalid gateway token." } }); return; }

      if (req.method === "GET" && url.pathname === "/") {
        const html = (await readFile(path.join(studioDir, "index.html"), "utf8")).replace("<body>", `<body data-token="${token}">`);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self';", "cache-control": "no-store" });
        res.end(html); return;
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        const source = await readFile(path.join(studioDir, "app.js"));
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": source.length, "cache-control": "no-cache" });
        res.end(source); return;
      }
      if (req.method === "GET" && url.pathname === "/app.css") {
        const source = await readFile(path.join(studioDir, "app.css"));
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "content-length": source.length, "cache-control": "no-cache" });
        res.end(source); return;
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: ready\ndata: {}\n\n`);
        clients.add(res); req.once("close", () => clients.delete(res)); return;
      }
      if (req.method === "GET" && url.pathname === "/api/projects") { json(res, 200, await runtime.listProjects()); return; }
      if (req.method === "GET" && url.pathname === "/api/project") { json(res, 200, await runtime.getProject(url.searchParams.get("projectPath") ?? "")); return; }
      if (req.method === "GET" && url.pathname === "/api/jobs") { json(res, 200, { success: true, jobs: runtime.jobs.list() }); return; }
      if (req.method === "GET" && url.pathname === "/api/providers") { json(res, 200, await runtime.getProviderStatus()); return; }
      if (req.method === "GET" && url.pathname === "/api/generated") { json(res, 200, await runtime.listGeneratedArtifacts(url.searchParams.get("projectPath") ?? "")); return; }
      if (req.method === "GET" && url.pathname === "/media") { await serveMedia(runtime, url, req, res); return; }
      if (req.method === "GET" && url.pathname === "/preview") { await servePreview(runtime, url, req, res); return; }

      if (req.method === "POST") {
        const input = await body(req);
        if (url.pathname === "/api/project/create") { json(res, 200, await runtime.createProject(String(input.name ?? "Untitled project"), typeof input.projectPath === "string" ? input.projectPath : undefined)); return; }
        if (url.pathname === "/api/commands") { json(res, 200, await runtime.apply(String(input.projectPath), Number(input.expectedRevision), input.commands as ProjectCommand[])); return; }
        if (url.pathname === "/api/undo") { json(res, 200, await runtime.undo(String(input.projectPath), Number(input.expectedRevision))); return; }
        if (url.pathname === "/api/redo") { json(res, 200, await runtime.redo(String(input.projectPath), Number(input.expectedRevision))); return; }
        if (url.pathname === "/api/import") { json(res, 200, await runtime.import({ projectPath: String(input.projectPath), filePath: String(input.filePath), expectedRevision: Number(input.expectedRevision), storageMode: input.storageMode === "linked" ? "linked" : "managed" })); return; }
        if (url.pathname === "/api/generate") {
          const common = { projectPath: String(input.projectPath), expectedRevision: Number(input.expectedRevision), sequenceId: String(input.sequenceId), trackId: String(input.trackId), startTick: Number(input.startTick), durationTick: Number(input.durationTick), name: String(input.name), ...(typeof input.clipId === "string" && input.clipId ? { clipId: input.clipId } : {}) };
          const kind = String(input.kind);
          if (kind === "narration") { json(res, 202, await runtime.generateNarration({ ...common, text: String(input.text ?? input.prompt ?? ""), provider: input.provider === "elevenlabs" ? "elevenlabs" : "openai", ...(typeof input.model === "string" && input.model ? { model: input.model } : {}), ...(typeof input.voiceId === "string" && input.voiceId ? { voiceId: input.voiceId } : {}), ...(typeof input.language === "string" && input.language ? { language: input.language } : {}) })); return; }
          if (kind === "music") { json(res, 202, await runtime.generateMusic({ ...common, prompt: String(input.prompt ?? ""), ...(typeof input.model === "string" && input.model ? { model: input.model } : {}) })); return; }
          if (kind === "captions") { json(res, 202, await runtime.generateCaptions({ projectPath: common.projectPath, expectedRevision: common.expectedRevision, sequenceId: common.sequenceId, trackId: common.trackId, startTick: common.startTick, durationTick: common.durationTick, name: common.name, sourceMediaId: String(input.sourceMediaId ?? ""), provider: input.provider === "elevenlabs" ? "elevenlabs" : "openai", ...(typeof input.model === "string" && input.model ? { model: input.model } : {}), ...(typeof input.language === "string" && input.language ? { language: input.language } : {}) })); return; }
          if (kind === "animation") { json(res, 202, await runtime.generateAnimation({ ...common, prompt: String(input.prompt ?? ""), ...(typeof input.model === "string" && input.model ? { model: input.model } : {}) })); return; }
          throw new Error(`Unknown generation kind: ${kind}`);
        }
        if (url.pathname === "/api/generated/regenerate") { json(res, 202, await runtime.regenerateGeneratedArtifact({ projectPath: String(input.projectPath), expectedRevision: Number(input.expectedRevision), artifactId: String(input.artifactId), ...(input.requestPatch && typeof input.requestPatch === "object" ? { requestPatch: input.requestPatch as never } : {}) })); return; }
        if (url.pathname === "/api/generated/review") { json(res, 200, await runtime.reviewGeneratedVersion({ projectPath: String(input.projectPath), expectedRevision: Number(input.expectedRevision), artifactId: String(input.artifactId), versionId: String(input.versionId), action: input.action === "approve" ? "approve" : input.action === "reject" ? "reject" : "activate", reviewer: String(input.reviewer || "Studio user"), ...(typeof input.note === "string" && input.note ? { note: input.note } : {}) })); return; }
        if (url.pathname === "/api/preview") { json(res, 202, await runtime.renderPreview({ projectPath: String(input.projectPath), sequenceId: String(input.sequenceId) })); return; }
        if (url.pathname === "/api/render") { json(res, 202, await runtime.render({ projectPath: String(input.projectPath), sequenceId: String(input.sequenceId), presetId: String(input.presetId), outputPath: String(input.outputPath) })); return; }
        if (url.pathname === "/api/qc") { json(res, 202, await runtime.qc({ projectPath: String(input.projectPath), sequenceId: String(input.sequenceId), filePath: String(input.filePath) })); return; }
        if (url.pathname === "/api/jobs/cancel") { json(res, 200, { success: true, job: await runtime.jobs.cancel(String(input.jobId)) }); return; }
      }
      json(res, 404, { success: false, error: { code: "NOT_FOUND", message: "Route not found." } });
    } catch (error) {
      json(res, 400, { success: false, error: asStudioError(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.config.gatewayPort, runtime.config.gatewayHost, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway failed to bind a TCP port.");
  const origin = runtime.config.publicOrigin ?? `http://${runtime.config.gatewayHost}:${address.port}`;
  return {
    origin, token,
    close: async () => { unsubscribe(); for (const client of clients) client.end(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

async function serveMedia(runtime: StudioRuntime, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const store = runtime.store(url.searchParams.get("projectPath") ?? "");
  const project = await store.read();
  const mediaId = url.searchParams.get("mediaId") ?? "";
  const asset = project.media.find((candidate) => candidate.id === mediaId);
  if (!asset) { json(res, 404, { success: false, error: { code: "MEDIA_NOT_FOUND", message: `Media not found: ${mediaId}` } }); return; }
  const kind = url.searchParams.get("kind") ?? "source";
  let filePath = mediaPath(store, asset);
  if (kind === "proxy") filePath = path.join(store.root, "proxies", mediaId, "preview.mp4");
  else if (kind === "thumbnail") {
    const directory = path.join(store.root, "proxies", mediaId);
    filePath = path.join(directory, "thumb-0.png");
    const exact = await stat(filePath).then((info) => info.isFile()).catch(() => false);
    if (!exact) {
      const fallback = (await readdir(directory).catch(() => [])).filter((name) => /^thumb-\d+\.png$/.test(name)).sort()[0];
      if (fallback) filePath = path.join(directory, fallback);
    }
  }
  else if (kind === "waveform") filePath = path.join(store.root, "proxies", mediaId, "waveform.png");
  await serveFile(filePath, kind === "thumbnail" || kind === "waveform" ? "image/png" : asset.kind === "audio" ? "audio/*" : "video/mp4", req, res, "private, max-age=3600");
}

async function servePreview(runtime: StudioRuntime, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const store = runtime.store(url.searchParams.get("projectPath") ?? "");
  const project = await store.read();
  const sequenceId = url.searchParams.get("sequenceId") ?? "";
  if (!project.sequences.some((sequence) => sequence.id === sequenceId)) {
    json(res, 404, { success: false, error: { code: "SEQUENCE_NOT_FOUND", message: `Sequence not found: ${sequenceId}` } }); return;
  }
  const revision = Number(url.searchParams.get("revision"));
  if (!Number.isSafeInteger(revision) || revision < 0) {
    json(res, 400, { success: false, error: { code: "INVALID_REVISION", message: "A non-negative integer revision is required." } }); return;
  }
  await serveFile(path.join(store.root, "cache", "previews", `${sequenceId}-r${revision}.mp4`), "video/mp4", req, res, "private, max-age=31536000, immutable");
}

async function serveFile(filePath: string, contentType: string, req: IncomingMessage, res: ServerResponse, cacheControl: string): Promise<void> {
  const info = await stat(filePath);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "content-type": contentType, "content-length": info.size, "accept-ranges": "bytes", "cache-control": cacheControl });
    createReadStream(filePath).pipe(res); return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { "content-range": `bytes */${info.size}` }); res.end(); return; }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
  if (start > end || start >= info.size) { res.writeHead(416, { "content-range": `bytes */${info.size}` }); res.end(); return; }
  res.writeHead(206, { "content-type": contentType, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}`, "accept-ranges": "bytes", "cache-control": cacheControl });
  createReadStream(filePath, { start, end }).pipe(res);
}
