import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { framesToTicks, ticksToFrames, ticksToSeconds, type MediaProbe, type Rational } from "@mcp-video-studio/contracts";
import { sha256File, StudioException } from "@mcp-video-studio/core";
import { alphaDecoderArgs, ffmpegArtifact, probeMedia, type StudioConfig } from "@mcp-video-studio/media";
import {
  analysisSize,
  backdropKeyGraph,
  colorHex,
  consecutiveDifferences,
  detectBackdropColor,
  frameDifference,
  maxCornerAlpha,
  median,
  opaqueShare,
  parseColor,
  readRgbaFrames,
  resolveBackdropKey,
  type BackdropDetection,
  type BackdropKeyOptions,
  type ResolvedBackdropKey
} from "./alpha.js";
import { alphaQc } from "./qc.js";

export type LoopMode = "crossfade" | "pingpong" | "none";

export interface LoopPlanInput {
  mode: LoopMode;
  /** Decoded frames in the source range. */
  sourceFrames: number;
  /** Drop the final frame because it repeats the first one. */
  dropLastFrame: boolean;
  /** Requested cross-fade length; when omitted the default is used only if the seam is visibly larger than an ordinary step. */
  crossfadeFrames?: number | undefined;
  defaultCrossfadeFrames: number;
  /** Difference between the (kept) last frame and the first frame. */
  seamBefore: number;
  /** Median difference between neighbouring frames. */
  typicalStep: number;
}

export interface LoopPlan {
  mode: LoopMode;
  sourceFrames: number;
  dropLastFrame: boolean;
  /** Frames that enter the loop step after the optional duplicate end frame is dropped. */
  loopInputFrames: number;
  crossfadeFrames: number;
  outputFrames: number;
  warnings: string[];
}

/** A seam no bigger than this many ordinary frame steps already plays smoothly. */
export const SEAMLESS_STEP_RATIO = 2;

/** Pure frame arithmetic for the loop step, so the reported length is exact before anything is encoded. */
export function planLoop(input: LoopPlanInput): LoopPlan {
  const warnings: string[] = [];
  const loopInputFrames = input.sourceFrames - (input.dropLastFrame ? 1 : 0);
  if (loopInputFrames < 1) throw new StudioException("LOOP_TOO_SHORT", "The clip has no frames to loop.", "input");
  const base = { mode: input.mode, sourceFrames: input.sourceFrames, dropLastFrame: input.dropLastFrame, loopInputFrames, warnings };
  if (input.mode === "none") return { ...base, crossfadeFrames: 0, outputFrames: loopInputFrames };
  if (input.mode === "pingpong") {
    if (loopInputFrames < 3) throw new StudioException("LOOP_TOO_SHORT", "A ping-pong loop needs at least 3 frames.", "input");
    return { ...base, crossfadeFrames: 0, outputFrames: loopInputFrames * 2 - 2 };
  }
  const alreadySeamless = input.seamBefore <= Math.max(SEAMLESS_STEP_RATIO * input.typicalStep, 1e-4);
  let crossfade = input.crossfadeFrames ?? (alreadySeamless ? 0 : input.defaultCrossfadeFrames);
  if (input.crossfadeFrames === undefined && alreadySeamless) warnings.push("The end already flows into the start, so no cross-fade was needed.");
  const maximum = Math.floor((loopInputFrames - 2) / 3);
  if (crossfade > maximum) {
    if (maximum < 1) throw new StudioException("LOOP_TOO_SHORT", `A cross-fade loop needs at least 5 frames; the clip has ${loopInputFrames}.`, "input");
    warnings.push(`The cross-fade was shortened from ${crossfade} to ${maximum} frames to fit the clip.`);
    crossfade = maximum;
  }
  return { ...base, crossfadeFrames: crossfade, outputFrames: loopInputFrames - crossfade };
}

/**
 * Filter-graph statements for the loop step.
 * Cross-fade: the last F frames are faded into the first F frames and those opening frames are
 * removed, so the final frame leads straight into the new first frame. Mixing happens on
 * premultiplied colour so see-through pixels do not leak their hidden colour into the fade.
 * Ping-pong: the clip plays forward and then backward without repeating the turning frames.
 */
