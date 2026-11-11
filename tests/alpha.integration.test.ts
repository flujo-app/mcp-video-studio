import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultClip, framesToTicks, type StudioProject } from "@mcp-video-studio/contracts";
import { alphaDecoderArgs, loadConfig, probeMedia, runChecked, type StudioConfig } from "@mcp-video-studio/media";
import {
  analysisSize,
  exportAlphaLoop,
  exportAlphaStill,
  frameDifference,
  maxCornerAlpha,
  opaqueShare,
  readRgbaFrames,
  runQc
} from "@mcp-video-studio/renderer";
import { StudioRuntime } from "../packages/server/src/runtime.js";

const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
const fps = { numerator: 24, denominator: 1 };
const GREEN = "0x00b140";

/** An orange square on a plain green backdrop. `motion` is an FFmpeg x expression over frame number n. */
async function greenScreenClip(config: StudioConfig, outputPath: string, frames: number, motion: string): Promise<void> {
  await runChecked(config.ffmpegPath, [
    "-hide_banner", "-v", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${GREEN}:s=160x120:r=24`,
    "-f", "lavfi", "-i", "color=c=0xff7a00:s=40x40:r=24",
    "-filter_complex", `[0][1]overlay=x='${motion}':y=40:eval=frame,trim=end_frame=${frames}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", outputPath
  ]);
}

async function decodeAll(config: StudioConfig, filePath: string) {
  const probe = await probeMedia(filePath, config);
  const size = analysisSize(probe, 160);
  return { probe, size, ...(await readRgbaFrames(config, filePath, { ...size, inputArgs: alphaDecoderArgs(probe) })) };
}

/** Average colour of the solid pixels. */
function solidColor(frame: Uint8Array): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  let count = 0;
  for (let index = 0; index < frame.length; index += 4) {
    if (frame[index + 3]! < 250) continue;
    sum[0] += frame[index]!; sum[1] += frame[index + 1]!; sum[2] += frame[index + 2]!; count += 1;
  }
  return sum.map((value) => value / Math.max(1, count)) as [number, number, number];
}

/** Sum of alpha as a share of the picture: the 40x40 square covers 1600 / 19200 ≈ 0.083. */
function coverage(frame: Uint8Array): number {
  let sum = 0;
  for (let index = 3; index < frame.length; index += 4) sum += frame[index]! / 255;
  return sum / (frame.length / 4);
}

/** `faded`: cross-fade frames, where two partly solid copies of the square are mixed. */
function expectSeeThroughSubject(decoded: Awaited<ReturnType<typeof decodeAll>>, faded: (index: number) => boolean = () => false): void {
  for (const [index, frame] of decoded.frames.entries()) {
    // Backdrop gone: every corner is clear.
    expect(maxCornerAlpha(frame, decoded.size.width, decoded.size.height)).toBeLessThanOrEqual(16);
    // The subject's total coverage is unchanged, also while it is being cross-faded.
    expect(coverage(frame)).toBeGreaterThan(0.07);
    expect(coverage(frame)).toBeLessThan(0.1);
    if (faded(index)) continue;
    // Subject kept: the 40x40 square is ~8% of the picture and stays solid orange.
    expect(opaqueShare(frame)).toBeGreaterThan(0.06);
    const [red, green, blue] = solidColor(frame);
    expect(red).toBeGreaterThan(200);
    expect(green).toBeGreaterThan(80);
    expect(green).toBeLessThan(170);
    expect(blue).toBeLessThan(60);
  }
}

