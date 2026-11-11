import { open } from "node:fs/promises";
import path from "node:path";
import { framesToTicks, ticksToFrames, type MediaProbe } from "@mcp-video-studio/contracts";
import { ProjectStore, sequenceDuration, sha256File } from "@mcp-video-studio/core";
import { alphaDecoderArgs, probeMedia, runChecked, verifyDecode, type StudioConfig } from "@mcp-video-studio/media";
import { analysisSize, consecutiveDifferences, frameDifference, maxCornerAlpha, median, opaqueShare, readRgbaFrames, transparentShare } from "./alpha.js";

export interface QcCheck {
  id: string;
  status: "PASS" | "FAIL" | "WARN";
  severity: "error" | "warning";
  expected?: Record<string, unknown>;
  observed?: Record<string, unknown>;
  message: string;
}

export async function checkFaststart(filePath: string): Promise<{ faststart: boolean; boxes: string[] }> {
  const handle = await open(filePath, "r");
  const boxes: string[] = [];
  let position = 0;
  try {
    const info = await handle.stat();
    while (position + 8 <= info.size && boxes.length < 10_000) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, position);
      if (bytesRead < 8) break;
      let size = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString("ascii");
      let headerSize = 8;
      if (size === 1 && bytesRead >= 16) { size = Number(header.readBigUInt64BE(8)); headerSize = 16; }
      else if (size === 0) size = info.size - position;
      if (size < headerSize) break;
      boxes.push(type);
      position += size;
    }
  } finally { await handle.close(); }
  const moov = boxes.indexOf("moov");
  const mdat = boxes.indexOf("mdat");
  return { faststart: moov >= 0 && (mdat < 0 || moov < mdat), boxes };
}

async function loudness(filePath: string, config: StudioConfig, signal?: AbortSignal): Promise<Record<string, number>> {
  const result = await runChecked(config.ffmpegPath, ["-hide_banner", "-i", path.resolve(filePath), "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json", "-f", "null", "-"], { signal, timeoutMs: 60 * 60_000, maxOutputChars: 200_000 });
  const match = /\{[\s\S]*?"input_i"[\s\S]*?\}/g.exec(result.stderr);
  if (!match) return {};
  const parsed = JSON.parse(match[0]) as Record<string, string>;
  return { integratedLufs: Number(parsed.input_i), truePeakDbtp: Number(parsed.input_tp), lra: Number(parsed.input_lra) };
}

/** Corners may keep a little compression noise but must read as clear (≈6% opacity at most). */
export const CORNER_ALPHA_LIMIT = 16;
/** At most this many frames are decoded for transparency statistics; longer files are sampled evenly. */
const ALPHA_QC_MAX_FRAMES = 1500;
/** A loop seam up to this many ordinary frame steps plays without a visible jump. */
const SEAM_RATIO = 2.5;

function percentile(values: number[], share: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * (sorted.length - 1)))]!;
}

export interface AlphaQcResult {
  passed: boolean;
  checks: QcCheck[];
  /** Decoded frame count (exact unless the file was sampled). */
  frameCount: number;
  sampled: boolean;
  seam?: { seam: number; typicalStep: number; ratio: number };
}

/**
 * Checks that a file really keeps a see-through background: an alpha channel is present and
 * decodes, the corners are clear in every analysed frame, and something solid remains. With
 * `loop`, also checks that the last frame flows into the first like an ordinary frame step.
 */
export async function alphaQc(filePath: string, config: StudioConfig, options: { loop?: boolean | undefined; probe?: MediaProbe; signal?: AbortSignal | undefined } = {}): Promise<AlphaQcResult> {
  const probe = options.probe ?? await probeMedia(filePath, config, options.signal);
  const checks: QcCheck[] = [];
  if (!probe.hasVideo) {
    checks.push({ id: "alpha.channel", status: "FAIL", severity: "error", message: "The file has no video stream.", observed: { formatName: probe.formatName } });
    return { passed: false, checks, frameCount: 0, sampled: false };
  }
  const estimated = probe.frameRate ? ticksToFrames(probe.durationTick, probe.frameRate, "round") : 0;
  const step = estimated > ALPHA_QC_MAX_FRAMES ? Math.ceil(estimated / ALPHA_QC_MAX_FRAMES) : 1;
  const size = analysisSize(probe);
  const { frames } = await readRgbaFrames(config, filePath, {
    ...size, inputArgs: alphaDecoderArgs(probe), signal: options.signal,
    ...(step > 1 ? { filters: [`select='not(mod(n,${step}))'`] } : {})
  });
  const decodedTransparency = frames.some((frame) => transparentShare(frame) > 0);
  checks.push({
    id: "alpha.channel", status: probe.hasAlpha && decodedTransparency ? "PASS" : "FAIL", severity: "error",
    expected: { alpha: true }, observed: { videoCodec: probe.videoCodec, pixelFormat: probe.pixelFormat, flaggedAlpha: probe.hasAlpha ?? false, decodedTransparency },
    message: "The video carries an alpha channel that decodes to see-through pixels."
  });
  let worstCorner = 0;
  let worstFrame = 0;
  frames.forEach((frame, index) => {
    const value = maxCornerAlpha(frame, size.width, size.height);
    if (value > worstCorner) { worstCorner = value; worstFrame = index * step; }
  });
  checks.push({
    id: "alpha.corners", status: frames.length && worstCorner <= CORNER_ALPHA_LIMIT ? "PASS" : "FAIL", severity: "error",
    expected: { maxCornerAlpha: CORNER_ALPHA_LIMIT }, observed: { maxCornerAlpha: worstCorner, worstFrame, framesChecked: frames.length },
    message: "The four corners are see-through in every checked frame."
  });
  const solid = Math.max(0, ...frames.map((frame) => opaqueShare(frame)));
  checks.push({
    id: "alpha.subject", status: solid > 0.001 ? "PASS" : "WARN", severity: "warning",
    observed: { largestSolidShare: Number(solid.toFixed(4)) }, message: "Some of the picture stays solid (the subject was not removed)."
  });
  let seam: AlphaQcResult["seam"];
  if (options.loop) {
    if (step > 1 || frames.length < 3) {
      checks.push({ id: "loop.seam", status: "WARN", severity: "warning", observed: { framesChecked: frames.length, sampled: step > 1 }, message: "The clip is too long or too short to measure the loop seam." });
    } else {
      const steps = consecutiveDifferences(frames);
      const typicalStep = median(steps);
      const largeStep = percentile(steps, 0.95);
      const value = frameDifference(frames.at(-1)!, frames[0]!);
      // A cross-fade spreads the jump over several frames, so the wrap may be as big as the larger steps inside the loop.
      const limit = Math.max(SEAM_RATIO * typicalStep, 1.25 * largeStep, 1e-3);
      seam = { seam: Number(value.toFixed(5)), typicalStep: Number(typicalStep.toFixed(5)), ratio: Number((typicalStep > 0 ? value / typicalStep : 0).toFixed(3)) };
      checks.push({
        id: "loop.seam", status: value <= limit ? "PASS" : "FAIL", severity: "error",
        expected: { maxSeam: Number(limit.toFixed(5)) }, observed: seam,
        message: "The last frame flows into the first no harder than an ordinary frame step."
      });
    }
  }
  return { passed: checks.every((check) => check.status !== "FAIL"), checks, frameCount: step === 1 ? frames.length : estimated, sampled: step > 1, ...(seam ? { seam } : {}) };
}

