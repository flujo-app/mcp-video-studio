import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { expect, it } from "vitest";
import { ProjectStore, sha256File } from "@mcp-video-studio/core";
import { loadConfig } from "@mcp-video-studio/media";
import {
  recoverExportHistory,
  getExportHistory,
  listExportHistory,
  queueExport,
} from "../packages/server/src/provenance.js";
import { StudioRuntime } from "../packages/server/src/runtime.js";
it("ready export recovery confirms a published checksum, preserves mismatched output and removes only recorded owned staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-export-recovery-")),
    config = loadConfig({ VIDEO_STUDIO_DATA_DIR: root }),
    store = await ProjectStore.create(
      path.join(root, "project"),
      "History recovery",
    );
  try {
    const project = await store.read(),
      directory = path.join(root, "render-operations");
    await mkdir(directory);
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    for (const published of [true, false]) {
      const id = randomUUID(),
        output = path.join(root, id + ".wav"),
        temporary = path.join(root, "." + id + ".wav." + id + ".export"),
        copyTemporary = path.join(
          root,
          "." + path.basename(temporary) + "." + id + ".tmp",
        ),
        scratch = path.join(config.scratchDir, "export-" + id);
      await mkdir(scratch, { recursive: true });
      await writeFile(path.join(scratch, "owned-staged.wav"), "interrupted");
      await writeFile(output, published ? "verified output" : "prior output");
      const hash = await sha256File(output);
      await writeFile(temporary, "staged");
      await writeFile(copyTemporary, "interrupted copy");
      const jobId = randomUUID();
      await mkdir(path.join(root, "jobs"), { recursive: true });
      await writeFile(
        path.join(root, "jobs", jobId + ".json"),
        JSON.stringify({ id: jobId, status: "running", type: "render" }),
      );
      const record = {
        id,
        jobId,
        status: "ready",
        ownerPid: deadPid,
        projectPath: store.root,
        outputPath: output,
        sequenceId: project.sequences[0]!.id,
        presetId: project.exportPresets[0]!.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        projectSnapshot: project,
        temporary,
        scratch,
        result: { ...hash, ...(!published ? { sha256: "a".repeat(64) } : {}) },
      };
      await writeFile(
        path.join(directory, id + ".json"),
        JSON.stringify(record),
      );
      await recoverExportHistory(config);
      expect(
        JSON.parse(
          await readFile(path.join(root, "jobs", jobId + ".json"), "utf8"),
        ).status,
      ).toBe(published ? "completed" : "running");
      expect((await getExportHistory(config, id)).export.status).toBe(
        published ? "completed" : "interrupted",
      );
      expect(await readFile(output, "utf8")).toBe(
        published ? "verified output" : "prior output",
      );
      for (const file of [temporary, copyTemporary, scratch])
        await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const id = randomUUID(),
      innocent = path.join(root, "retain-me");
    await mkdir(innocent);
    await writeFile(path.join(innocent, "user-file"), "keep");
    await writeFile(
      path.join(directory, id + ".json"),
      JSON.stringify({
        id,
        status: "rendering",
        ownerPid: deadPid,
        projectPath: store.root,
        outputPath: path.join(root, "absent.wav"),
        sequenceId: project.sequences[0]!.id,
        presetId: project.exportPresets[0]!.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        projectSnapshot: project,
        temporary: innocent,
        scratch: innocent,
      }),
    );
    await recoverExportHistory(config);
    expect(await readFile(path.join(innocent, "user-file"), "utf8")).toBe(
      "keep",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
it("cancelled queued export history is truthful and does not start rendering or touch existing output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-export-cancel-")),
    config = loadConfig({
      VIDEO_STUDIO_DATA_DIR: root,
      VIDEO_STUDIO_MAX_CONCURRENT_JOBS: "1",
    }),
    runtime = new StudioRuntime(config);
  let release = () => {};
  try {
    await runtime.initialize();
    const created = await runtime.createProject("Cancellation"),
      projectPath = String(created.projectPath),
      project = await runtime.store(projectPath).read();
    await runtime.jobs.enqueue("render", "Hold queue", async ({ signal }) => {
      await Promise.race([
        new Promise<void>((r) => (release = r)),
        new Promise<void>((r) =>
          signal.addEventListener("abort", () => r(), { once: true }),
        ),
      ]);
      return {};
    });
    const output = path.join(root, "existing.wav");
    await writeFile(output, "prior");
    const queued = await queueExport(runtime, {
      projectPath,
      sequenceId: project.sequences[0]!.id,
      presetId: project.exportPresets[0]!.id,
      outputPath: output,
    });
    await runtime.jobs.cancel((queued.job as { id: string }).id);
    expect(
      (await getExportHistory(config, queued.exportId)).export.status,
    ).toBe("cancelled");
    expect(
      (await listExportHistory(config, projectPath)).exports[0]!.status,
    ).toBe("cancelled");
    expect(await readFile(output, "utf8")).toBe("prior");
  } finally {
    release();
    await runtime.jobs.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
