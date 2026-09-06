import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  ProjectStore,
  confinedPath,
  sha256File,
  validateProject,
  writeJson,
  StudioException,
} from "@mcp-video-studio/core";
import { mediaPath } from "@mcp-video-studio/media";
import type { StudioProject } from "@mcp-video-studio/contracts";
const MAGIC = Buffer.from("MCPSTUDIO001\n");
const MAX_BYTES = 20 * 1024 * 1024 * 1024,
  MAX_MANIFEST = 16 * 1024 * 1024;
export interface ArchiveContext {
  operationId?: string;
  signal?: AbortSignal;
  progress?: (value: number, message: string) => Promise<void>;
  temporary?: (filePath: string, directory: boolean) => Promise<void>;
  commit?: () => void;
}
const active = (context: ArchiveContext) => {
  if (context.operationId && !/^[0-9a-f-]{36}$/.test(context.operationId))
    fail("Invalid archive operation ID.");
  context.signal?.throwIfAborted();
};
async function openArchive(filePath: string) {
  const handle = await open(
    path.resolve(filePath),
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > MAX_BYTES + MAX_MANIFEST + MAGIC.length + 4
    )
      fail("Archive input must be a bounded regular file.");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
interface Entry {
  path: string;
  bytes: number;
  sha256: string;
}
interface Manifest {
  sourceSchemaVersion?: number;
  format: "mcp-video-studio-archive";
  version: 1;
  project: StudioProject;
  files: Entry[];
}
function samePath(a: string, b: string) {
  return process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
}
function fail(message: string): never {
  throw new StudioException("INVALID_ARCHIVE", message, "input");
}
function safeEntry(entry: Entry): void {
  if (
    !entry.path.startsWith("assets/") ||
    entry.path.includes("\\") ||
    entry.path.includes(":") ||
    entry.path.split("/").some((s) => !s || s === "." || s === "..") ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    fail("Archive contains an invalid media entry.");
}
async function diskAdmission(directory: string, bytes: number) {
  const disk = await statfs(directory);
  if (bytes + 64 * 1024 * 1024 > disk.bavail * disk.bsize)
    throw new StudioException(
      "DISK_CAPACITY",
      "Insufficient free space for atomic archive publication.",
      "runtime",
    );
}
export async function exportProjectArchive(
  projectPath: string,
  outputPath: string,
  expectedRevision: number,
  context: ArchiveContext = {},
): Promise<Record<string, unknown>> {
  active(context);
  const store = new ProjectStore(projectPath),
    project = await store.read();
  if (project.revision !== expectedRevision)
    throw new StudioException(
      "REVISION_CONFLICT",
      "Project revision changed before archiving.",
      "conflict",
    );
  const sources = new Map<string, { entry: Entry; source: string }>();
  for (const media of project.media) {
    const source = mediaPath(store, media),
      actual = await sha256File(source, context.signal);
    if (actual.sha256 !== media.storage.sha256)
      fail("A media source changed. Relink it before archiving.");
    const extension =
        path
          .extname(source)
          .toLowerCase()
          .replace(/[^a-z0-9.]/g, "") || ".bin",
      relative = "assets/" + actual.sha256 + extension;
    const entry = {
      path: relative,
      bytes: actual.bytes,
      sha256: actual.sha256,
    };
    safeEntry(entry);
    sources.set(relative, { entry, source });
    media.storage = { mode: "managed", relativePath: relative, ...actual };
  }
  const files = [...sources.values()].sort((a, b) =>
      a.entry.path.localeCompare(b.entry.path),
    ),
    manifest: Manifest = {
      format: "mcp-video-studio-archive",
      version: 1,
      project: validateProject(project),
      files: files.map((f) => f.entry),
    };
  const encoded = Buffer.from(JSON.stringify(manifest));
  const total = files.reduce((sum, f) => sum + f.entry.bytes, 0);
  if (
    total > MAX_BYTES ||
    encoded.length > MAX_MANIFEST ||
    files.length > 10000
  )
    fail("Archive exceeds the 20 GiB / 10000 media entry limits.");
  const output = path.resolve(outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  await diskAdmission(path.dirname(output), total + encoded.length);
  // Never replace an input media file or the canonical project with an archive.
  if (
    samePath(output, path.join(store.root, "project.json")) ||
    files.some((f) => samePath(f.source, output))
  )
    fail("Archive output cannot replace a project or media source.");
  const temporary = path.join(
    path.dirname(output),
    "." +
      path.basename(output) +
      "." +
      (context.operationId ?? randomUUID()) +
      ".tmp",
  );
  await context.temporary?.(temporary, false);
  active(context);
  const handle = await open(temporary, "wx");
  try {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.length);
    await handle.writeFile(Buffer.concat([MAGIC, length, encoded]));
    let completedBytes = 0;
    for (const file of files) {
      active(context);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(file.source, {
        signal: context.signal,
      })) {
        bytes += chunk.length;
        if (bytes > file.entry.bytes) fail("Media changed while archiving.");
        hash.update(chunk);
        await handle.writeFile(chunk);
        completedBytes += chunk.length;
        await context.progress?.(
          0.1 + (0.8 * completedBytes) / Math.max(1, total),
          "Writing verified project media",
        );
      }
      if (
        bytes !== file.entry.bytes ||
        hash.digest("hex") !== file.entry.sha256
      )
        fail("Media changed while archiving.");
    }
    await handle.sync();
    await handle.close();
    const archiveHash = await sha256File(temporary, context.signal);
    active(context);
    context.commit?.();
    await rename(temporary, output);
    return {
      success: true,
      outputPath: output,
      projectId: project.projectId,
      revision: project.revision,
      mediaCount: files.length,
      ...archiveHash,
    };
  } finally {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: number,
  context: ArchiveContext = {},
): Promise<Buffer> {
  const result = Buffer.alloc(bytes);
  let offset = 0;
  while (offset < bytes) {
    active(context);
    const read = await handle.read(result, offset, bytes - offset, null);
    if (!read.bytesRead) fail("Archive ended unexpectedly.");
    offset += read.bytesRead;
  }
  return result;
}
export async function inspectProjectArchive(
  filePath: string,
  context: ArchiveContext = {},
): Promise<Record<string, unknown>> {
  active(context);
  const handle = await openArchive(filePath);
  try {
    const manifest = await readManifest(handle, context);
    return {
      success: true,
      format: manifest.format,
      version: manifest.version,
      projectName: manifest.project.name,
      projectId: manifest.project.projectId,
      revision: manifest.project.revision,
      mediaCount: manifest.files.length,
      totalMediaBytes: manifest.files.reduce((n, f) => n + f.bytes, 0),
      migration: {
        sourceSchemaVersion:
          manifest.sourceSchemaVersion ?? manifest.project.schemaVersion,
        targetSchemaVersion: 2,
        changes:
          manifest.sourceSchemaVersion === 1
            ? ["Upgrade schema 1 to atomic-history schema 2"]
            : [],
        history: "Archive imports start a fresh undo history.",
      },
    };
  } finally {
    await handle.close();
  }
}
async function readManifest(
  handle: Awaited<ReturnType<typeof open>>,
  context: ArchiveContext = {},
): Promise<Manifest> {
  const prefix = await readExact(handle, MAGIC.length + 4, context);
  if (!prefix.subarray(0, MAGIC.length).equals(MAGIC))
    fail("Unsupported archive signature.");
  const size = prefix.readUInt32BE(MAGIC.length);
  if (size > MAX_MANIFEST) fail("Archive manifest exceeds its byte limit.");
  const raw = JSON.parse(
    (await readExact(handle, size, context)).toString("utf8"),
  ) as Manifest;
  if (
    raw.format !== "mcp-video-studio-archive" ||
    raw.version !== 1 ||
    !Array.isArray(raw.files) ||
    raw.files.length > 10000
  )
    fail("Unsupported archive format/version.");
  const project = validateProject(raw.project);
  const paths = new Set<string>();
  let total = 0;
  for (const entry of raw.files) {
    safeEntry(entry);
    const key = entry.path.toLowerCase();
    if (paths.has(key)) fail("Duplicate archive path.");
    paths.add(key);
    total += entry.bytes;
    if (total > MAX_BYTES) fail("Archive exceeds 20 GiB.");
  }
  for (const media of project.media) {
    if (media.storage.mode !== "managed")
      fail("Archives cannot reference external media.");
    const storage = media.storage,
      entry = raw.files.find((f) => f.path === storage.relativePath);
    if (
      !entry ||
      entry.sha256 !== storage.sha256 ||
      entry.bytes !== storage.bytes
    )
      fail("Archive media manifest does not match its project.");
  }
  return { ...raw, sourceSchemaVersion: raw.project.schemaVersion, project };
}
export async function importProjectArchive(
  filePath: string,
  destinationPath: string,
  context: ArchiveContext = {},
): Promise<Record<string, unknown>> {
  active(context);
  const destination = path.resolve(destinationPath);
  if (await lstat(destination).catch(() => undefined))
    fail("Choose a destination that does not already exist.");
  await mkdir(path.dirname(destination), { recursive: true });
  const handle = await openArchive(filePath),
    staging = path.join(
      path.dirname(destination),
      ".studio-import-" + (context.operationId ?? randomUUID()),
    );
  try {
    const manifest = await readManifest(handle, context);
    await diskAdmission(
      path.dirname(destination),
      manifest.files.reduce((n, f) => n + f.bytes, 0) + MAX_MANIFEST,
    );
    await context.temporary?.(staging, true);
    active(context);
    await mkdir(staging);
    const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
    let completedBytes = 0;
    for (const entry of manifest.files) {
      const output = confinedPath(staging, path.join(staging, entry.path));
      await mkdir(path.dirname(output), { recursive: true });
      const writer = await open(output, "wx");
      const hash = createHash("sha256");
      let remaining = entry.bytes;
      try {
        while (remaining) {
          const bytes = await readExact(
            handle,
            Math.min(65536, remaining),
            context,
          );
          remaining -= bytes.length;
          hash.update(bytes);
          await writer.writeFile(bytes);
          completedBytes += bytes.length;
          await context.progress?.(
            0.1 + (0.8 * completedBytes) / Math.max(1, total),
            "Restoring checksummed media",
          );
        }
        await writer.sync();
      } finally {
        await writer.close();
      }
      if (hash.digest("hex") !== entry.sha256)
        fail("Archive media checksum failed.");
    }
    const tail = Buffer.alloc(1);
    if ((await handle.read(tail, 0, 1, null)).bytesRead)
      fail("Archive contains unexpected trailing data.");
    for (const name of [
      "assets",
      "fonts",
      "proxies",
      "cache",
      "history/transactions",
      "jobs",
      "exports",
    ])
      await mkdir(path.join(staging, name), { recursive: true });
    await writeJson(path.join(staging, "project.json"), {
      ...manifest.project,
      _history: { past: [], future: [] },
    });
    if (await lstat(destination).catch(() => undefined))
      fail("Archive destination appeared during import.");
    active(context);
    context.commit?.();
    await rename(staging, destination);
    return {
      success: true,
      projectPath: destination,
      project: manifest.project,
      mediaCount: manifest.files.length,
    };
  } finally {
    await handle.close();
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