export async function runAlphaQc(filePath: string, config: StudioConfig, options: { loop?: boolean | undefined; signal?: AbortSignal | undefined } = {}): Promise<Record<string, unknown>> {
  const [probe, hash] = await Promise.all([probeMedia(filePath, config, options.signal), sha256File(filePath)]);
  const decode = await verifyDecode(filePath, config, options.signal);
  const result = await alphaQc(filePath, config, { ...options, probe });
  const checks: QcCheck[] = [{ id: "decode", status: "PASS", severity: "error", message: "Full decode completed.", observed: decode }, ...result.checks];
  return {
    success: true, passed: checks.every((check) => check.status !== "FAIL"), path: path.resolve(filePath), sha256: hash.sha256, bytes: hash.bytes,
    frameCount: result.frameCount, ...(probe.frameRate ? { frameRate: probe.frameRate, durationTick: framesToTicks(result.frameCount, probe.frameRate) } : {}),
    checks
  };
}

export async function runQc(store: ProjectStore, sequenceId: string, filePath: string, config: StudioConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const project = await store.read();
  const sequence = project.sequences.find((item) => item.id === sequenceId);
  if (!sequence) throw new Error(`Sequence not found: ${sequenceId}`);
  const [probe, decode, faststart, levels, hash] = await Promise.all([
    probeMedia(filePath, config, signal), verifyDecode(filePath, config, signal), checkFaststart(filePath), loudness(filePath, config, signal), sha256File(filePath)
  ]);
  const alpha = probe.hasAlpha ? await alphaQc(filePath, config, { probe, signal }) : undefined;
  const expectedFrames = ticksToFrames(sequenceDuration(sequence), project.settings.fps, "ceil");
  const actualFrames = ticksToFrames(probe.durationTick, project.settings.fps, "round");
  const checks: QcCheck[] = [
    { id: "decode", status: "PASS", severity: "error", message: "Full decode completed.", observed: decode },
    { id: "video.raster", status: probe.width === project.settings.raster.width && probe.height === project.settings.raster.height ? "PASS" : "FAIL", severity: "error", expected: { ...project.settings.raster }, observed: { width: probe.width, height: probe.height }, message: "Output raster matches the project." },
    { id: "video.frames", status: actualFrames === expectedFrames ? "PASS" : "FAIL", severity: "error", expected: { frames: expectedFrames }, observed: { frames: actualFrames }, message: "Output frame count matches the timeline." },
    { id: "container.faststart", status: path.extname(filePath).toLowerCase() === ".mp4" ? (faststart.faststart ? "PASS" : "FAIL") : "WARN", severity: "warning", observed: faststart, message: "MP4 metadata is placed before media data." },
    { id: "audio.loudness", status: Number.isFinite(levels["integratedLufs"]) && (levels["integratedLufs"] ?? -Infinity) >= -18 && (levels["integratedLufs"] ?? Infinity) <= -14 ? "PASS" : "WARN", severity: "warning", expected: { integratedLufs: "-18 to -14" }, observed: levels, message: "Integrated loudness is in the review range." },
    { id: "audio.true_peak", status: Number.isFinite(levels["truePeakDbtp"]) && (levels["truePeakDbtp"] ?? Infinity) <= -1 ? "PASS" : "WARN", severity: "warning", expected: { maxDbtp: -1 }, observed: levels, message: "True peak is below the review ceiling." },
    ...(alpha?.checks ?? [])
  ];
  return { success: true, passed: checks.every((check) => check.status !== "FAIL"), projectId: project.projectId, revision: project.revision, sequenceId, path: path.resolve(filePath), sha256: hash.sha256, bytes: hash.bytes, checks };
}
