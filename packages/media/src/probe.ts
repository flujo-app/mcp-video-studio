import path from "node:path";
import { rational, secondsToTicks, type MediaKind, type MediaProbe, type Rational } from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";
import type { StudioConfig } from "./config.js";
import { runChecked } from "./process.js";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  duration?: string;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string };
}

function parseRate(value?: string): Rational | undefined {
  if (!value || value === "0/0") return undefined;
  const [left, right] = value.split("/").map(Number);
  if (left === undefined || right === undefined || !Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !right) return undefined;
  return rational(left, right);
}

function firstFinite(...values: Array<string | undefined>): number {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
}

export async function probeMedia(filePath: string, config: StudioConfig, signal?: AbortSignal): Promise<MediaProbe> {
  const result = await runChecked(config.ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path.resolve(filePath)], { signal, timeoutMs: 60_000 });
  let data: FfprobeJson;
  try { data = JSON.parse(result.stdout) as FfprobeJson; }
  catch { throw new StudioException("INVALID_PROBE_OUTPUT", "ffprobe returned invalid JSON.", "runtime", { stdout: result.stdout }); }
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = firstFinite(data.format?.duration, video?.duration, audio?.duration);
  const frameRate = parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate);
  return {
    durationTick: secondsToTicks(duration),
    ...(data.format?.format_name ? { formatName: data.format.format_name } : {}),
    hasVideo: Boolean(video), hasAudio: Boolean(audio),
    ...(video?.width ? { width: video.width } : {}), ...(video?.height ? { height: video.height } : {}),
    ...(frameRate ? { frameRate } : {}), ...(video?.codec_name ? { videoCodec: video.codec_name } : {}),
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
    ...(audio?.sample_rate ? { sampleRate: Number(audio.sample_rate) } : {}), ...(audio?.channels ? { channels: audio.channels } : {})
  };
}

export function mediaKindFor(filePath: string, probe: MediaProbe): MediaKind {
  const extension = path.extname(filePath).toLowerCase();
  if ([".ttf", ".otf", ".woff", ".woff2"].includes(extension)) return "font";
  if ([".srt", ".vtt", ".ass", ".ssa"].includes(extension)) return "subtitle";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".svg"].includes(extension) && !probe.hasAudio) return "image";
  if (probe.hasVideo) return "video";
  if (probe.hasAudio) return "audio";
  throw new StudioException("UNSUPPORTED_MEDIA", `Unsupported media type: ${filePath}`, "input");
}

export async function verifyDecode(filePath: string, config: StudioConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const result = await runChecked(config.ffmpegPath, ["-hide_banner", "-v", "error", "-xerror", "-i", path.resolve(filePath), "-map", "0", "-f", "null", "-"], { signal, timeoutMs: 12 * 60 * 60_000 });
  return { success: true, path: path.resolve(filePath), durationMs: result.durationMs, stderr: result.stderr };
}
