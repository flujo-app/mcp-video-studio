import path from "node:path";
import { framesToTicks, ticksToSeconds, type MediaAsset } from "@mcp-video-studio/contracts";
import { ProjectStore, sha256File } from "@mcp-video-studio/core";
import type { StudioConfig } from "./config.js";
import { ffmpegArtifact } from "./artifacts.js";
import { mediaPath } from "./assets.js";

export async function createThumbnail(store: ProjectStore, media: MediaAsset, config: StudioConfig, atTick = 0, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const output = path.join(store.root, "proxies", media.id, `thumb-${atTick}.png`);
  const safeTick = Math.max(0, Math.round(atTick));
  await ffmpegArtifact(config, ["-ss", String(ticksToSeconds(safeTick)), "-i", mediaPath(store, media), "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-an"], output, { signal, timeoutMs: 120_000 });
  return { path: output, ...(await sha256File(output)), mediaId: media.id, atTick };
}

export async function createWaveform(store: ProjectStore, media: MediaAsset, config: StudioConfig, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const output = path.join(store.root, "proxies", media.id, "waveform.png");
  await ffmpegArtifact(config, ["-i", mediaPath(store, media), "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1600x240:colors=4cc9f0", "-frames:v", "1", "-an"], output, { signal, timeoutMs: 120_000 });
  return { path: output, ...(await sha256File(output)), mediaId: media.id };
}

export async function createProxy(store: ProjectStore, media: MediaAsset, config: StudioConfig, signal?: AbortSignal, onProgress?: (value: number) => void): Promise<Record<string, unknown>> {
  const output = path.join(store.root, "proxies", media.id, "preview.mp4");
  const duration = Math.max(1, ticksToSeconds(media.probe.durationTick));
  await ffmpegArtifact(config, [
    "-i", mediaPath(store, media), "-map", "0:v:0?", "-map", "0:a:0?",
    "-vf", "scale='min(1280,iw)':-2:flags=lanczos,fps=30,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
    "-progress", "pipe:2"
  ], output, {
    signal, timeoutMs: 12 * 60 * 60_000,
    onProgress: (progress) => {
      const microseconds = Number(progress.out_time_us);
      if (Number.isFinite(microseconds)) onProgress?.(Math.min(1, microseconds / 1_000_000 / duration));
    }
  });
  return { path: output, ...(await sha256File(output)), mediaId: media.id };
}
