import { open } from "node:fs/promises";
import path from "node:path";
import { ticksToFrames, type StudioProject } from "@mcp-video-studio/contracts";
import { ProjectStore, sequenceDuration, sha256File } from "@mcp-video-studio/core";
import { probeMedia, runChecked, verifyDecode, type StudioConfig } from "@mcp-video-studio/media";

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

export async function runQc(store: ProjectStore, sequenceId: string, filePath: string, config: StudioConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const project = await store.read();
  const sequence = project.sequences.find((item) => item.id === sequenceId);
  if (!sequence) throw new Error(`Sequence not found: ${sequenceId}`);
  const [probe, decode, faststart, levels, hash] = await Promise.all([
    probeMedia(filePath, config, signal), verifyDecode(filePath, config, signal), checkFaststart(filePath), loudness(filePath, config, signal), sha256File(filePath)
  ]);
  const expectedFrames = ticksToFrames(sequenceDuration(sequence), project.settings.fps, "ceil");
  const actualFrames = ticksToFrames(probe.durationTick, project.settings.fps, "round");
  const checks: QcCheck[] = [
    { id: "decode", status: "PASS", severity: "error", message: "Full decode completed.", observed: decode },
    { id: "video.raster", status: probe.width === project.settings.raster.width && probe.height === project.settings.raster.height ? "PASS" : "FAIL", severity: "error", expected: { ...project.settings.raster }, observed: { width: probe.width, height: probe.height }, message: "Output raster matches the project." },
    { id: "video.frames", status: actualFrames === expectedFrames ? "PASS" : "FAIL", severity: "error", expected: { frames: expectedFrames }, observed: { frames: actualFrames }, message: "Output frame count matches the timeline." },
    { id: "container.faststart", status: path.extname(filePath).toLowerCase() === ".mp4" ? (faststart.faststart ? "PASS" : "FAIL") : "WARN", severity: "warning", observed: faststart, message: "MP4 metadata is placed before media data." },
    { id: "audio.loudness", status: Number.isFinite(levels["integratedLufs"]) && (levels["integratedLufs"] ?? -Infinity) >= -18 && (levels["integratedLufs"] ?? Infinity) <= -14 ? "PASS" : "WARN", severity: "warning", expected: { integratedLufs: "-18 to -14" }, observed: levels, message: "Integrated loudness is in the review range." },
    { id: "audio.true_peak", status: Number.isFinite(levels["truePeakDbtp"]) && (levels["truePeakDbtp"] ?? Infinity) <= -1 ? "PASS" : "WARN", severity: "warning", expected: { maxDbtp: -1 }, observed: levels, message: "True peak is below the review ceiling." }
  ];
  return { success: true, passed: checks.every((check) => check.status !== "FAIL"), projectId: project.projectId, revision: project.revision, sequenceId, path: path.resolve(filePath), sha256: hash.sha256, bytes: hash.bytes, checks };
}