export function loopGraph(input: string, output: string, plan: LoopPlan, prefix: string): string[] {
  const statements: string[] = [];
  let label = input;
  if (plan.dropLastFrame) {
    statements.push(`[${label}]trim=end_frame=${plan.loopInputFrames},setpts=PTS-STARTPTS[${prefix}trimmed]`);
    label = `${prefix}trimmed`;
  }
  const m = plan.loopInputFrames;
  if (plan.mode === "pingpong") {
    statements.push(
      `[${label}]split=2[${prefix}fwd][${prefix}rev]`,
      `[${prefix}rev]reverse,trim=start_frame=1:end_frame=${m - 1},setpts=PTS-STARTPTS[${prefix}back]`,
      `[${prefix}fwd][${prefix}back]concat=n=2:v=1:a=0[${output}]`
    );
  } else if (plan.mode === "crossfade" && plan.crossfadeFrames > 0) {
    const f = plan.crossfadeFrames;
    statements.push(
      `[${label}]format=gbrap,premultiply=inplace=1,split=3[${prefix}a][${prefix}b][${prefix}c]`,
      `[${prefix}a]trim=start_frame=${f}:end_frame=${m - f},setpts=PTS-STARTPTS[${prefix}body]`,
      `[${prefix}b]trim=start_frame=${m - f}:end_frame=${m},setpts=PTS-STARTPTS[${prefix}tail]`,
      `[${prefix}c]trim=start_frame=0:end_frame=${f},setpts=PTS-STARTPTS[${prefix}head]`,
      `[${prefix}tail][${prefix}head]blend=all_expr='A+(B-A)*(N+1)/${f + 1}'[${prefix}mix]`,
      `[${prefix}body][${prefix}mix]concat=n=2:v=1:a=0,unpremultiply=inplace=1[${output}]`
    );
  } else {
    statements.push(`[${label}]null[${output}]`);
  }
  return statements;
}

export interface AlphaKeyRequest extends BackdropKeyOptions {
  /** Remove a plain backdrop. Defaults to true when the source has no transparency of its own. */
  removeBackdrop?: boolean | undefined;
}

export interface AlphaLoopOptions {
  inputPath: string;
  /** Destination `.webm` file. */
  outputPath: string;
  /** Optional source range. */
  startTick?: number | undefined;
  durationTick?: number | undefined;
  key?: AlphaKeyRequest | undefined;
  mode?: LoopMode | undefined;
  crossfadeFrames?: number | undefined;
  /** `undefined` drops the last frame only when it repeats the first one. */
  dropDuplicateEndFrame?: boolean | undefined;
  /** Times (ticks, within the finished loop) to save as see-through PNG stills next to the output. */
  stillTimesTick?: number[] | undefined;
  /** VP9 quality (lower is better; 4–63). */
  crf?: number | undefined;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: number, message: string) => void) | undefined;
}

interface ResolvedKey {
  enabled: boolean;
  key?: ResolvedBackdropKey;
  detected?: BackdropDetection;
}

async function resolveKey(inputPath: string, probe: MediaProbe, config: StudioConfig, request: AlphaKeyRequest | undefined, atTick: number, signal?: AbortSignal): Promise<ResolvedKey> {
  const enabled = request?.removeBackdrop ?? !probe.hasAlpha;
  if (!enabled) return { enabled: false };
  const wanted = request?.color?.trim() || "auto";
  if (wanted.toLowerCase() !== "auto") return { enabled: true, key: resolveBackdropKey(parseColor(wanted), request) };
  const detected = await detectBackdropColor(inputPath, config, { atTick, probe, signal });
  return { enabled: true, key: resolveBackdropKey(detected.rgb, request), detected };
}

function keyReport(resolved: ResolvedKey): Record<string, unknown> {
  if (!resolved.enabled || !resolved.key) return { removed: false };
  return {
    removed: true, color: colorHex(resolved.key.color), method: resolved.key.method, tolerance: resolved.key.tolerance,
    softness: resolved.key.softness, despill: resolved.key.despill, ...(resolved.detected ? { detected: resolved.detected } : {})
  };
}

function rangeFilters(startTick?: number, durationTick?: number): string[] {
  if (!startTick && !durationTick) return [];
  const start = ticksToSeconds(Math.max(0, startTick ?? 0));
  return [`trim=start=${start}${durationTick ? `:duration=${ticksToSeconds(durationTick)}` : ""}`, "setpts=PTS-STARTPTS"];
}

function sourceFrameRate(probe: MediaProbe): Rational {
  if (!probe.hasVideo) throw new StudioException("NO_VIDEO_STREAM", "The source has no video stream.", "input");
  if (!probe.frameRate || probe.frameRate.numerator <= 0) throw new StudioException("UNKNOWN_FRAME_RATE", "The source frame rate could not be read.", "input");
  return probe.frameRate;
}

function stillPath(outputPath: string, frame: number): string {
  const extension = path.extname(outputPath);
  return path.join(path.dirname(path.resolve(outputPath)), `${path.basename(outputPath, extension)}-still-${String(frame).padStart(4, "0")}.png`);
}

