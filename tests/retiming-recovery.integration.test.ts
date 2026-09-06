import {
  mkdtemp,
  rm,
  readFile,
  mkdir,
  writeFile,
  access,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import {
  defaultClip,
  secondsToTicks,
  type JobRecord,
} from "@mcp-video-studio/contracts";
import { readJson, writeJson } from "@mcp-video-studio/core";
import { loadConfig, runChecked } from "@mcp-video-studio/media";
import { StudioRuntime } from "../packages/server/src/runtime.js";
import { queueRetimeClip } from "../packages/server/src/retiming.js";
import {
  recoverRetimeJobs,
  type RetimeOperation,
} from "../packages/server/src/retiming-recovery.js";
const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
integration.each(["committed", "undone", "orphan"] as const)(
  "recovers a interrupted retiming receipt using only the committed cursor (%s)",
  async (scenario) => {
    const root = await mkdtemp(
        path.join(os.tmpdir(), "studio-retime-recover-"),
      ),
      config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root }),
      runtime = new StudioRuntime(config);
    await runtime.initialize();
    try {
      const created = await runtime.createProject("Recovery"),
        projectPath = created.projectPath as string,
        store = runtime.store(projectPath),
        input = path.join(root, "source.wav");
      await runChecked(config.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2",
        input,
      ]);
      await runtime.import({
        projectPath,
        expectedRevision: 0,
        filePath: input,
        storageMode: "managed",
      });
      await expect
        .poll(
          () =>
            runtime.jobs
              .list()
              .every((j) =>
                ["completed", "failed", "cancelled"].includes(j.status),
              ),
          { timeout: 30000 },
        )
        .toBe(true);
      let project = await store.read();
      const sequence = project.sequences[0]!,
        clip = defaultClip(
          sequence.tracks.find((t) => t.type === "audio")!.id,
          { type: "media", mediaId: project.media[0]!.id },
          "Recover",
          secondsToTicks(1),
        );
      await runtime.apply(projectPath, project.revision, [
        { type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" },
      ]);
      project = await store.read();
      const before = await readFile(path.join(projectPath, "project.json"));
      const result = await queueRetimeClip(runtime, {
          projectPath,
          expectedRevision: project.revision,
          sequenceId: sequence.id,
          clipId: clip.id,
          mode: "reverse",
        }),
        id = (result.job as JobRecord).id;
      await expect
        .poll(() => runtime.jobs.get(id)?.status, { timeout: 30000 })
        .toBe("completed");
      const completed = runtime.jobs.get(id)!;
      await runtime.jobs.close();
      if (scenario === "undone")
        await store.undo((await store.read()).revision);
      if (scenario === "orphan")
        await writeFile(path.join(projectPath, "project.json"), before);
      const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
      await once(child, "exit");
      const operationFile = path.join(
          config.dataDir,
          "retiming-operations",
          String(result.operationId) + ".json",
        ),
        operation = await readJson<RetimeOperation>(operationFile);
      operation.ownerPid = child.pid!;
      operation.status = "ready";
      delete operation.result;
      await mkdir(operation.scratch!, { recursive: true });
      await writeFile(path.join(operation.scratch!, "owned"), "owned");
      const canary = path.join(root, "unrelated");
      await mkdir(canary);
      await writeFile(path.join(canary, "keep"), "keep");
      await writeJson(operationFile, operation);
      const { result: _, ...withoutResult } = completed;
      await writeJson(path.join(config.dataDir, "jobs", id + ".json"), {
        ...withoutResult,
        status: "running",
      });
      await recoverRetimeJobs(config);
      const recovered = await readJson<JobRecord>(
        path.join(config.dataDir, "jobs", id + ".json"),
      );
      expect(recovered.status).toBe(
        scenario === "orphan" ? "failed" : "completed",
      );
      if (scenario !== "orphan") {
        expect(recovered.result?.operationId).toBe(operation.id);
        expect(recovered.result?.transactionId).toBe(
          completed.result?.transactionId,
        );
        expect(recovered.result?.recovered).toBe(true);
      } else expect(recovered.error?.code).toBe("RETIMING_INTERRUPTED");
      await expect(access(operation.scratch!)).rejects.toThrow();
      expect(await readFile(path.join(canary, "keep"), "utf8")).toBe("keep");
      const restarted = new StudioRuntime(config);
      await restarted.initialize();
      try {
        expect(restarted.jobs.get(id)?.status).toBe(recovered.status);
        expect((await store.read()).revision).toBe(
          scenario === "orphan"
            ? project.revision
            : project.revision + (scenario === "undone" ? 2 : 1),
        );
      } finally {
        await restarted.jobs.close();
      }
    } finally {
      await runtime.jobs.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
