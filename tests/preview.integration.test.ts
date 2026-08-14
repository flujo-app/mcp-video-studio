import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { framesToTicks } from "@mcp-video-studio/contracts";
import { loadConfig } from "@mcp-video-studio/media";
import { startGateway } from "../packages/server/src/gateway.js";
import { StudioRuntime } from "../packages/server/src/runtime.js";

const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;

async function waitForJob(runtime: StudioRuntime, id: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const job = runtime.jobs.get(id);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

describe("program preview integration", () => {
  integration("renders a revision cache and serves byte ranges securely", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-preview-"));
    let close: (() => Promise<void>) | undefined;
    try {
      const config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root, VIDEO_STUDIO_PROJECTS_DIR: path.join(root, "projects"), VIDEO_STUDIO_SCRATCH_DIR: path.join(root, "scratch"), VIDEO_STUDIO_GATEWAY_HOST: "127.0.0.1", VIDEO_STUDIO_GATEWAY_PORT: "0" });
      const runtime = new StudioRuntime(config);
      await runtime.initialize();
      const created = await runtime.createProject("Preview test") as { projectPath: string; project: { revision: number; activeSequenceId: string; sequences: Array<{ id: string; tracks: Array<{ id: string; type: string }> }> } };
      const sequence = created.project.sequences[0]!;
      const videoTrack = sequence.tracks.find((track) => track.type === "video")!;
      const edited = await runtime.addClip({ projectPath: created.projectPath, expectedRevision: created.project.revision, sequenceId: sequence.id, trackId: videoTrack.id, source: { type: "color", color: "#2454a6" }, name: "Blue card", startTick: 0, durationTick: framesToTicks(15, { numerator: 30, denominator: 1 }) }) as { project: { revision: number } };
      const queued = await runtime.renderPreview({ projectPath: created.projectPath, sequenceId: sequence.id }) as { job: { id: string }; revision: number };
      const job = await waitForJob(runtime, queued.job.id);
      expect(job.status, job.error?.message).toBe("completed");
      expect(job.result?.revision).toBe(edited.project.revision);

      const gateway = await startGateway(runtime, "preview-test-token-01234567890123456789");
      close = gateway.close;
      const query = `token=${encodeURIComponent(gateway.token)}&projectPath=${encodeURIComponent(created.projectPath)}&sequenceId=${encodeURIComponent(sequence.id)}&revision=${queued.revision}`;
      const response = await fetch(`${gateway.origin}/preview?${query}`, { headers: { range: "bytes=0-127" } });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toMatch(/^bytes 0-127\//);
      expect((await response.arrayBuffer()).byteLength).toBe(128);

      const cached = await runtime.renderPreview({ projectPath: created.projectPath, sequenceId: sequence.id });
      expect(cached.cached).toBe(true);
      const renamed = await runtime.apply(created.projectPath, edited.project.revision, [{ type: "project.rename", name: "Metadata-only revision" }]) as { project: { revision: number } };
      const crossRevision = await runtime.renderPreview({ projectPath: created.projectPath, sequenceId: sequence.id }) as { cached: boolean; job: { id: string }; revision: number };
      expect(crossRevision.cached).toBe(false);
      expect(crossRevision.revision).toBe(renamed.project.revision);
      const reused = await waitForJob(runtime, crossRevision.job.id);
      expect(reused.status, reused.error?.message).toBe("completed");
      expect(reused.result?.cacheHit).toBe(true);
    } finally {
      await close?.().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 75_000);
});