describe("see-through loop export", () => {
  integration("removes a green backdrop, cross-fades the loop, and keeps alpha through WebM, stills, and re-import", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-alpha-"));
    try {
      const config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root, VIDEO_STUDIO_SCRATCH_DIR: path.join(root, "scratch") });
      const source = path.join(root, "dancer.mp4");
      // Linear motion: the last frame is far from the first, so a plain loop would visibly jump.
      await greenScreenClip(config, source, 48, "8+2*n");

      const loopPath = path.join(root, "out", "dancer-loop.webm");
      const result = await exportAlphaLoop(config, { inputPath: source, outputPath: loopPath, stillTimesTick: [0, framesToTicks(20, fps)] }) as Record<string, any>;
      expect(result.success).toBe(true);
      expect(result.backdrop.removed).toBe(true);
      expect(result.backdrop.method).toBe("chroma");
      const detected = result.backdrop.detected.rgb as number[];
      expect(Math.hypot(detected[0]! - 0x00, detected[1]! - 0xb1, detected[2]! - 0x40)).toBeLessThan(24);
      expect(result.loop).toMatchObject({ mode: "crossfade", sourceFrames: 48, droppedDuplicateEndFrame: false, crossfadeFrames: 6, plannedFrames: 42 });
      expect(result.frameCount).toBe(42);
      expect(result.durationTick).toBe(framesToTicks(42, fps));
      expect(result.qc.passed).toBe(true);

      const decoded = await decodeAll(config, loopPath);
      expect(decoded.probe.videoCodec).toBe("vp9");
      expect(decoded.probe.hasAlpha).toBe(true);
      expect(decoded.probe.frameRate).toEqual(fps);
      const libvpx = await runChecked(config.ffprobePath, ["-v", "error", "-c:v", "libvpx-vp9", "-show_entries", "stream=pix_fmt:stream_tags", "-of", "json", loopPath]);
      expect(libvpx.stdout).toContain("yuva420p");
      expect(libvpx.stdout.toLowerCase()).toContain("\"alpha_mode\": \"1\"");
      expect(decoded.frames).toHaveLength(42);
      expectSeeThroughSubject(decoded, (index) => index >= 36);

      // The wrap from last to first frame is now about as small as an ordinary step instead of a jump.
      const steps = decoded.frames.slice(1).map((frame, index) => frameDifference(decoded.frames[index]!, frame));
      const seamAfter = frameDifference(decoded.frames.at(-1)!, decoded.frames[0]!);
      expect(seamAfter).toBeLessThan(result.loop.seamBefore / 3);
      expect(seamAfter).toBeLessThanOrEqual(Math.max(...steps) * 1.25);
      expect(seamAfter).toBeLessThan(0.03);

      expect(result.stills).toHaveLength(2);
      for (const still of result.stills as Array<{ path: string; frame: number }>) {
        const image = await decodeAll(config, still.path);
        expect(image.probe.pixelFormat).toBe("rgba");
        expect(image.frames).toHaveLength(1);
        expectSeeThroughSubject(image);
      }
      expect((result.stills as Array<{ frame: number }>).map((still) => still.frame)).toEqual([0, 20]);

      // Alpha survives a second pass: a transparent source is not keyed again, and ping-pong keeps it see-through.
      const pingPath = path.join(root, "out", "dancer-pingpong.webm");
      const ping = await exportAlphaLoop(config, { inputPath: loopPath, outputPath: pingPath, mode: "pingpong" }) as Record<string, any>;
      expect(ping.backdrop.removed).toBe(false);
      expect(ping.frameCount).toBe(42 * 2 - 2);
      expect(ping.qc.passed).toBe(true);
      expectSeeThroughSubject(await decodeAll(config, pingPath), (index) => index >= 36 && index <= 46);

      const stillPath = path.join(root, "out", "frame-10.png");
      const still = await exportAlphaStill(config, { inputPath: loopPath, outputPath: stillPath, atTick: framesToTicks(10, fps) }) as Record<string, any>;
      expect(still).toMatchObject({ frame: 10, backdrop: { removed: false } });
      expect(still.cornerAlpha).toBeLessThanOrEqual(16);
      const stillFrames = await decodeAll(config, stillPath);
      expectSeeThroughSubject(stillFrames);
      // Frame-exact: the still matches frame 10 of the loop better than its neighbours.
      const toFrame = (index: number) => frameDifference(stillFrames.frames[0]!, decoded.frames[index]!);
      expect(toFrame(10)).toBeLessThan(0.01);
      expect(toFrame(10)).toBeLessThan(toFrame(9));
      expect(toFrame(10)).toBeLessThan(toFrame(11));    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  integration("drops a repeated end frame and leaves an already seamless loop uncut", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-alpha-"));
    try {
      const config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root, VIDEO_STUDIO_SCRATCH_DIR: path.join(root, "scratch") });
      const source = path.join(root, "periodic.mp4");
      // 49 frames of a full back-and-forth cycle: frame 48 repeats frame 0.
      await greenScreenClip(config, source, 49, "60+40*sin(2*PI*n/48)");
      const result = await exportAlphaLoop(config, { inputPath: source, outputPath: path.join(root, "periodic.webm"), key: { color: "#00b140" } }) as Record<string, any>;
      expect(result.loop).toMatchObject({ sourceFrames: 49, droppedDuplicateEndFrame: true, crossfadeFrames: 0, plannedFrames: 48 });
      expect(result.frameCount).toBe(48);
      expect(result.backdrop).toMatchObject({ removed: true, color: "#00b140" });
      expect(result.qc.passed).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  integration("renders a keyed timeline over transparency and loops a whole sequence through the runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-alpha-"));
    try {
      const config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root, VIDEO_STUDIO_PROJECTS_DIR: path.join(root, "projects"), VIDEO_STUDIO_SCRATCH_DIR: path.join(root, "scratch") });
      const runtime = new StudioRuntime(config);
      await runtime.initialize();
      const source = path.join(root, "dancer.mp4");
      await greenScreenClip(config, source, 48, "8+2*n");
      const created = await runtime.createProject("Alpha project") as { projectPath: string; project: StudioProject };
      const store = runtime.store(created.projectPath);
      await store.replace(0, (project) => { project.settings.raster = { width: 160, height: 120 }; project.settings.fps = fps; }, { sequences: [], tracks: [], clips: [], media: [], animations: [], generatedArtifacts: [] });
      const imported = await runtime.import({ projectPath: created.projectPath, filePath: source, expectedRevision: 1 }) as { project: StudioProject; asset: { media: { id: string } } };
      const sequence = imported.project.sequences[0]!;
      const track = sequence.tracks.find((item) => item.type === "video")!;
      const clip = defaultClip(track.id, { type: "media", mediaId: imported.asset.media.id }, "Dancer", framesToTicks(48, fps));
      clip.effects = [{ id: "key-1", type: "backdropKey", enabled: true, version: 1, parameters: { color: "auto" } }];
      await runtime.apply(created.projectPath, imported.project.revision, [{ type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" }]);

      const webm = path.join(root, "sequence.webm");
      const render = await runtime.render({ projectPath: created.projectPath, sequenceId: sequence.id, presetId: "web-vp9-alpha", outputPath: webm }) as { job: { id: string } };
      const rendered = await waitForJob(runtime, render.job.id);
      expect(rendered.status, rendered.error?.message).toBe("completed");
      expect(rendered.result?.frameCount).toBe(48);
      const qc = await runQc(store, sequence.id, webm, config) as { passed: boolean; checks: Array<{ id: string; status: string }> };
      expect(qc.checks.filter((check) => check.id.startsWith("alpha.")).map((check) => check.status)).toEqual(["PASS", "PASS", "PASS"]);
      expect(qc.passed).toBe(true);
      expectSeeThroughSubject(await decodeAll(config, webm));

      const looped = path.join(root, "sequence-loop.webm");
      const queued = await runtime.alphaLoop({ projectPath: created.projectPath, sequenceId: sequence.id, outputPath: looped, crossfadeFrames: 8 }) as { job: { id: string } };
      const job = await waitForJob(runtime, queued.job.id);
      expect(job.status, job.error?.message).toBe("completed");
      expect(job.result).toMatchObject({ frameCount: 40, backdrop: { removed: false }, loop: { crossfadeFrames: 8, sourceFrames: 48 }, qc: { passed: true } });
      expectSeeThroughSubject(await decodeAll(config, looped), (index) => index >= 32);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 180_000);
});

async function waitForJob(runtime: StudioRuntime, id: string) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const job = runtime.jobs.get(id);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}
