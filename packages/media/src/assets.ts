import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { type MediaAsset, type MutationResult, type ProjectDelta } from "@mcp-video-studio/contracts";
import { copyFileAtomic, ProjectStore, sha256File, StudioException } from "@mcp-video-studio/core";
import type { StudioConfig } from "./config.js";
import { mediaKindFor, probeMedia } from "./probe.js";

function emptyDelta(): ProjectDelta { return { sequences: [], tracks: [], clips: [], media: [], animations: [], generatedArtifacts: [] }; }

export interface ImportedAsset {
  media: MediaAsset;
  deduplicated: boolean;
}

export async function importMedia(store: ProjectStore, filePath: string, storageMode: "managed" | "linked", expectedRevision: number, config: StudioConfig, signal?: AbortSignal): Promise<{ mutation: MutationResult; asset: ImportedAsset }> {
  const source = path.resolve(filePath);
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile()) throw new StudioException("MEDIA_NOT_FOUND", `Media file not found: ${source}`, "input");
  const [{ sha256, bytes }, probe] = await Promise.all([sha256File(source), probeMedia(source, config, signal)]);
  const current = await store.read();
  const existing = current.media.find((media) => media.storage.sha256 === sha256);
  if (existing) {
    return {
      mutation: { success: true, projectId: current.projectId, revision: current.revision, transactionId: `dedupe:${existing.id}`, changed: emptyDelta(), warnings: ["The asset already exists in this project."] },
      asset: { media: existing, deduplicated: true }
    };
  }

  const extension = path.extname(source).toLowerCase() || ".bin";
  const id = randomUUID();
  let storage: MediaAsset["storage"];
  if (storageMode === "managed") {
    const relativePath = path.join("assets", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}${extension}`);
    const target = path.join(store.root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFileAtomic(source, target);
    storage = { mode: "managed", sha256, relativePath, bytes };
  } else {
    storage = { mode: "linked", path: source, sha256, bytes, mtimeMs: info.mtimeMs };
  }
  const media: MediaAsset = { id, name: path.basename(source), kind: mediaKindFor(source, probe), storage, probe, createdAt: new Date().toISOString() };
  const changed = emptyDelta(); changed.media.push(id);
  const mutation = await store.replace(expectedRevision, (project) => { project.media.push(media); }, changed);
  return { mutation, asset: { media, deduplicated: false } };
}

export function mediaPath(store: ProjectStore, media: MediaAsset): string {
  return media.storage.mode === "managed" ? path.join(store.root, media.storage.relativePath) : media.storage.path;
}

export async function relinkMedia(store: ProjectStore, mediaId: string, filePath: string, expectedRevision: number, config: StudioConfig, signal?: AbortSignal): Promise<{ mutation: MutationResult; media: MediaAsset }> {
  const source = path.resolve(filePath);
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile()) throw new StudioException("MEDIA_NOT_FOUND", `Media file not found: ${source}`, "input");
  const current = await store.read();
  const index = current.media.findIndex((media) => media.id === mediaId);
  if (index < 0) throw new StudioException("MEDIA_NOT_FOUND", `Media not found: ${mediaId}`, "input");
  const [{ sha256, bytes }, probe] = await Promise.all([sha256File(source), probeMedia(source, config, signal)]);
  const previous = current.media[index]!;
  const replacement: MediaAsset = {
    ...previous,
    name: path.basename(source),
    kind: mediaKindFor(source, probe),
    storage: { mode: "linked", path: source, sha256, bytes, mtimeMs: info.mtimeMs },
    probe,
    offline: false
  };
  const changed = emptyDelta(); changed.media.push(mediaId);
  const mutation = await store.replace(expectedRevision, (project) => { project.media[index] = replacement; }, changed);
  return { mutation, media: replacement };
}

export async function consolidateMedia(store: ProjectStore, mediaIds: string[] | undefined, expectedRevision: number): Promise<{ mutation: MutationResult; consolidated: string[] }> {
  const current = await store.read();
  const selected = current.media.filter((media) => media.storage.mode === "linked" && (!mediaIds || mediaIds.includes(media.id)));
  const replacements = new Map<string, MediaAsset>();
  for (const media of selected) {
    const source = mediaPath(store, media);
    const extension = path.extname(source).toLowerCase() || ".bin";
    const relativePath = path.join("assets", media.storage.sha256.slice(0, 2), media.storage.sha256.slice(2, 4), `${media.storage.sha256}${extension}`);
    const target = path.join(store.root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFileAtomic(source, target);
    replacements.set(media.id, { ...media, storage: { mode: "managed", sha256: media.storage.sha256, relativePath, bytes: media.storage.bytes } });
  }
  if (replacements.size === 0) {
    return { mutation: { success: true, projectId: current.projectId, revision: current.revision, transactionId: "consolidate:none", changed: emptyDelta(), warnings: ["No linked media matched."] }, consolidated: [] };
  }
  const changed = emptyDelta(); changed.media.push(...replacements.keys());
  const mutation = await store.replace(expectedRevision, (project) => { project.media = project.media.map((media) => replacements.get(media.id) ?? media); }, changed);
  return { mutation, consolidated: [...replacements.keys()] };
}

export async function inspectMedia(store: ProjectStore, mediaIds?: string[]): Promise<Array<Record<string, unknown>>> {
  const project = await store.read();
  return Promise.all(project.media.filter((media) => !mediaIds || mediaIds.includes(media.id)).map(async (media) => {
    const resolvedPath = mediaPath(store, media);
    const info = await stat(resolvedPath).catch(() => undefined);
    const changed = media.storage.mode === "linked" && info ? Math.abs(info.mtimeMs - media.storage.mtimeMs) > 1 : false;
    return { ...media, resolvedPath, available: Boolean(info?.isFile()), changedOnDisk: changed, actualBytes: info?.size ?? null };
  }));
}
