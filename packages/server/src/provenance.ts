import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, rename, rm, realpath } from "node:fs/promises";
import {
  ProjectStore,
  validateProject,
  readJson,
  writeJson,
  copyFileAtomic,
  confinedPath,
  sha256File,
  StudioException,
  asStudioError,
} from "@mcp-video-studio/core";
import {
  mediaPath,
  runChecked,
  type StudioConfig,
} from "@mcp-video-studio/media";
import { renderSequence } from "@mcp-video-studio/renderer";
import type { StudioProject } from "@mcp-video-studio/contracts";
import type { StudioRuntime } from "./runtime.js";
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Engine = {
  format: 1;
  node: string;
  platform: string;
  architecture: string;
  ffmpeg: string;
  applicationSha256: string;
};
type Receipt = {
  id: string;
  status:
    | "queued"
    | "rendering"
    | "ready"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  ownerPid: number;
  jobId?: string;
  projectPath: string;
  outputPath: string;
  sequenceId: string;
  presetId: string;
  createdAt: string;
  updatedAt: string;
  projectSnapshot: StudioProject;
  engine?: Engine;
  sourceHashes?: Record<string, string>;
  result?: Record<string, unknown>;
  temporary?: string;
  scratch?: string;
  reproducedFrom?: string;
  error?: string;
};
const directory = (config: StudioConfig) =>
  path.join(config.dataDir, "render-operations");
