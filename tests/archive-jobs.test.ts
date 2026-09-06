import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
  mkdir,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ProjectStore, sha256File } from "@mcp-video-studio/core";
import { loadConfig, consolidateMedia } from "@mcp-video-studio/media";
import { JobManager } from "@mcp-video-studio/renderer";
import {
  exportProjectArchive,
  importProjectArchive,
} from "../packages/server/src/archive.js";
import {
  queueArchive,
  listArchiveJobs,
  recoverArchiveJobs,
} from "../packages/server/src/archive-jobs.js";
import { StudioRuntime } from "../packages/server/src/runtime.js";
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-archive-jobs-")),
    store = await ProjectStore.create(
      path.join(root, "project"),
      "Archive jobs",
    ),
    source = path.join(root, "source.wav");
  await writeFile(source, Buffer.alloc(1024 * 1024, 37));
  const hash = await sha256File(source);
  await store.replace(
    0,
    (p) => {
      p.media.push({
        id: "linked-media",
        name: "Linked audio",
        kind: "audio",
        storage: { mode: "linked", path: source, ...hash, mtimeMs: 0 },
        probe: { durationTick: 35280000, hasAudio: true, hasVideo: false },
        createdAt: "2026-01-01T00:00:00Z",
      });
    },
    {
      sequences: [],
      tracks: [],
      clips: [],
      media: ["linked-media"],
      animations: [],
      generatedArtifacts: [],
    },
  );
  return {
    root,
    store,
    source,
    config: loadConfig({
      VIDEO_STUDIO_DATA_DIR: root,
      VIDEO_STUDIO_MAX_CONCURRENT_JOBS: "1",
    }),
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Archive fixture timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}
it("cancellation removes owned export/import staging and preserves an existing export and absent destination", async () => {
  const f = await fixture();
  try {
    const output = path.join(f.root, "archive.mcpstudio");
    await writeFile(output, "prior output");
    let temporary = "";
    const controller = new AbortController();
    await expect(
      exportProjectArchive(f.store.root, output, 1, {
        signal: controller.signal,
        temporary: async (file) => {
          temporary = file;
        },
        progress: async () => controller.abort(),
      }),
    ).rejects.toThrow();
    expect(await readFile(output, "utf8")).toBe("prior output");
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    await exportProjectArchive(f.store.root, output, 1);
    const imported = path.join(f.root, "restored"),
      second = new AbortController();
    await expect(
      importProjectArchive(output, imported, {
        signal: second.signal,
        temporary: async (file) => {
          temporary = file;
        },
        progress: async () => second.abort(),
      }),
    ).rejects.toThrow();
    await expect(stat(imported)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 20000);
it("cancellation stays nonterminal until cleanup, while cancellation past the commit barrier waits for publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-job-settlement-")),
    jobs = new JobManager(root, 1);
  try {
    await jobs.initialize();
    let entered = false,
      clean = false,
      release!: () => void;
    const cleanupGate = new Promise<void>((r) => (release = r));
    const job = await jobs.enqueue("archive", "Fixture", async ({ signal }) => {
      entered = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await cleanupGate;
      clean = true;
      return {};
    });
    await until(() => entered);
    const cancelled = jobs.cancel(job.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(clean).toBe(false);
    expect(jobs.get(job.id)!.status).toBe("running");
    release();
    expect((await cancelled)!.status).toBe("cancelled");
    expect(clean).toBe(true);
    let committed = false,
      finish!: () => void;
    const publishGate = new Promise<void>((r) => (finish = r));
    const publishing = await jobs.enqueue(
      "archive",
      "Publishing",
      async ({ signal, commit }) => {
        commit();
        committed = true;
        await publishGate;
        expect(signal.aborted).toBe(false);
        return { published: true };
      },
    );
    await until(() => committed);
    const late = jobs.cancel(publishing.id);
    finish();
    expect(await late).toMatchObject({
      status: "completed",
      result: { published: true },
    });
  } finally {
    await jobs.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
it("queued archive cancellation is reflected in persisted operation history", async () => {
  const f = await fixture(),
    runtime = new StudioRuntime(f.config);
  try {
    await runtime.initialize();
    let entered = false,
      release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await runtime.jobs.enqueue("render", "Occupy slot", async ({ signal }) => {
      entered = true;
      await Promise.race([
        gate,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      return {};
    });
    await until(() => entered);
    const result = await queueArchive(runtime, "export", {
      projectPath: f.store.root,
      outputPath: path.join(f.root, "never.mcpstudio"),
      expectedRevision: 1,
    });
    await runtime.jobs.cancel(result.job.id);
    expect(
      (await listArchiveJobs(f.config)).operations.find(
        (o) => o.id === result.operationId,
      )!.status,
    ).toBe("cancelled");
    release();
    await runtime.jobs.close();
    await expect(
      stat(path.join(f.root, "never.mcpstudio")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runtime.jobs.close();
    await rm(f.root, { recursive: true, force: true });
  }
}, 20000);
it("restart recovery removes only the exact dead-operation temporary and preserves any published destination", async () => {
  const f = await fixture();
  try {
    const id = randomUUID(),
      output = path.join(f.root, "published.mcpstudio"),
      temporary = path.join(f.root, ".published.mcpstudio." + id + ".tmp"),
      operations = path.join(f.root, "archive-operations");
    await mkdir(operations);
    await writeFile(output, "published");
    await writeFile(temporary, "interrupted");
    const record = {
      id,
      type: "export",
      ownerPid: spawnSync(process.execPath, ["-e", ""]).pid,
      status: "running",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      input: { outputPath: output },
      temporary,
      directory: false,
    };
    await writeFile(
      path.join(operations, id + ".json"),
      JSON.stringify(record),
    );
    await recoverArchiveJobs(f.config);
    await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(output, "utf8")).toBe("published");
    expect((await listArchiveJobs(f.config)).operations[0]!.status).toBe(
      "interrupted",
    );
    const badId = randomUUID();
    await writeFile(
      path.join(operations, badId + ".json"),
      JSON.stringify({ ...record, id: badId, temporary: output }),
    );
    await recoverArchiveJobs(f.config);
    expect(await readFile(output, "utf8")).toBe("published");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 20000);
it("consolidation rejects changed linked content and stale no-op revisions without changing project or old managed bytes", async () => {
  const f = await fixture();
  try {
    const before = await f.store.read();
    await writeFile(f.source, Buffer.alloc(1024 * 1024, 99));
    await expect(consolidateMedia(f.store, undefined, 1)).rejects.toThrow(
      "content changed",
    );
    expect(await f.store.read()).toEqual(before);
    await expect(consolidateMedia(f.store, [], 0)).rejects.toThrow("revision");
    await writeFile(f.source, Buffer.alloc(1024 * 1024, 37));
    await consolidateMedia(f.store, undefined, 1);
    const after = await f.store.read(),
      media = after.media[0]!;
    expect(media.storage.mode).toBe("managed");
    if (media.storage.mode === "managed")
      expect(
        await sha256File(path.join(f.store.root, media.storage.relativePath)),
      ).toMatchObject({ sha256: before.media[0]!.storage.sha256 });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 20000);
