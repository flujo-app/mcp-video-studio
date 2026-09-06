import { mkdir, readdir, lstat, rm } from "node:fs/promises";
import path from "node:path";
import type {
  JobRecord,
  StudioProject,
  ProjectDelta,
} from "@mcp-video-studio/contracts";
import {
  readJson,
  writeJson,
  loadHistoryState,
  confinedPath,
  type HistoryEntry,
  StudioException,
} from "@mcp-video-studio/core";
import type { StudioConfig } from "@mcp-video-studio/media";
export interface RetimeOperation {
  id: string;
  ownerPid: number;
  jobId?: string;
  projectPath: string;
  sourceRevision: number;
  projectId: string;
  mode: string;
  status: "queued" | "running" | "ready" | "completed" | "interrupted";
  mediaIds: string[];
  clipIds: string[];
  sequenceId: string;
  scratch?: string;
  result?: Record<string, unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function saveRetimeOperation(
  config: StudioConfig,
  record: RetimeOperation,
) {
  await writeJson(
    path.join(config.dataDir, "retiming-operations", record.id + ".json"),
    record,
  );
}
function delta(record: RetimeOperation): ProjectDelta {
  return {
    sequences: [record.sequenceId],
    tracks: [],
    clips: record.clipIds,
    media: record.mediaIds,
    animations: [],
    generatedArtifacts: [],
  };
}
async function committedResult(
  record: RetimeOperation,
): Promise<Record<string, unknown> | undefined> {
  const state = await loadHistoryState(record.projectPath);
  for (const id of [...state.past, ...state.future]) {
    const entry = await readJson<HistoryEntry>(
      confinedPath(
        record.projectPath,
        path.join(record.projectPath, "history", "transactions", id + ".json"),
      ),
    );
    const matches = (project: StudioProject) =>
      project.media
        .filter((media) => media.retiming?.operationId === record.id)
        .map((media) => media.id)
        .sort()
        .join("|") === record.mediaIds.slice().sort().join("|");
    if (
      record.mediaIds.length &&
      entry.id === id &&
      entry.before.revision === record.sourceRevision &&
      matches(entry.after) &&
      !matches(entry.before)
    )
      return {
        success: true,
        projectId: record.projectId,
        revision: entry.after.revision,
        transactionId: id,
        changed: delta(record),
        warnings: [],
        mediaIds: record.mediaIds,
        clipIds: record.clipIds,
        mode: record.mode,
        projectPath: record.projectPath,
        operationId: record.id,
        recovered: true,
      };
  }
  return undefined;
}
/** Reconcile only dead operation owners, using the atomic committed history cursor as proof. */
export async function recoverRetimeJobs(config: StudioConfig) {
  const directory = path.join(config.dataDir, "retiming-operations");
  await mkdir(directory, { recursive: true });
  const names = (await readdir(directory)).filter(
    (name) => name.endsWith(".json") && uuid.test(name.slice(0, -5)),
  );
  if (names.length > 10000)
    throw new StudioException(
      "RETIMING_HISTORY_LIMIT",
      "Move old retiming operation records before exceeding 10000 records.",
      "runtime",
    );
  for (const name of names) {
    const record = await readJson<RetimeOperation>(path.join(directory, name));
    if (
      record.id + ".json" !== name ||
      !uuid.test(record.id) ||
      !Number.isSafeInteger(record.ownerPid) ||
      record.ownerPid <= 0 ||
      !path.isAbsolute(record.projectPath) ||
      !Array.isArray(record.mediaIds) ||
      !record.mediaIds.every((id) => uuid.test(id)) ||
      !Array.isArray(record.clipIds)
    )
      throw new StudioException(
        "RETIMING_RECOVERY_RECORD",
        "Invalid retiming operation record; preserve it for inspection.",
        "runtime",
      );
    let alive = true;
    try {
      process.kill(record.ownerPid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
    if (alive) continue;
    const expected = path.join(config.scratchDir, "retiming-" + record.id);
    if (record.scratch && path.resolve(record.scratch) === expected) {
      const info = await lstat(expected).catch(() => undefined);
      if (info?.isDirectory() && !info.isSymbolicLink())
        await rm(expected, { recursive: true, force: true });
    }
    if (!record.jobId || !uuid.test(record.jobId)) continue;
    const file = path.join(config.dataDir, "jobs", record.jobId + ".json"),
      job = await readJson<JobRecord>(file).catch(() => undefined);
    if (
      !job ||
      !["queued", "running", "failed"].includes(job.status) ||
      (job.status === "failed" && job.error?.code !== "SERVER_RESTARTED")
    )
      continue;
    let result = record.status === "completed" ? record.result : undefined;
    if (!result && record.mediaIds.length)
      result = await committedResult(record).catch(() => undefined);
    const updatedAt = new Date().toISOString();
    if (result) {
      record.status = "completed";
      record.result = result;
      await saveRetimeOperation(config, record);
      const { error: _, ...before } = job;
      await writeJson(file, {
        ...before,
        status: "completed",
        progress: 1,
        message: "Recovered committed retiming.",
        updatedAt,
        result,
      });
    } else {
      record.status = "interrupted";
      await saveRetimeOperation(config, record);
      await writeJson(file, {
        ...job,
        status: "failed",
        updatedAt,
        message:
          "Retiming was interrupted before a committed transaction was found. The project was preserved; inspect it before retrying.",
        error: {
          code: "RETIMING_INTERRUPTED",
          category: "runtime",
          message:
            "No committed retiming transaction was found in retained history.",
        },
      });
    }
  }
}
