import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultClip, framesToTicks } from "@mcp-video-studio/contracts";
import { ProjectStore } from "@mcp-video-studio/core";
import { importMedia, loadConfig, runChecked } from "@mcp-video-studio/media";
import { renderSequence, runQc } from "@mcp-video-studio/renderer";

const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;

describe("FFmpeg render integration", () => {
  integration("renders and quality-checks a canonical timeline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-render-"));
    try {
      const store = await ProjectStore.create(path.join(root, "project"), "Render test");
      await store.replace(0, (project) => { project.settings.raster = { width: 320, height: 180 }; }, { sequences: [], tracks: [], clips: [], media: [], animations: [], generatedArtifacts: [] });
      const config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root, VIDEO_STUDIO_SCRATCH_DIR: path.join(root, "scratch") });
      const sourcePath = path.join(root, "source.mp4");
      await runChecked(config.ffmpegPath, ["-hide_banner", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", sourcePath]);
      const imported = await importMedia(store, sourcePath, "managed", 1, config);
      const project = await store.read();
      const sequence = project.sequences[0]!;
      const videoTrack = sequence.tracks.find((track) => track.type === "video")!;
      const clip = defaultClip(videoTrack.id, { type: "media", mediaId: imported.asset.media.id }, "Fixture", framesToTicks(30, project.settings.fps));
      const captionTrack = sequence.tracks.find((track) => track.type === "caption")!;
      const captionId = crypto.randomUUID();
      await store.mutate(project.revision, [
        { type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" },
        { type: "caption.add", sequenceId: sequence.id, caption: { id: captionId, trackId: captionTrack.id, startTick: 0, durationTick: framesToTicks(30, project.settings.fps), text: "Caption: 100% ready, it's real", style: { fontFamily: "Arial", fontSize: 24, color: "#ffffff", background: "#000000aa", position: "bottom", align: "center" } } }
      ]);
      const outputPath = path.join(root, "output.mp4");
      const render = await renderSequence(store, config, { sequenceId: sequence.id, presetId: "web-h264-1080p", outputPath }).catch((error: unknown) => {
        const details = (error as { studio?: { details?: unknown } }).studio?.details;
        if (details) console.error(details);
        throw error;
      });
      expect(render.success).toBe(true);
      expect(render.cacheHit).toBe(false);
      expect(render.frameCount).toBe(30);
      expect((render.probe as { width?: number }).width).toBe(320);
      await store.mutate(3, [{ type: "project.rename", name: "Unrelated metadata edit" }]);
      const cachedOutput = path.join(root, "cached-output.mp4");
      const cachedRender = await renderSequence(store, config, { sequenceId: sequence.id, presetId: "web-h264-1080p", outputPath: cachedOutput });
      expect(cachedRender.cacheHit).toBe(true);
      expect(cachedRender.renderKey).toBe(render.renderKey);
      expect(cachedRender.sha256).toBe(render.sha256);
      await store.mutate(4, [{ type: "caption.update", sequenceId: sequence.id, captionId, patch: { text: "A semantic edit invalidates the cache" } }]);
      const changedRender = await renderSequence(store, config, { sequenceId: sequence.id, presetId: "web-h264-1080p", outputPath: path.join(root, "changed-output.mp4") });
      expect(changedRender.cacheHit).toBe(false);
      expect(changedRender.renderKey).not.toBe(render.renderKey);
      const qc = await runQc(store, sequence.id, outputPath, config);
      expect(qc.success).toBe(true);
      expect(qc.passed).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