const recordPath = (config: StudioConfig, id: string) => {
  if (!idPattern.test(id))
    throw new StudioException(
      "INVALID_EXPORT_ID",
      "Export ID must be a UUID.",
      "input",
    );
  return confinedPath(
    config.dataDir,
    path.join(directory(config), id + ".json"),
  );
};
async function save(config: StudioConfig, record: Receipt) {
  record.updatedAt = new Date().toISOString();
  if (Buffer.byteLength(JSON.stringify(record)) > 16 * 1024 * 1024)
    throw new StudioException(
      "EXPORT_HISTORY_SIZE",
      "The export snapshot exceeds16MiB.",
      "input",
    );
  await writeJson(recordPath(config, record.id), record);
}
async function read(config: StudioConfig, id: string) {
  const file = recordPath(config, id),
    info = await stat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024)
    throw new StudioException(
      "INVALID_EXPORT_HISTORY",
      "Export history must be a bounded regular file.",
      "input",
    );
  const record = await readJson<Receipt>(file);
  if (
    record.id !== id ||
    ![
      "queued",
      "rendering",
      "ready",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(record.status)
  )
    throw new StudioException(
      "INVALID_EXPORT_HISTORY",
      "Invalid export history record.",
      "input",
    );
  record.projectSnapshot = validateProject(record.projectSnapshot);
  if (
    record.jobId &&
    idPattern.test(record.jobId) &&
    ["queued", "rendering"].includes(record.status)
  ) {
    const job = await readJson<{ status: string }>(
      path.join(config.dataDir, "jobs", record.jobId + ".json"),
    ).catch(() => undefined);
    if (job && ["failed", "cancelled"].includes(job.status))
      record.status = job.status as Receipt["status"];
  }
  return record;
}
async function recordIds(config: StudioConfig) {
  await mkdir(directory(config), { recursive: true });
  const ids = (await readdir(directory(config))).filter(
    (f) => f.endsWith(".json") && idPattern.test(f.slice(0, -5)),
  );
  if (ids.length >= 10000)
    throw new StudioException(
      "EXPORT_HISTORY_LIMIT",
      "Move old export history records before reaching10,000exports.",
      "runtime",
    );
  return ids.map((f) => f.slice(0, -5));
}
async function* records(config: StudioConfig) {
  for (const id of await recordIds(config)) yield await read(config, id);
}
export async function getExportHistory(config: StudioConfig, id: string) {
  const { ownerPid, temporary, scratch, ...exported } = await read(config, id);
  return { success: true, export: exported };
}
export async function listExportHistory(
  config: StudioConfig,
  projectPath: string,
) {
  const exports: Array<Record<string, unknown> & { createdAt: string }> = [];
  for await (const {
    projectSnapshot,
    ownerPid,
    temporary,
    scratch,
    ...record
  } of records(config)) {
    if (path.resolve(record.projectPath) !== path.resolve(projectPath))
      continue;
    exports.push({
      ...record,
      projectId: projectSnapshot.projectId,
      revision: projectSnapshot.revision,
    });
    exports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (exports.length > 100) exports.length = 100;
  }
  return { success: true, exports, limit: 100 };
}
async function engine(
  config: StudioConfig,
  signal: AbortSignal,
): Promise<Engine> {
  const result = await runChecked(
    config.ffmpegPath,
    ["-hide_banner", "-version"],
    { signal, timeoutMs: 15000, maxOutputChars: 80000 },
  );
  return {
    format: 1,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    ffmpeg: result.stdout + result.stderr,
    applicationSha256: (
      await sha256File(fileURLToPath(import.meta.url), signal)
    ).sha256,
  };
}
function samePath(a: string, b: string) {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
async function outputFor(
  store: ProjectStore,
  project: StudioProject,
  requested: string,
) {
  const output = path.resolve(requested);
  await mkdir(path.dirname(output), { recursive: true });
  const canonical = path.join(
    await realpath(path.dirname(output)),
    path.basename(output),
  );
  const root = await realpath(store.root),
    relative = path.relative(root, canonical);
  if (
    !relative.startsWith(".." + path.sep) &&
    relative !== ".." &&
    !path.isAbsolute(relative) &&
    relative.split(path.sep)[0] !== "exports"
  )
    throw new StudioException(
      "PROTECTED_EXPORT_PATH",
      "Export inside a project must be in its exports directory.",
      "input",
    );
  for (const media of project.media) {
    const source = await realpath(mediaPath(store, media)).catch(() =>
      mediaPath(store, media),
    );
    if (samePath(canonical, source))
      throw new StudioException(
        "SOURCE_OUTPUT_OVERWRITE",
        "Export cannot overwrite a source asset.",
        "input",
      );
  }
  return canonical;
}
export async function recoverExportHistory(config: StudioConfig) {
  for await (const record of records(config)) {
    if (!["queued", "rendering", "ready"].includes(record.status)) continue;
    let alive = true;
    try {
      if (!Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0)
        continue;
      process.kill(record.ownerPid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive) continue;
    const published =
      record.status === "ready" &&
      record.result &&
      (await sha256File(record.outputPath).catch(() => undefined));
    if (
      published &&
      published.sha256 === record.result?.sha256 &&
      published.bytes === record.result?.bytes
    )
      record.status = "completed";
    else {
      record.status = "interrupted";
      record.error =
        "The previous process stopped before a verified publication. Inspect the destination before retrying.";
    }
    const expected = path.join(
      path.dirname(record.outputPath),
      "." + path.basename(record.outputPath) + "." + record.id + ".export",
    );
    if (record.temporary === expected) {
      await rm(expected, { force: true }).catch(() => undefined);
      await rm(
        path.join(
          path.dirname(expected),
          "." + path.basename(expected) + "." + record.id + ".tmp",
        ),
        { force: true },
      ).catch(() => undefined);
    }
    const scratch = confinedPath(
      config.scratchDir,
      path.join(config.scratchDir, "export-" + record.id),
    );
    if (record.scratch === scratch)
      await rm(scratch, { recursive: true, force: true }).catch(
        () => undefined,
      );
    await save(config, record);
  }
}
export async function queueExport(
  runtime: StudioRuntime,
  input: {
    projectPath: string;
    sequenceId: string;
    presetId: string;
    outputPath: string;
    expectedRevision?: number;
    reproduceId?: string;
  },
) {
  const store = runtime.store(input.projectPath),
    prior = input.reproduceId
      ? await read(runtime.config, input.reproduceId)
      : undefined;
  if (
    prior &&
    (prior.status !== "completed" ||
      !samePath(path.resolve(prior.projectPath), store.root) ||
      !prior.sourceHashes ||
      !prior.engine)
  )
    throw new StudioException(
      "EXPORT_NOT_REPRODUCIBLE",
      "Choose a completed export belonging to this project.",
      "input",
    );
  const project = prior
    ? validateProject(structuredClone(prior.projectSnapshot))
    : await store.read();
  if (
    input.expectedRevision !== undefined &&
    input.expectedRevision !== project.revision
  )
    throw new StudioException(
      "REVISION_CONFLICT",
      "The project changed before the export snapshot was queued.",
      "conflict",
    );
  const sequenceId = prior?.sequenceId ?? input.sequenceId,
    presetId = prior?.presetId ?? input.presetId;
  if (
    !project.sequences.some((s) => s.id === sequenceId) ||
    !project.exportPresets.some((p) => p.id === presetId)
  )
    throw new StudioException(
      "EXPORT_SELECTION",
      "Choose a sequence and preset in the saved project.",
      "input",
    );
  const outputPath = await outputFor(store, project, input.outputPath);
  if (prior) await outputFor(store, await store.read(), outputPath);
  const id = randomUUID(),
    now = new Date().toISOString(),
    record: Receipt = {
      id,
      status: "queued",
      ownerPid: process.pid,
      projectPath: store.root,
      outputPath,
      sequenceId,
      presetId,
      createdAt: now,
      updatedAt: now,
      projectSnapshot: project,
      ...(prior ? { reproducedFrom: prior.id } : {}),
    };
  await recordIds(runtime.config);
  await save(runtime.config, record);
  let releaseRegistration = () => {};
  const registered = new Promise<void>(
    (resolve) => (releaseRegistration = resolve),
  );
  try {
    const job = await runtime.jobs.enqueue(
      "render",
      "Rendering saved project snapshot",
      async ({ signal, progress, commit }) => {
        await registered;
        signal.throwIfAborted();
        record.status = "rendering";
        await save(runtime.config, record);
        try {
          record.engine = await engine(runtime.config, signal);
          if (
            prior &&
            JSON.stringify(record.engine) !== JSON.stringify(prior.engine)
          )
            throw new StudioException(
              "HISTORICAL_ENGINE_CHANGED",
              "The application, Node platform, or FFmpeg build differs from the saved export. Use the recorded environment to reproduce it.",
              "conflict",
            );
          record.scratch = confinedPath(
            runtime.config.scratchDir,
            path.join(runtime.config.scratchDir, "export-" + id),
          );
          await save(runtime.config, record);
          await mkdir(record.scratch, { recursive: true });
          return await renderSequence(
            store,
            { ...runtime.config, scratchDir: record.scratch },
            {
              sequenceId,
              presetId,
              outputPath,
              projectSnapshot: project,
              stagingDirectory: record.scratch,
              ...(prior ? { expectedSourceHashes: prior.sourceHashes! } : {}),
              signal,
              onProgress: (value, message) => void progress(value, message),
              publish: async (source, result) => {
                const temporary = path.join(
                  path.dirname(outputPath),
                  "." + path.basename(outputPath) + "." + id + ".export",
                );
                record.temporary = temporary;
                record.sourceHashes = result.sourceHashes as Record<
                  string,
                  string
                >;
                record.result = result;
                await save(runtime.config, record);
                try {
                  await copyFileAtomic(source, temporary, {
                    signal,
                    temporaryId: id,
                    expected: {
                      sha256: String(result.sha256),
                      bytes: Number(result.bytes),
                    },
                  });
                  record.status = "ready";
                  await save(runtime.config, record);
                  signal.throwIfAborted();
                  commit();
                  await rename(temporary, outputPath);
                  record.status = "completed";
                  const saved = await save(runtime.config, record).then(
                    () => true,
                    () => false,
                  );
                  return {
                    exportId: id,
                    provenanceStatus: saved
                      ? "completed"
                      : "publication-confirmation-pending",
                    ...(prior ? { reproducedFrom: prior.id } : {}),
                  };
                } finally {
                  await rm(temporary, { force: true }).catch(() => undefined);
                }
              },
            },
          );
        } catch (error) {
          record.status = signal.aborted ? "cancelled" : "failed";
          record.error = asStudioError(error).message;
          await save(runtime.config, record);
          throw error;
        } finally {
          if (record.scratch)
            await rm(record.scratch, { recursive: true, force: true }).catch(
              () => undefined,
            );
        }
      },
    );
    record.jobId = job.id;
    await save(runtime.config, record);
    releaseRegistration();
    return { success: true, job, exportId: id, revision: project.revision };
  } catch (error) {
    record.status = "failed";
    record.error = asStudioError(error).message;
    try {
      await save(runtime.config, record);
    } finally {
      releaseRegistration();
    }
    throw error;
  }
}
