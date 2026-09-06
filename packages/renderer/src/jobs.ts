import { randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { JobRecord } from "@mcp-video-studio/contracts";
import { asStudioError, readJson, writeJson } from "@mcp-video-studio/core";

export interface JobContext {
  signal: AbortSignal;
  /** Begin atomic publication. Cancellation after this point waits for its result. */
  commit(): void;
  progress(value: number, message?: string): Promise<void>;
}

type JobExecutor = (context: JobContext) => Promise<Record<string, unknown>>;
type JobListener = (job: JobRecord) => void;

interface QueuedJob {
  record: JobRecord;
  executor: JobExecutor;
  controller: AbortController;
}

export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: QueuedJob[] = [];
  private readonly listeners = new Set<JobListener>();
  private readonly persistTails = new Map<string, Promise<void>>();
  private running = 0;
  private closed = false;
  private readonly executing = new Set<Promise<void>>();
  private readonly settlements = new Map<string, Promise<void>>();
  private readonly committing = new Set<string>();

  constructor(
    readonly directory: string,
    readonly concurrency = 2,
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory).catch(() => []);
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      try {
        const job = await readJson<JobRecord>(path.join(this.directory, name));
        if (job.status === "running" || job.status === "queued") {
          job.status = "failed";
          job.message = "The server restarted before this job completed.";
          job.error = {
            code: "SERVER_RESTARTED",
            message: job.message,
            category: "runtime",
          };
          job.updatedAt = new Date().toISOString();
          await this.persist(job);
        }
        this.jobs.set(job.id, job);
      } catch {
        /* ignore corrupt unrelated records; doctor can report separately */
      }
    }
  }

  subscribe(listener: JobListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  get(id: string): JobRecord | undefined {
    const record = this.jobs.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async enqueue(
    type: JobRecord["type"],
    message: string,
    executor: JobExecutor,
  ): Promise<JobRecord> {
    if (this.closed || this.queue.length >= 64)
      throw new Error(
        "Job queue is closed or full; wait for active jobs to finish.",
      );
    const now = new Date().toISOString();
    const record: JobRecord = {
      id: randomUUID(),
      type,
      status: "queued",
      progress: 0,
      message,
      createdAt: now,
      updatedAt: now,
    };
    const controller = new AbortController();
    this.jobs.set(record.id, record);
    this.controllers.set(record.id, controller);
    this.queue.push({ record, executor, controller });
    await this.persist(record);
    this.emit(record);
    void this.drain();
    return structuredClone(record);
  }

  async cancel(id: string): Promise<JobRecord | undefined> {
    const record = this.jobs.get(id);
    if (!record || ["completed", "failed", "cancelled"].includes(record.status))
      return record ? structuredClone(record) : undefined;
    const settlement = this.settlements.get(id);
    if (this.committing.has(id)) {
      await settlement;
      return this.get(id);
    }
    this.controllers.get(id)?.abort();
    if (settlement) {
      record.message = "Cancelling; waiting for owned resources to close.";
      await this.persist(record);
      this.emit(record);
      await settlement;
      return this.get(id);
    }
    const index = this.queue.findIndex((job) => job.record.id === id);
    if (index >= 0) this.queue.splice(index, 1);
    this.controllers.delete(id);
    record.status = "cancelled";
    record.message = "Cancelled.";
    record.updatedAt = new Date().toISOString();
    await this.persist(record);
    this.emit(record);
    return structuredClone(record);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.controllers.keys()].map((id) => this.cancel(id)),
    );
    this.queue.length = 0;
    await Promise.allSettled([...this.executing]);
    await Promise.allSettled([...this.persistTails.values()]);
    this.controllers.clear();
    this.listeners.clear();
  }

  private async drain(): Promise<void> {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      if (job.controller.signal.aborted) {
        this.controllers.delete(job.record.id);
        continue;
      }
      this.running += 1;
      const execution = this.execute(job).finally(() => {
        this.running -= 1;
        this.executing.delete(execution);
        this.settlements.delete(job.record.id);
        this.committing.delete(job.record.id);
        if (!this.closed) void this.drain();
      });
      this.executing.add(execution);
      this.settlements.set(job.record.id, execution);
      void execution.catch(() => {
        this.controllers.delete(job.record.id);
      });
    }
  }

  private async execute(job: QueuedJob): Promise<void> {
    const record = job.record;
    let acceptingProgress = true;
    let terminal: JobRecord | undefined;
    record.status = "running";
    record.message = "Running.";
    record.updatedAt = new Date().toISOString();
    await this.persist(record);
    this.emit(record);
    try {
      const result = await job.executor({
        signal: job.controller.signal,
        commit: () => {
          job.controller.signal.throwIfAborted();
          this.committing.add(record.id);
        },
        progress: async (value, message) => {
          if (
            !acceptingProgress ||
            job.controller.signal.aborted ||
            record.status === "cancelled"
          )
            return;
          record.progress = Math.max(record.progress, Math.min(1, value));
          if (message) record.message = message;
          record.updatedAt = new Date().toISOString();
          await this.persist(record);
          this.emit(record);
        },
      });
      acceptingProgress = false;
      if (
        !job.controller.signal.aborted &&
        this.jobs.get(record.id)?.status !== "cancelled"
      ) {
        terminal = {
          ...record,
          status: "completed",
          progress: 1,
          message: "Completed.",
          result,
        };
      } else {
        terminal = { ...record, status: "cancelled", message: "Cancelled." };
      }
    } catch (error) {
      acceptingProgress = false;
      if (
        job.controller.signal.aborted ||
        this.jobs.get(record.id)?.status === "cancelled"
      ) {
        terminal = { ...record, status: "cancelled", message: "Cancelled." };
      } else {
        const message = error instanceof Error ? error.message : String(error);
        terminal = {
          ...record,
          status: "failed",
          message,
          error: asStudioError(error),
        };
      }
    } finally {
      acceptingProgress = false;
      terminal ??= {
        ...record,
        status: "failed",
        message: "Job ended without a terminal result.",
      };
      terminal.updatedAt = new Date().toISOString();
      this.controllers.delete(record.id);
      // Publish terminal state in memory only after every queued progress write and
      // the terminal snapshot are durable. Consumers may delete a temporary runtime
      // as soon as they observe a terminal status.
      await this.persist(terminal);
      Object.assign(record, terminal);
      this.emit(record);
    }
  }

  private async persist(record: JobRecord): Promise<void> {
    const snapshot = structuredClone(record);
    const previous = this.persistTails.get(record.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() =>
        writeJson(path.join(this.directory, `${record.id}.json`), snapshot),
      );
    this.persistTails.set(record.id, next);
    try {
      await next;
    } finally {
      if (this.persistTails.get(record.id) === next)
        this.persistTails.delete(record.id);
    }
  }

  private emit(record: JobRecord): void {
    for (const listener of this.listeners) listener(structuredClone(record));
  }
}
