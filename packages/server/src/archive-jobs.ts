import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, lstat, rm } from "node:fs/promises";
import {
  asStudioError,
  readJson,
  writeJson,
  StudioException,
} from "@mcp-video-studio/core";
import type { StudioRuntime } from "./runtime.js";
import type { StudioConfig } from "@mcp-video-studio/media";
import { exportProjectArchive, importProjectArchive } from "./archive.js";
type Operation = {
  id: string;
  jobId?: string;
  type: "export" | "import";
  ownerPid: number;
  createdAt: string;
  updatedAt: string;
  status:
    "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  input: {
    projectPath?: string;
    outputPath?: string;
    expectedRevision?: number;
    filePath?: string;
    destinationPath?: string;
  };
  temporary?: string;
  directory?: boolean;
  error?: string;
  result?: Record<string, unknown>;
};
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const directory = (config: StudioConfig) =>
  path.join(config.dataDir, "archive-operations");
async function save(config: StudioConfig, operation: Operation) {
  operation.updatedAt = new Date().toISOString();
  await writeJson(
    path.join(directory(config), operation.id + ".json"),
    operation,
  );
}
function expectedTemporary(operation: Operation): string | undefined {
  if (operation.type === "import" && operation.input.destinationPath)
    return path.join(
      path.dirname(operation.input.destinationPath),
      ".studio-import-" + operation.id,
    );
  if (operation.type === "export" && operation.input.outputPath)
    return path.join(
      path.dirname(operation.input.outputPath),
      "." +
        path.basename(operation.input.outputPath) +
        "." +
        operation.id +
        ".tmp",
    );
  return undefined;
}
async function records(config: StudioConfig) {
  await mkdir(directory(config), { recursive: true });
  const files = (await readdir(directory(config))).filter(
    (name) => idPattern.test(name.slice(0, -5)) && name.endsWith(".json"),
  );
  if (files.length > 10000)
    throw new StudioException(
      "ARCHIVE_HISTORY_LIMIT",
      "Archive operation history exceeds10,000records; move old operation records before continuing.",
      "runtime",
    );
  const result: Operation[] = [];
  for (const file of files) {
    const op = await readJson<Operation>(path.join(directory(config), file));
    if (
      op.id + ".json" !== file ||
      !idPattern.test(op.id) ||
      !["export", "import"].includes(op.type)
    )
      throw new StudioException(
        "ARCHIVE_RECOVERY_RECORD",
        "Invalid archive operation record.",
        "runtime",
      );
    if (
      op.jobId &&
      idPattern.test(op.jobId) &&
      ["queued", "running"].includes(op.status)
    ) {
      const job = await readJson<{ status: string }>(
        path.join(config.dataDir, "jobs", op.jobId + ".json"),
      ).catch(() => undefined);
      if (job && ["cancelled", "failed"].includes(job.status))
        op.status = job.status as Operation["status"];
    }
    result.push(op);
  }
  return result;
}
/** Remove only a dead operation's exact UUID-owned temporary, never its published destination. */
export async function recoverArchiveJobs(config: StudioConfig) {
  for (const operation of await records(config)) {
    if (!["queued", "running"].includes(operation.status)) continue;
    let alive = true;
    try {
      if (!Number.isSafeInteger(operation.ownerPid) || operation.ownerPid <= 0)
        continue;
      process.kill(operation.ownerPid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive) continue;
    const expected = expectedTemporary(operation);
    if (
      operation.temporary &&
      expected &&
      path.resolve(operation.temporary) === expected
    ) {
      const info = await lstat(expected).catch(() => undefined);
      if (
        info &&
        !info.isSymbolicLink() &&
        (operation.directory ? info.isDirectory() : info.isFile())
      )
        await rm(expected, {
          recursive: operation.directory === true,
          force: true,
        });
    }
    operation.status = "interrupted";
    operation.error =
      "The previous process stopped. Owned staging was removed; any published destination was preserved. Inspect the destination before explicitly retrying.";
    await save(config, operation);
  }
}
export async function listArchiveJobs(config: StudioConfig) {
  return {
    success: true,
    operations: (await records(config))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ temporary, ownerPid, ...operation }) => operation),
  };
}
export async function queueArchive(
  runtime: StudioRuntime,
  type: Operation["type"],
  input: Operation["input"],
) {
  const id = randomUUID(),
    now = new Date().toISOString();
  if (type === "export") {
    input = {
      projectPath: path.resolve(input.projectPath!),
      outputPath: path.resolve(input.outputPath!),
      expectedRevision: input.expectedRevision!,
    };
    const project = await runtime.store(input.projectPath!).read();
    if (project.revision !== input.expectedRevision)
      throw new StudioException(
        "REVISION_CONFLICT",
        "Project revision changed before queuing archive.",
        "conflict",
      );
  } else
    input = {
      filePath: path.resolve(input.filePath!),
      destinationPath: path.resolve(input.destinationPath!),
    };
  const operation: Operation = {
    id,
    type,
    ownerPid: process.pid,
    createdAt: now,
    updatedAt: now,
    status: "queued",
    input,
  };
  await save(runtime.config, operation);
  let releaseRegistration = () => {};
  const registered = new Promise<void>(
    (resolve) => (releaseRegistration = resolve),
  );
  try {
    const job = await runtime.jobs.enqueue(
      "archive",
      type === "export"
        ? "Exporting portable project"
        : "Importing portable project",
      async ({ signal, progress, commit }) => {
        await registered;
        signal.throwIfAborted();
        operation.status = "running";
        await save(runtime.config, operation);
        let lastProgress = 0;
        try {
          const context = {
            operationId: id,
            signal,
            commit,
            temporary: async (filePath: string, isDirectory: boolean) => {
              operation.temporary = filePath;
              operation.directory = isDirectory;
              await save(runtime.config, operation);
            },
            progress: async (value: number, message: string) => {
              if (Date.now() - lastProgress > 200) {
                lastProgress = Date.now();
                await progress(value, message);
              }
            },
          };
          const result =
            type === "export"
              ? await exportProjectArchive(
                  input.projectPath!,
                  input.outputPath!,
                  input.expectedRevision!,
                  context,
                )
              : await importProjectArchive(
                  input.filePath!,
                  input.destinationPath!,
                  context,
                );
          operation.status = "completed";
          const { project, ...receipt } = result;
          operation.result = receipt;
          await save(runtime.config, operation);
          return { ...result, operationId: id };
        } catch (error) {
          operation.status = signal.aborted ? "cancelled" : "failed";
          operation.error = asStudioError(error).message;
          await save(runtime.config, operation);
          throw error;
        }
      },
    );
    operation.jobId = job.id;
    await save(runtime.config, operation);
    releaseRegistration();
    return { success: true, job, operationId: id };
  } catch (error) {
    operation.status = "failed";
    operation.error = asStudioError(error).message;
    try {
      await save(runtime.config, operation);
    } finally {
      releaseRegistration();
    }
    throw error;
  }
}
