import {listExportHistory,getExportHistory,queueExport} from './provenance.js';
import {queueArchive,listArchiveJobs} from './archive-jobs.js';
import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { invokeFeature, featureSchemas, type FeatureName } from "./features.js";
import { exportProjectArchive, importProjectArchive, inspectProjectArchive } from "./archive.js";
import { hostAuthorities, httpOrigin, jsonBody, requestBoundary, tokenMatches, validateToken } from "./security.js";
import { fileURLToPath } from "node:url";
import { mediaPath, TimelineTiles, type TimelineTileKind } from "@mcp-video-studio/media";
import { confinedPath, asStudioError } from "@mcp-video-studio/core";
import type { ProjectCommand } from "@mcp-video-studio/contracts";
import type { StudioRuntime } from "./runtime.js";

interface JsonBody { [key: string]: unknown }

function json(res: ServerResponse, status: number, value: unknown): void {
  const data = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
  res.end(data);
}

async function body(req: IncomingMessage): Promise<JsonBody> {
  const value = await jsonBody(req);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
  return value as JsonBody;
}

export interface Gateway {
  origin: string;
  token: string;
  close(): Promise<void>;
}

export async function startGateway(runtime: StudioRuntime, token: string): Promise<Gateway> {
  validateToken(token);
  const timelineTiles=new TimelineTiles(runtime.config);
  let hosts = new Set<string>();
  let allowedOrigins = new Set<string>();
  const studioDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "studio");
  const clients = new Set<ServerResponse>();
  const unsubscribe = runtime.jobs.subscribe((job) => {
    const event = `event: job\ndata: ${JSON.stringify(job)}\n\n`;
    for (const client of clients) { if (client.writableLength > 256_000 || !client.write(event)) { client.end(); clients.delete(client); } }
  });

  const server = createServer({ maxHeaderSize: 16384, requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
    if (!requestBoundary(req, res, hosts, allowedOrigins)) return;
    try {
      const origin = "http://localhost";
      const url = new URL(req.url ?? "/", origin);
      const supplied = (req.method === "GET" || req.method === "HEAD" ? url.searchParams.get("token") : null) || req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
      const isAsset = url.pathname === "/app.js" || url.pathname === "/app.css" || url.pathname === "/favicon.ico";
      const isShell = req.method === "GET" && url.pathname === "/";
      if (!isAsset && !isShell && !tokenMatches(supplied ?? undefined, token)) { json(res, 401, { success: false, error: { code: "UNAUTHORIZED", message: "Invalid gateway token." } }); return; }

      if (req.method === "GET" && url.pathname === "/") {
        const html = await readFile(path.join(studioDir, "index.html"), "utf8");
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
        if (clients.size >= 32) { json(res, 503, { success: false, error: { code: "TOO_MANY_STREAMS", message: "Too many event streams." } }); return; }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: ready\ndata: {}\n\n`);
        clients.add(res); req.once("close", () => clients.delete(res)); return;
      }
      if(req.method === "GET" && url.pathname === "/api/archive/operations"){json(res,200,await listArchiveJobs(runtime.config));return;}
      if (req.method === "GET" && url.pathname === "/api/projects") { json(res, 200, await runtime.listProjects()); return; }
      if (req.method === "GET" && url.pathname === "/api/project") { json(res, 200, await runtime.getProject(url.searchParams.get("projectPath") ?? "")); return; }
      if (req.method === "GET" && url.pathname === "/api/jobs") { json(res, 200, { success: true, jobs: runtime.jobs.list() }); return; }
      if (req.method === "GET" && url.pathname === "/api/providers") { json(res, 200, await runtime.getProviderStatus()); return; }
      if (req.method === "GET" && url.pathname === "/api/generated") { json(res, 200, await runtime.listGeneratedArtifacts(url.searchParams.get("projectPath") ?? "")); return; }
      if (req.method === "GET" && url.pathname === "/media") { await serveMedia(runtime, timelineTiles, url, req, res); return; }
      if (req.method === "GET" && url.pathname === "/preview") { await servePreview(runtime, url, req, res); return; }

      if (req.method === "POST") {
        if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) { json(res, 415, { success: false, error: { code: "CONTENT_TYPE", message: "Content-Type must be application/json." } }); return; }
        const input = await body(req);
        if(url.pathname === "/api/archive/export"){json(res,200,await queueArchive(runtime,"export",{projectPath:String(input.projectPath),outputPath:String(input.outputPath),expectedRevision:Number(input.expectedRevision)}));return;}
        if(url.pathname === "/api/archive/inspect"){json(res,200,await inspectProjectArchive(String(input.filePath)));return;}
        if(url.pathname === "/api/archive/import"){json(res,200,await queueArchive(runtime,"import",{filePath:String(input.filePath),destinationPath:String(input.destinationPath)}));return;}

        if (url.pathname.startsWith("/api/features/")) { const name = url.pathname.slice("/api/features/".length); if (!Object.hasOwn(featureSchemas, name)) throw new Error("Unknown feature."); json(res, 200, await invokeFeature(runtime, name as FeatureName, input)); return; }
        if (url.pathname === "/api/project/create") { json(res, 200, await runtime.createProject(String(input.name ?? "Untitled project"), typeof input.projectPath === "string" ? input.projectPath : undefined)); return; }
        if (url.pathname === "/api/commands") { json(res, 200, await runtime.apply(String(input.projectPath), Number(input.expectedRevision), input.commands as ProjectCommand[])); return; }
        if (url.pathname === "/api/undo") { json(res, 200, await runtime.undo(String(input.projectPath), Number(input.expectedRevision))); return; }
        if (url.pathname === "/api/redo") { json(res, 200, await runtime.redo(String(input.projectPath), Number(input.expectedRevision))); return; }
        if (url.pathname === "/api/import") { json(res, 200, await runtime.import({ projectPath: String(input.projectPath), filePath: String(input.filePath), expectedRevision: Number(input.expectedRevision), storageMode: input.storageMode === "linked" ? "linked" : "managed" })); return; }
        if (url.pathname === "/api/generate") {
          const common = { autoActivate:input.autoActivate===true, projectPath: String(input.projectPath), expectedRevision: Number(input.expectedRevision), sequenceId: String(input.sequenceId), trackId: String(input.trackId), startTick: Number(input.startTick), durationTick: Number(input.durationTick), name: String(input.name), ...(typeof input.clipId === "string" && input.clipId ? { clipId: input.clipId } : {}) };
          const kind = String(input.kind);
          if (kind === "narration") { json(res, 202, await runtime.generateNarration({ ...common, text: String(input.text ?? input.prompt ?? ""), provider: input.provider === "elevenlabs" ? "elevenlabs" : "openai", ...(typeof input.model === "string" && input.model ? { model: input.model } : {}), ...(typeof input.voiceId === "string" && input.voiceId ? { voiceId: input.voiceId } : {}), ...(typeof input.language === "string" && input.language ? { language: input.language } : {}) })); return; }
          if (kind === "music") { json(res, 202, await runtime.generateMusic({ ...common, prompt: String(input.prompt ?? ""), ...(typeof input.model === "string" && input.model ? { model: input.model } : {}) })); return; }
          if (kind === "captions") { json(res, 202, await runtime.generateCaptions({ autoActivate:common.autoActivate, projectPath: common.projectPath, expectedRevision: common.expectedRevision, sequenceId: common.sequenceId, trackId: common.trackId, startTick: common.startTick, durationTick: common.durationTick, name: common.name, sourceMediaId: String(input.sourceMediaId ?? ""), provider: input.provider === "elevenlabs" ? "elevenlabs" : "openai", ...(typeof input.model === "string" && input.model ? { model: input.model } : {}), ...(typeof input.language === "string" && input.language ? { language: input.language } : {}) })); return; }
          if (kind === "animation") { json(res, 202, await runtime.generateAnimation({ ...common, prompt: String(input.prompt ?? ""), ...(typeof input.model === "string" && input.model ? { model: input.model } : {}) })); return; }
          throw new Error(`Unknown generation kind: ${kind}`);
        }
        if (url.pathname === "/api/generated/regenerate") { json(res, 202, await runtime.regenerateGeneratedArtifact({ projectPath: String(input.projectPath), expectedRevision: Number(input.expectedRevision), artifactId: String(input.artifactId), autoActivate:input.autoActivate===true, ...(typeof input.parentVersionId==="string"?{parentVersionId:input.parentVersionId}:{}), ...(input.region&&typeof input.region==="object"?{region:{offsetTick:Number((input.region as Record<string,unknown>).offsetTick),durationTick:Number((input.region as Record<string,unknown>).durationTick)}}:{}), ...(input.requestPatch && typeof input.requestPatch === "object" ? { requestPatch: input.requestPatch as never } : {}) })); return; }
        if (url.pathname === "/api/generated/review") { json(res, 200, await runtime.reviewGeneratedVersion({ projectPath: String(input.projectPath), expectedRevision: Number(input.expectedRevision), artifactId: String(input.artifactId), versionId: String(input.versionId), action: input.action === "approve" ? "approve" : input.action === "reject" ? "reject" : "activate", reviewer: String(input.reviewer || "Studio user"), ...(typeof input.note === "string" && input.note ? { note: input.note } : {}) })); return; }
        if (url.pathname === "/api/preview") { json(res, 202, await runtime.renderPreview({ projectPath: String(input.projectPath), sequenceId: String(input.sequenceId) })); return; }
        if(url.pathname === "/api/media/inspect"){json(res,200,await runtime.inspect(String(input.projectPath),Array.isArray(input.mediaIds)?input.mediaIds.map(String):undefined));return;}
        if(url.pathname === "/api/media/relink"){json(res,200,await runtime.relink({projectPath:String(input.projectPath),mediaId:String(input.mediaId),filePath:String(input.filePath),expectedRevision:Number(input.expectedRevision)}));return;}
        if(url.pathname === "/api/media/consolidate"){json(res,200,await runtime.queueConsolidation({projectPath:String(input.projectPath),expectedRevision:Number(input.expectedRevision),...(Array.isArray(input.mediaIds)?{mediaIds:input.mediaIds.map(String)}:{})}));return;}
        if(url.pathname==="/api/exports/history"){json(res,200,await listExportHistory(runtime.config,String(input.projectPath)));return;}
        if(url.pathname==="/api/exports/detail"){json(res,200,await getExportHistory(runtime.config,String(input.exportId)));return;}
        if(url.pathname==="/api/exports/reproduce"){json(res,202,await queueExport(runtime,{projectPath:String(input.projectPath),reproduceId:String(input.exportId),outputPath:String(input.outputPath),sequenceId:'',presetId:''}));return;}
        if (url.pathname === "/api/render") { json(res, 202, await runtime.render({ projectPath: String(input.projectPath), sequenceId: String(input.sequenceId), presetId: String(input.presetId), outputPath: String(input.outputPath) })); return; }
        if (url.pathname === "/api/qc") { json(res, 202, await runtime.qc({ projectPath: String(input.projectPath), sequenceId: String(input.sequenceId), filePath: String(input.filePath) })); return; }
        if (url.pathname === "/api/jobs/cancel") { json(res, 200, { success: true, job: await runtime.jobs.cancel(String(input.jobId)) }); return; }
      }
      json(res, 404, { success: false, error: { code: "NOT_FOUND", message: "Route not found." } });
    } catch (error) {
      if (!res.headersSent) json(res, typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 400, { success: false, error: asStudioError(error) });
      else res.destroy();
    }
  });

  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(runtime.config.gatewayPort, runtime.config.gatewayHost, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway failed to bind a TCP port.");
  const host = runtime.config.gatewayHost.includes(":") && !runtime.config.gatewayHost.startsWith("[") ? "[" + runtime.config.gatewayHost + "]" : runtime.config.gatewayHost;
  const origin = httpOrigin(runtime.config.publicOrigin ?? `http://${host}:${address.port}`);
  hosts = hostAuthorities(runtime.config.gatewayHost, address.port, [...(runtime.config.allowedHosts ?? []), ...(runtime.config.publicOrigin ? [new URL(origin).host] : [])]);
  allowedOrigins = new Set([origin, ...[...hostAuthorities(runtime.config.gatewayHost, address.port)].map(authority => new URL("http://" + authority).origin), ...(runtime.config.allowedOrigins ?? []).map(httpOrigin)]);
  return {
    origin, token,
    close: async () => { unsubscribe(); for (const client of clients) client.end(); server.closeAllConnections(); await timelineTiles.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

async function serveMedia(runtime: StudioRuntime, timelineTiles: TimelineTiles, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const store = runtime.store(url.searchParams.get("projectPath") ?? "");
  const project = await store.read();
  const mediaId = url.searchParams.get("mediaId") ?? "";
  const asset = project.media.find((candidate) => candidate.id === mediaId);
  if (!asset) { json(res, 404, { success: false, error: { code: "MEDIA_NOT_FOUND", message: `Media not found: ${mediaId}` } }); return; }
  const kind = url.searchParams.get("kind") ?? "source";
  if(kind==="timeline-thumbnail"||kind==="timeline-waveform"){
    const controller=new AbortController(),abort=()=>controller.abort();res.once("close",abort);
    try{const tile=await timelineTiles.get(store,asset,{kind:kind as TimelineTileKind,spanSeconds:Number(url.searchParams.get("spanSeconds")),index:Number(url.searchParams.get("index"))},controller.signal);if(!res.destroyed)await serveFile(tile,"image/png",req,res,"private, max-age=3600");}
    finally{res.removeListener("close",abort);}return;
  }
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
  await serveFile(kind === "source" && asset.storage.mode === "linked" ? filePath : confinedPath(store.root,filePath), kind === "thumbnail" || kind === "waveform" ? "image/png" : asset.kind === "audio" ? "audio/*" : "video/mp4", req, res, "private, max-age=3600");
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
  await serveFile(confinedPath(store.root,path.join(store.root, "cache", "previews", `${sequenceId}-r${revision}.mp4`)), "video/mp4", req, res, "private, max-age=31536000, immutable");
}

async function serveFile(filePath: string, contentType: string, req: IncomingMessage, res: ServerResponse, cacheControl: string): Promise<void> {
  const info = await stat(filePath);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "content-type": contentType, "content-length": info.size, "accept-ranges": "bytes", "cache-control": cacheControl });
    createReadStream(filePath).on("error", () => res.destroy()).pipe(res); return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { "content-range": `bytes */${info.size}` }); res.end(); return; }
  const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
  if ((!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) { res.writeHead(416, { "content-range": `bytes */${info.size}` }); res.end(); return; }
  res.writeHead(206, { "content-type": contentType, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}`, "accept-ranges": "bytes", "cache-control": cacheControl });
  createReadStream(filePath, { start, end }).on("error", () => res.destroy()).pipe(res);
}
