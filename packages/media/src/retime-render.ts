import { rampPcmFile } from "./ramp-pcm.js";
import { writeFile, stat, statfs, mkdir } from "node:fs/promises";
import path from "node:path";
import type { MediaAsset, StudioProject } from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";
import { ffmpegArtifact } from "./artifacts.js";
import {
  runChecked,
  filterScriptOption,
  requireFfmpegFilters,
} from "./process.js";
import type { StudioConfig } from "./config.js";
import { rampVideoExpression, type RetimePlan } from "./retime-plan.js";
import { reversePcmFile } from "./reverse-pcm.js";
function tempos(rate: number): string[] {
  const filters: string[] = [];
  while (rate > 2) {
    filters.push("atempo=2");
    rate /= 2;
  }
  while (rate < 0.5) {
    filters.push("atempo=0.5");
    rate /= 0.5;
  }
  if (Math.abs(rate - 1) > 1e-12) filters.push("atempo=" + rate);
  return filters;
}
export async function renderRetimedInput(
  input: string,
  media: MediaAsset,
  project: StudioProject,
  plan: RetimePlan,
  config: StudioConfig,
  scratch: string,
  output: string,
  signal?: AbortSignal,
  progress?: (value: number, message: string) => Promise<void>,
): Promise<{ frameCount: number; sampleCount: number }> {
  signal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(60 * 60_000),
  ]);
  await mkdir(scratch, { recursive: true });
  signal.throwIfAborted();
  const fps =
      project.settings.fps.numerator + "/" + project.settings.fps.denominator,
    rate = project.settings.sampleRate,
    channels = project.settings.channels,
    layout = channels === 1 ? "mono" : channels === 6 ? "5.1" : "stereo",
    hasVideo = media.probe.hasVideo,
    hasAudio = media.probe.hasAudio;
  const width = media.probe.width ?? project.settings.raster.width,
    height = media.probe.height ?? project.settings.raster.height;
  if (width * height > 8294400)
    throw new StudioException(
      "RETIMING_RASTER_LIMIT",
      "Retiming supports source rasters up to 4K pixels.",
      "policy",
    );
  const space = await statfs(scratch),
    estimate =
      (hasVideo ? width * height * 8 * plan.frameCount * 2 : 0) +
      (hasAudio
        ? Math.ceil(
            (plan.sourceEnd - plan.sourceStart + plan.duration * 4) * rate,
          ) *
          channels *
          4
        : 0) +
      64 * 1024 * 1024;
  if (space.bavail * space.bsize < estimate)
    throw new StudioException(
      "RETIMING_DISK_SPACE",
      "Free scratch space is insufficient for bounded lossless retiming.",
      "dependency",
      { estimatedBytes: estimate },
    );
  const options = {
      ...(signal ? { signal } : {}),
      timeoutMs: 60 * 60_000,
      maxOutputChars: 200000,
    },
    base = ["-protocol_whitelist", "file,pipe,data", "-i", input],
    video = path.join(scratch, "video.nut");
  let videoInput = video;
  if (hasVideo) {
    await requireFfmpegFilters(config.ffmpegPath, [
      "trim",
      "fps",
      "setpts",
      ...(plan.mode === "reverse"
        ? ["reverse"]
        : plan.mode === "freeze"
          ? ["loop"]
          : []),
    ]);
    const sourceFps = media.probe.frameRate ?? project.settings.fps,
      sourceFrame = sourceFps.denominator / sourceFps.numerator,
      alignedStart =
        Math.floor((plan.sourceStart + 1e-9) / sourceFrame) * sourceFrame;
    const filters =
      plan.mode === "freeze"
        ? [
            "trim=start=" +
              alignedStart +
              ":end=" +
              (plan.sourceEnd + sourceFrame),
            "select=eq(n\\,0)",
            "loop=loop=" + (plan.frameCount - 1) + ":size=1:start=0",
            "setpts=N/(" + fps + "*TB)",
          ]
        : [
            "trim=start=" +
              alignedStart +
              ":end=" +
              (plan.sourceEnd + sourceFrame),
            "setpts=PTS-" + plan.sourceStart + "/TB",
            "setpts=" +
              (plan.mode === "linear-ramp"
                ? "'" + rampVideoExpression(plan) + "'"
                : "T/" + plan.startRate + "/TB"),
            "fps=fps=" + fps + ":start_time=0",
            "tpad=stop_mode=clone:stop=-1",
          ];
    filters.push(
      "trim=end_frame=" + plan.frameCount,
      "setpts=N/(" + fps + "*TB)",
      "format=gbrap16le",
    );
    const graph = path.join(scratch, "video.txt");
    await writeFile(graph, "[0:v:0]" + filters.join(",") + "[v]");
    await ffmpegArtifact(
      config,
      [
        ...base,
        await filterScriptOption(config.ffmpegPath),
        graph,
        "-map",
        "[v]",
        "-an",
        "-frames:v",
        String(plan.frameCount),
        "-r",
        fps,
        "-fps_mode",
        "cfr",
        "-c:v",
        "ffv1",
        "-level",
        "3",
        "-pix_fmt",
        "gbrap16le",
      ],
      video,
      options,
    );
    await progress?.(0.25, "Prepared source video");
    if (plan.mode === "reverse") {
      const framesPerChunk = Math.max(
          1,
          Math.floor((64 * 1024 * 1024) / (width * height * 8)),
        ),
        list: string[] = [];
      let index = 0;
      for (let end = plan.frameCount; end > 0; ) {
        signal?.throwIfAborted();
        const start = Math.max(0, end - framesPerChunk),
          name = "reverse-" + index + ".nut",
          target = path.join(scratch, name);
        await ffmpegArtifact(
          config,
          [
            "-i",
            video,
            "-vf",
            "trim=start_frame=" +
              start +
              ":end_frame=" +
              end +
              ",reverse,setpts=N/(" +
              fps +
              "*TB)",
            "-an",
            "-frames:v",
            String(end - start),
            "-r",
            fps,
            "-fps_mode",
            "cfr",
            "-c:v",
            "ffv1",
            "-level",
            "3",
            "-pix_fmt",
            "gbrap16le",
          ],
          target,
          options,
        );
        list.push(
          "file '" + name + "'",
          "duration " +
            ((end - start) * project.settings.fps.denominator) /
              project.settings.fps.numerator,
        );
        end = start;
        index++;
        await progress?.(
          0.25 + (0.4 * (plan.frameCount - end)) / plan.frameCount,
          "Reversed bounded video chunk",
        );
      }
      const listFile = path.join(scratch, "reverse.ffconcat");
      await writeFile(
        listFile,
        "ffconcat version 1.0\n" + list.join("\n") + "\n",
      );
      videoInput = path.join(scratch, "reversed.nut");
      await ffmpegArtifact(
        config,
        [
          "-f",
          "concat",
          "-safe",
          "1",
          "-i",
          listFile,
          "-vf",
          "setpts=N/(" + fps + "*TB),trim=end_frame=" + plan.frameCount,
          "-an",
          "-frames:v",
          String(plan.frameCount),
          "-r",
          fps,
          "-fps_mode",
          "cfr",
          "-c:v",
          "ffv1",
          "-level",
          "3",
          "-pix_fmt",
          "gbrap16le",
        ],
        videoInput,
        options,
      );
    }
  }
  const audio = path.join(scratch, "audio.f32");
  let audioInput = audio;
  if (hasAudio) {
    const sampleRate = media.probe.sampleRate ?? rate,
      firstSample = Math.round(plan.sourceStart * sampleRate),
      lastSample = Math.round(plan.sourceEnd * sampleRate),
      filters: string[] = [];
    if (plan.mode === "freeze") filters.push("volume=0");
    else
      filters.push(
        "atrim=start_sample=" + firstSample + ":end_sample=" + lastSample,
        "asetpts=N/SR/TB",
      );
    filters.push("aformat=sample_rates=" + rate + ":channel_layouts=" + layout);
    if (plan.mode !== "freeze" && plan.mode !== "linear-ramp")
      filters.push(...tempos(plan.startRate));
    const preparedSamples =
      plan.mode === "linear-ramp"
        ? Math.round((plan.sourceEnd - plan.sourceStart) * rate)
        : plan.sampleCount;
    filters.push(
      "atrim=end_sample=" + preparedSamples,
      "apad=whole_len=" + preparedSamples,
      "asetpts=N/SR/TB",
    );
    await runChecked(
      config.ffmpegPath,
      [
        "-hide_banner",
        "-y",
        ...base,
        "-map",
        "0:a:0",
        "-af",
        filters.join(","),
        "-vn",
        "-f",
        "f32le",
        "-acodec",
        "pcm_f32le",
        "-ar",
        String(rate),
        "-ac",
        String(channels),
        audio,
      ],
      options,
    );
    if ((await stat(audio)).size !== preparedSamples * channels * 4)
      throw new StudioException(
        "RETIMING_AUDIO_LENGTH",
        "Retimed audio did not contain the exact requested sample count.",
        "runtime",
      );
    if (plan.mode === "linear-ramp") {
      audioInput = path.join(scratch, "ramped.f32");
      await rampPcmFile(audio, audioInput, channels, rate, plan, signal);
    }
    if (plan.mode === "reverse") {
      audioInput = path.join(scratch, "reversed.f32");
      await reversePcmFile(audio, audioInput, channels, signal);
    }
  }
  await progress?.(0.8, "Validating retimed media");
  const args: string[] = [];
  let audioIndex = 0;
  if (hasVideo) {
    args.push("-i", videoInput);
    audioIndex++;
  }
  if (hasAudio)
    args.push(
      "-f",
      "f32le",
      "-ar",
      String(rate),
      "-ac",
      String(channels),
      "-i",
      audioInput,
    );
  if (hasVideo) args.push("-map", "0:v:0", "-c:v", "copy");
  if (hasAudio) args.push("-map", audioIndex + ":a:0", "-c:a", "pcm_f32le");
  args.push("-t", String(plan.duration));
  await ffmpegArtifact(config, args, output, options);
  if (hasVideo) {
    const stream = JSON.parse(
      (
        await runChecked(
          config.ffprobePath,
          [
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "json",
            output,
          ],
          options,
        )
      ).stdout,
    ) as { streams: Array<{ nb_read_frames?: string }> };
    if (Number(stream.streams[0]?.nb_read_frames) !== plan.frameCount)
      throw new StudioException(
        "RETIMING_VIDEO_LENGTH",
        "Retimed video did not contain the exact requested frame count.",
        "runtime",
      );
  }
  if (hasAudio) {
    const decoded = path.join(scratch, "verified-output.f32");
    await runChecked(
      config.ffmpegPath,
      [
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
      ],
      options,
    );
    if ((await stat(decoded)).size !== plan.sampleCount * channels * 4)
      throw new StudioException(
        "RETIMING_MUX_AUDIO_LENGTH",
        "Published media did not retain every planned audio sample.",
        "runtime",
      );
  }
  return {
    frameCount: hasVideo ? plan.frameCount : 0,
    sampleCount: hasAudio ? plan.sampleCount : 0,
  };
}
