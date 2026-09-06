import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createDefaultProject,
  framesToTicks,
  defaultClip,
  secondsToTicks,
  type MediaAsset,
} from "@mcp-video-studio/contracts";
import { loadConfig, probeMedia, runChecked } from "@mcp-video-studio/media";
import {
  retimePlan,
  rampSourceAt,
  type RetimeOptions,
} from "../packages/media/src/retime-plan.js";
import { renderRetimedInput } from "../packages/media/src/retime-render.js";
const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
integration.each([
  { mode: "reverse" },
  { mode: "freeze", freezeAtTick: secondsToTicks(1) },
  { mode: "linear-ramp", startRate: 0.5, endRate: 1.5 },
  { mode: "linear-ramp", startRate: 1.5, endRate: 0.5 },
] satisfies RetimeOptions[])(
  "renders $mode through bounded lossless frames and exact sample counts",
  async (options) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-retiming-"));
    try {
      const config = loadConfig({
          ...process.env,
          VIDEO_STUDIO_DATA_DIR: root,
          VIDEO_STUDIO_SCRATCH_DIR: path.join(root, "scratch"),
        }),
        input = path.join(root, "source.mkv"),
        project = createDefaultProject("Retime");
      project.settings.raster = { width: 640, height: 360 };
      project.settings.fps = { numerator: 10, denominator: 1 };
      await runChecked(config.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=640x360:r=10:d=8,format=rgb24,geq=r='N*2':g='N':b='255-N'",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=8",
        "-c:v",
        "ffv1",
        "-pix_fmt",
        "gbrp",
        "-c:a",
        "pcm_f32le",
        "-ac",
        "2",
        input,
      ]);
      const probe = await probeMedia(input, config),
        media = {
          id: "source",
          name: "source",
          kind: "video",
          probe,
          createdAt: new Date().toISOString(),
          storage: {
            mode: "linked",
            path: input,
            sha256: "0".repeat(64),
            bytes: 1,
            mtimeMs: 0,
          },
        } as MediaAsset,
        clip = defaultClip(
          "track",
          { type: "media", mediaId: media.id },
          "Retime",
          secondsToTicks(4),
        );
      clip.sourceInTick = secondsToTicks(2);
      const plan = retimePlan(project, clip, media, options),
        scratch = path.join(root, "scratch"),
        output = path.join(root, "retimed.mkv");
      expect(
        await renderRetimedInput(
          input,
          media,
          project,
          plan,
          config,
          scratch,
          output,
        ),
      ).toEqual({ frameCount: 40, sampleCount: 192000 });
      const rgb = output + ".rgb",
        pcm = output + ".f32";
      await runChecked(config.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-i",
        output,
        "-map",
        "0:v:0",
        "-fps_mode",
        "passthrough",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        rgb,
      ]);
      await runChecked(config.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-i",
        output,
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        pcm,
      ]);
      const pixels = await readFile(rgb),
        audio = await readFile(pcm),
        frameBytes = 640 * 360 * 3;
      expect(pixels.length).toBe(40 * frameBytes);
      expect(audio.length).toBe(192000 * 2 * 4);
      if (options.mode === "reverse") {
        const normalized = path.join(scratch, "normal.rgb");
        await runChecked(config.ffmpegPath, [
          "-hide_banner",
          "-y",
          "-i",
          path.join(scratch, "video.nut"),
          "-fps_mode",
          "passthrough",
          "-pix_fmt",
          "rgb24",
          "-f",
          "rawvideo",
          normalized,
        ]);
        const before = await readFile(normalized);
        for (let frame = 0; frame < 40; frame++)
          expect(
            pixels
              .subarray(frame * frameBytes, (frame + 1) * frameBytes)
              .equals(
                before.subarray(
                  (39 - frame) * frameBytes,
                  (40 - frame) * frameBytes,
                ),
              ),
          ).toBe(true);
        const beforeAudio = await readFile(path.join(scratch, "audio.f32"));
        for (let sample = 0; sample < 192000; sample++)
          expect(
            audio
              .subarray(sample * 8, (sample + 1) * 8)
              .equals(
                beforeAudio.subarray(
                  (191999 - sample) * 8,
                  (192000 - sample) * 8,
                ),
              ),
          ).toBe(true);
      } else if (options.mode === "freeze") {
        for (let frame = 0; frame < 40; frame++) {
          expect(pixels[frame * frameBytes]).toBe(60);
          expect(
            pixels
              .subarray(frame * frameBytes, (frame + 1) * frameBytes)
              .equals(pixels.subarray(0, frameBytes)),
          ).toBe(true);
        }
        for (let sample = 0; sample < audio.length / 4; sample++)
          expect(audio.readFloatLE(sample * 4) === 0).toBe(true);
      } else {
        for (const frame of [0, 5, 10, 15, 20, 25, 30, 35, 39]) {
          const sourceFrame = pixels[frame * frameBytes]! / 2,
            ideal = (plan.sourceStart + rampSourceAt(plan, frame / 10)) * 10;
          expect(Math.abs(sourceFrame - ideal)).toBeLessThanOrEqual(1.1);
        }
        for (const [start, end] of [
          [0.25, 0.75],
          [1.25, 1.75],
          [2.25, 2.75],
          [3.5, 3.95],
        ]) {
          let crossings = 0,
            energy = 0,
            previous = 0;
          for (
            let sample = Math.round(start! * 48000);
            sample < Math.round(end! * 48000);
            sample++
          ) {
            const value = audio.readFloatLE(sample * 8);
            expect(Number.isFinite(value)).toBe(true);
            if (previous <= 0 && value > 0) crossings++;
            energy += value * value;
            previous = value;
          }
          console.log(
            "RETIME_AUDIO_WINDOW",
            JSON.stringify({
              options,
              start,
              end,
              frequency: crossings / (end! - start!),
              rms: Math.sqrt(energy / Math.round((end! - start!) * 48000)),
            }),
          );
          expect(
            Math.sqrt(energy / Math.round((end! - start!) * 48000)),
          ).toBeGreaterThan(0.005);
          const expectedFrequency =
            440 *
            (options.startRate! +
              ((options.endRate! - options.startRate!) *
                ((start! + end!) / 2)) /
                4);
          expect(
            Math.abs(crossings / (end! - start!) - expectedFrequency),
          ).toBeLessThan(8);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  180000,
);

integration.each(["reverse", "freeze", "linear-ramp"] as const)(
  "validates final mux PCM at a fractional31-frame boundary (%s)",
  async (mode) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "studio-retime-fractional-"),
    );
    try {
      const config = loadConfig({
          ...process.env,
          VIDEO_STUDIO_DATA_DIR: root,
        }),
        input = path.join(root, "input.mkv"),
        project = createDefaultProject("Fractional");
      project.settings.fps = { numerator: 30000, denominator: 1001 };
      project.settings.raster = { width: 160, height: 90 };
      await runChecked(config.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=s=160x90:r=30:d=3",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=3",
        "-c:v",
        "ffv1",
        "-c:a",
        "pcm_f32le",
        "-ac",
        "2",
        input,
      ]);
      const media = {
          id: "source",
          kind: "video",
          probe: await probeMedia(input, config),
        } as MediaAsset,
        clip = defaultClip(
          "v",
          { type: "media", mediaId: "source" },
          "Fractional",
          framesToTicks(31, project.settings.fps),
        );
      clip.sourceInTick = secondsToTicks(1);
      const plan = retimePlan(project, clip, media, {
          mode,
          startRate: 0.5,
          endRate: 1.5,
        }),
        output = path.join(root, "output.mkv");
      expect(plan.sampleCount).toBe(49650);
      expect(
        await renderRetimedInput(
          input,
          media,
          project,
          plan,
          config,
          path.join(root, "scratch"),
          output,
        ),
      ).toEqual({ frameCount: 31, sampleCount: 49650 });
      const decoded = path.join(root, "decoded.f32");
      await runChecked(config.ffmpegPath, [
        "-hide_banner",
        "-y",
        "-i",
        output,
        "-map",
        "0:a:0",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        decoded,
      ]);
      expect((await readFile(decoded)).length).toBe(49650 * 2 * 4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