/** Remove a plain backdrop, make the clip loop without a visible jump, and export a see-through VP9 WebM plus PNG stills. */
export async function exportAlphaLoop(config: StudioConfig, options: AlphaLoopOptions): Promise<Record<string, unknown>> {
  if (path.extname(options.outputPath).toLowerCase() !== ".webm") throw new StudioException("INVALID_OUTPUT", "See-through loops are written as .webm files.", "input");
  const progress = options.onProgress ?? (() => undefined);
  const signal = options.signal;
  progress(0.02, "Reading source");
  const probe = await probeMedia(options.inputPath, config, signal);
  const fps = sourceFrameRate(probe);
  const decoderArgs = alphaDecoderArgs(probe);
  const range = rangeFilters(options.startTick, options.durationTick);

  progress(0.05, "Measuring motion");
  const size = analysisSize(probe);
  const analysis = await readRgbaFrames(config, options.inputPath, { ...size, inputArgs: decoderArgs, filters: range, signal });
  const frames = analysis.frames;
  if (frames.length < 2) throw new StudioException("LOOP_TOO_SHORT", "The source range needs at least two frames.", "input");
  const typicalStep = median(consecutiveDifferences(frames));
  const rawSeam = frameDifference(frames.at(-1)!, frames[0]!);
  const dropLastFrame = options.dropDuplicateEndFrame ?? (frames.length > 3 && rawSeam <= Math.max(0.25 * typicalStep, 5e-4));
  const kept = dropLastFrame ? frames.slice(0, -1) : frames;
  const seamBefore = frameDifference(kept.at(-1)!, kept[0]!);
  const mode = options.mode ?? "crossfade";
  const defaultCrossfade = Math.max(2, Math.round(fps.numerator / fps.denominator * 0.25));
  const plan = planLoop({ mode, sourceFrames: frames.length, dropLastFrame, crossfadeFrames: options.crossfadeFrames, defaultCrossfadeFrames: defaultCrossfade, seamBefore, typicalStep });

  progress(0.12, "Finding the backdrop");
  const key = await resolveKey(options.inputPath, probe, config, options.key, options.startTick ?? 0, signal);

  const scratch = path.join(config.scratchDir, `alpha-loop-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  try {
    // Frame-index timestamps (time base 1/fps, pts = frame number). Containers with millisecond
    // clocks round 1/fps unevenly and some filters change the time base, but the cross-fade must
    // pair tail and head frames one-to-one and the output must keep an exact frame count.
    const frameClock = `settb=${fps.denominator}/${fps.numerator},setpts=N`;
    const statements: string[] = [`[0:v]${[...range, "format=rgba"].join(",")}[src]`];
    let label = "src";
    if (key.enabled && key.key) { statements.push(...backdropKeyGraph(label, "keyed", key.key, "key")); label = "keyed"; }
    statements.push(`[${label}]${frameClock}[timed]`);
    statements.push(...loopGraph("timed", "looped", plan, "loop"));
    statements.push(`[looped]${frameClock},format=rgba[out]`);
    const graphPath = path.join(scratch, "alpha-loop.txt");
    await writeFile(graphPath, statements.join(";\n"), "utf8");
    const intermediate = path.join(scratch, "loop.mkv");
    progress(0.2, "Removing backdrop and joining the loop");
    await ffmpegArtifact(config, [...decoderArgs, "-i", path.resolve(options.inputPath), "-filter_complex_script", graphPath, "-map", "[out]", "-an", "-fps_mode", "passthrough", "-c:v", "ffv1", "-pix_fmt", "bgra"], intermediate, { signal, timeoutMs: 12 * 60 * 60_000 });

    progress(0.55, "Encoding see-through WebM");
    const crf = Math.round(Math.min(63, Math.max(4, options.crf ?? 30)));
    const encode = await ffmpegArtifact(config, [
      "-i", intermediate, "-map", "0:v:0", "-an", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", String(crf),
      "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-auto-alt-ref", "0", "-r", `${fps.numerator}/${fps.denominator}`,
      "-metadata:s:v:0", "alpha_mode=1"
    ], options.outputPath, { signal, timeoutMs: 12 * 60 * 60_000 });

    const stills: Array<Record<string, unknown>> = [];
    for (const [index, atTick] of (options.stillTimesTick ?? []).entries()) {
      progress(0.75 + 0.1 * index / Math.max(1, options.stillTimesTick!.length), "Saving see-through stills");
      const frame = Math.min(plan.outputFrames - 1, ticksToFrames(Math.max(0, atTick), fps, "floor"));
      const output = stillPath(options.outputPath, frame);
      await ffmpegArtifact(config, ["-i", intermediate, "-vf", `trim=start_frame=${frame}:end_frame=${frame + 1}`, "-frames:v", "1", "-update", "1", "-c:v", "png", "-pix_fmt", "rgba"], output, { signal, timeoutMs: 10 * 60_000 });
      stills.push({ path: output, frame, atTick: framesToTicks(frame, fps), ...(await sha256File(output)) });
    }

    progress(0.88, "Checking transparency and seam");
    const qc = await alphaQc(options.outputPath, config, { loop: mode !== "none", signal });
    const hash = await sha256File(options.outputPath);
    const frameCount = qc.frameCount;
    if (frameCount !== plan.outputFrames) plan.warnings.push(`Expected ${plan.outputFrames} frames but decoded ${frameCount}.`);
    progress(1, "Completed");
    return {
      success: true, outputPath: path.resolve(options.outputPath), ...hash,
      frameRate: fps, frameCount, durationTick: framesToTicks(frameCount, fps), durationSeconds: ticksToSeconds(framesToTicks(frameCount, fps)),
      loop: {
        mode: plan.mode, sourceFrames: plan.sourceFrames, droppedDuplicateEndFrame: plan.dropLastFrame, crossfadeFrames: plan.crossfadeFrames,
        plannedFrames: plan.outputFrames, seamBefore: Number(seamBefore.toFixed(5)), typicalStep: Number(typicalStep.toFixed(5)),
        ...(qc.seam ? { seamAfter: qc.seam.seam } : {})
      },
      backdrop: keyReport(key),
      stills, qc: { passed: qc.passed, checks: qc.checks }, warnings: plan.warnings,
      ffmpegCommand: { executable: config.ffmpegPath, args: encode.args }
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface AlphaStillOptions {
  inputPath: string;
  /** Destination `.png` file. */
  outputPath: string;
  atTick: number;
  key?: AlphaKeyRequest | undefined;
  signal?: AbortSignal | undefined;
}

/** Save one frame as a see-through PNG, optionally removing a plain backdrop first. */
export async function exportAlphaStill(config: StudioConfig, options: AlphaStillOptions): Promise<Record<string, unknown>> {
  if (path.extname(options.outputPath).toLowerCase() !== ".png") throw new StudioException("INVALID_OUTPUT", "See-through stills are written as .png files.", "input");
  const probe = await probeMedia(options.inputPath, config, options.signal);
  if (!probe.hasVideo) throw new StudioException("NO_VIDEO_STREAM", "The source has no video stream.", "input");
  const atTick = Math.max(0, Math.round(options.atTick));
  // Snap to the start of the frame that is showing at atTick; seek a quarter frame early so rounding never skips it.
  const frame = probe.frameRate ? ticksToFrames(atTick, probe.frameRate, "floor") : 0;
  const seekSeconds = probe.frameRate ? Math.max(0, (frame - 0.25) * probe.frameRate.denominator / probe.frameRate.numerator) : ticksToSeconds(atTick);
  const key = await resolveKey(options.inputPath, probe, config, options.key, atTick, options.signal);
  const scratch = path.join(config.scratchDir, `alpha-still-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  try {
    const statements: string[] = ["[0:v]format=rgba[src]"];
    let label = "src";
    if (key.enabled && key.key) { statements.push(...backdropKeyGraph(label, "keyed", key.key, "key")); label = "keyed"; }
    statements.push(`[${label}]format=rgba[out]`);
    const graphPath = path.join(scratch, "alpha-still.txt");
    await writeFile(graphPath, statements.join(";\n"), "utf8");
    await ffmpegArtifact(config, [
      ...(seekSeconds > 0 ? ["-ss", String(seekSeconds)] : []), ...alphaDecoderArgs(probe), "-i", path.resolve(options.inputPath),
      "-filter_complex_script", graphPath, "-map", "[out]", "-frames:v", "1", "-update", "1", "-c:v", "png", "-pix_fmt", "rgba"
    ], options.outputPath, { signal: options.signal, timeoutMs: 10 * 60_000 });
    const size = analysisSize(probe);
    const { frames } = await readRgbaFrames(config, options.outputPath, { ...size, signal: options.signal });
    const pixels = frames[0];
    return {
      success: true, outputPath: path.resolve(options.outputPath), ...(await sha256File(options.outputPath)),
      frame, atTick: probe.frameRate ? framesToTicks(frame, probe.frameRate) : atTick,
      backdrop: keyReport(key),
      ...(pixels ? { cornerAlpha: maxCornerAlpha(pixels, size.width, size.height), opaqueShare: Number(opaqueShare(pixels).toFixed(4)) } : {})
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
