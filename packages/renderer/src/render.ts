import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { framesToTicks, ticksPerFrame, ticksToFrames, ticksToSeconds, type Clip, type ExportPreset, type MediaAsset, type Sequence, type StudioProject } from "@mcp-video-studio/contracts";
import { ProjectStore, sequenceDuration, sha256File, StudioException } from "@mcp-video-studio/core";
import { renderAnimation } from "@mcp-video-studio/animation";
import { ffmpegArtifact, mediaPath, probeMedia, type StudioConfig } from "@mcp-video-studio/media";
import { atempoChain, audioEffectFilters, clipTransformFilters, videoEffectFilters } from "./filters.js";

export interface RenderOptions {
  sequenceId: string;
  presetId: string;
  outputPath: string;
  expectedRevision?: number;
  maxWidth?: number;
  crf?: number;
  encoderPreset?: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium";
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
}

interface InputSpec {
  args: string[];
  clip: Clip;
  media?: MediaAsset;
  inputIndex: number;
  path?: string;
}

function canonicalHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : nested);
  return createHash("sha256").update(canonical).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function publishFile(sourcePath: string, outputPath: string): Promise<void> {
  if (samePath(sourcePath, outputPath)) return;
  const output = path.resolve(outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  const extension = path.extname(output);
  const temporary = path.join(path.dirname(output), `.${path.basename(output, extension)}.${randomUUID()}.cache${extension}`);
  try {
    await copyFile(sourcePath, temporary);
    await rm(output, { force: true });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface RenderCacheStats {
  directory: string;
  artifactCount: number;
  totalBytes: number;
  oldestAccessedAt?: string;
  newestAccessedAt?: string;
}

async function renderCacheEntries(projectRoot: string): Promise<Array<{ path: string; bytes: number; mtimeMs: number }>> {
  const directory = path.join(projectRoot, "cache", "renders");
  const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const entries = await Promise.all(names.filter((entry) => entry.isFile() && !entry.name.endsWith(".json")).map(async (entry) => {
    const filePath = path.join(directory, entry.name);
    const info = await stat(filePath);
    return { path: filePath, bytes: info.size, mtimeMs: info.mtimeMs };
  }));
  return entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
}

export async function renderCacheStats(projectRoot: string): Promise<RenderCacheStats> {
  const directory = path.join(path.resolve(projectRoot), "cache", "renders");
  const entries = await renderCacheEntries(projectRoot);
  return {
    directory,
    artifactCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    ...(entries[0] ? { oldestAccessedAt: new Date(entries[0].mtimeMs).toISOString(), newestAccessedAt: new Date(entries.at(-1)!.mtimeMs).toISOString() } : {})
  };
}

export async function pruneRenderCache(projectRoot: string, maxBytes: number, preservePath?: string): Promise<RenderCacheStats & { removedArtifacts: number; freedBytes: number }> {
  const entries = await renderCacheEntries(projectRoot);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let removedArtifacts = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    if (totalBytes <= maxBytes) break;
    if (preservePath && samePath(entry.path, preservePath)) continue;
    await Promise.all([rm(entry.path, { force: true }), rm(`${entry.path}.json`, { force: true })]);
    totalBytes -= entry.bytes;
    freedBytes += entry.bytes;
    removedArtifacts += 1;
  }
  return { ...(await renderCacheStats(projectRoot)), removedArtifacts, freedBytes };
}

function presetById(project: StudioProject, id: string): ExportPreset {
  const preset = project.exportPresets.find((candidate) => candidate.id === id);
  if (!preset) throw new StudioException("PRESET_NOT_FOUND", `Export preset not found: ${id}`, "input");
  return preset;
}

function sequenceById(project: StudioProject, id: string): Sequence {
  const sequence = project.sequences.find((candidate) => candidate.id === id);
  if (!sequence) throw new StudioException("SEQUENCE_NOT_FOUND", `Sequence not found: ${id}`, "input");
  return sequence;
}

function mediaById(project: StudioProject, id: string): MediaAsset {
  const media = project.media.find((candidate) => candidate.id === id);
  if (!media) throw new StudioException("MEDIA_NOT_FOUND", `Media not found: ${id}`, "input");
  return media;
}

function ffmpegColor(value: string): string {
  return value.replace(/^#/, "0x");
}

function ffmpegCaptionColor(value: string): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!match) return value;
  const alpha = match[2] ? Number.parseInt(match[2], 16) / 255 : 1;
  return `0x${match[1]}@${alpha.toFixed(3)}`;
}

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function captionFontFile(fontFamily: string, configured?: string): string {
  const windows = process.env.WINDIR || "C:\\Windows";
  const family = fontFamily.toLowerCase();
  const windowsName = family.includes("mono") || family.includes("consol") ? "consola.ttf" : family.includes("serif") || family.includes("times") ? "times.ttf" : "arial.ttf";
  const candidates = [
    ...(configured ? [configured] : []),
    path.join(windows, "Fonts", windowsName),
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new StudioException("CAPTION_FONT_MISSING", "No supported system caption font was found. Install Arial, Helvetica, DejaVu Sans, or Liberation Sans.", "dependency");
  return match;
}

async function buildInputs(project: StudioProject, sequence: Sequence, store: ProjectStore, config: StudioConfig, signal?: AbortSignal, progress?: (value: number, message: string) => void): Promise<InputSpec[]> {
  const enabled = sequence.clips.filter((clip) => clip.enabled);
  const inputs: InputSpec[] = [];
  let index = 0;
  for (const clip of enabled) {
    if (clip.source.type === "media") {
      const media = mediaById(project, clip.source.mediaId);
      const source = mediaPath(store, media);
      inputs.push({ args: media.kind === "image" ? ["-loop", "1", "-i", source] : ["-i", source], clip, media, inputIndex: index++, path: source });
    } else if (clip.source.type === "color") {
      inputs.push({ args: ["-f", "lavfi", "-i", `color=c=${ffmpegColor(clip.source.color)}:s=${project.settings.raster.width}x${project.settings.raster.height}:r=${project.settings.fps.numerator}/${project.settings.fps.denominator}`], clip, inputIndex: index++ });
    } else if (clip.source.type === "animation") {
      const animationId = clip.source.animationId;
      const animation = project.animations.find((candidate) => candidate.id === animationId);
      if (!animation) throw new StudioException("ANIMATION_NOT_FOUND", `Animation not found: ${animationId}`, "input");
      const key = canonicalHash({ animation, fps: project.settings.fps });
      const rendered = path.join(store.root, "cache", "animations", `${key}.mkv`);
      await mkdir(path.dirname(rendered), { recursive: true });
      try { await sha256File(rendered); }
      catch {
        progress?.(0.05, `Rendering animation ${animation.name}`);
        await renderAnimation(animation, config, { outputPath: rendered, fps: project.settings.fps, signal, onProgress: (value) => progress?.(0.05 + value * 0.15, `Rendering animation ${animation.name}`) });
      }
      inputs.push({ args: ["-i", rendered], clip, inputIndex: index++, path: rendered });
    }
  }
  return inputs;
}

function fadeFilters(sequence: Sequence, clip: Clip): string[] {
  const filters: string[] = [];
  const incoming = sequence.transitions.find((transition) => transition.toClipId === clip.id);
  const outgoing = sequence.transitions.find((transition) => transition.fromClipId === clip.id);
  if (incoming && incoming.type !== "cut") filters.push(`fade=t=in:st=0:d=${ticksToSeconds(incoming.durationTick)}:alpha=1`);
  if (outgoing && outgoing.type !== "cut") filters.push(`fade=t=out:st=${Math.max(0, ticksToSeconds(clip.durationTick - outgoing.durationTick))}:d=${ticksToSeconds(outgoing.durationTick)}:alpha=1`);
  return filters;
}

function buildFilterGraph(project: StudioProject, sequence: Sequence, inputs: InputSpec[], captionFiles: Map<string, string>, maxWidth?: number, defaultFontFile?: string): { graph: string; videoLabel: string; audioLabel: string; durationTick: number; frameCount: number } {
  const durationTick = sequenceDuration(sequence);
  if (durationTick <= 0) throw new StudioException("EMPTY_SEQUENCE", "The sequence has no renderable duration.", "input");
  const frameCount = ticksToFrames(durationTick, project.settings.fps, "ceil");
  const durationSeconds = ticksToSeconds(framesToTicks(frameCount, project.settings.fps));
  const fps = `${project.settings.fps.numerator}/${project.settings.fps.denominator}`;
  const { width, height } = project.settings.raster;
  const statements: string[] = [`color=c=${ffmpegColor(project.settings.background)}:s=${width}x${height}:r=${fps}:d=${durationSeconds},format=rgba[base0]`];
  let videoLabel = "base0";
  const visual = inputs.filter((input) => input.clip.source.type === "color" || input.media?.probe.hasVideo || input.media?.kind === "image" || input.clip.source.type === "animation")
    .sort((a, b) => {
      const trackA = sequence.tracks.find((track) => track.id === a.clip.trackId)?.order ?? 0;
      const trackB = sequence.tracks.find((track) => track.id === b.clip.trackId)?.order ?? 0;
      return trackA - trackB || a.clip.startTick - b.clip.startTick;
    });
  visual.forEach((input, visualIndex) => {
    const clip = input.clip;
    const rate = clip.playbackRate.numerator / clip.playbackRate.denominator;
    const sourceStart = ticksToSeconds(clip.sourceInTick);
    const sourceDuration = ticksToSeconds(Math.round(clip.durationTick * rate));
    const start = ticksToSeconds(clip.startTick);
    const transform = clipTransformFilters(clip, project.settings.raster);
    const filters = [
      `trim=start=${sourceStart}:duration=${sourceDuration}`,
      `setpts=(PTS-STARTPTS)/${rate}+${start}/TB`,
      `fps=${fps}`,
      ...transform.filters,
      ...videoEffectFilters(clip.effects),
      ...fadeFilters(sequence, clip)
    ];
    const clipLabel = `vclip${visualIndex}`;
    statements.push(`[${input.inputIndex}:v]${filters.join(",")}[${clipLabel}]`);
    const next = `base${visualIndex + 1}`;
    statements.push(`[${videoLabel}][${clipLabel}]overlay=x=${transform.x}:y=${transform.y}:eof_action=pass:shortest=0[${next}]`);
    videoLabel = next;
  });

  const captions = sequence.captions.filter((caption) => {
    const track = sequence.tracks.find((candidate) => candidate.id === caption.trackId);
    return track && !track.hidden && !track.muted;
  });
  captions.forEach((caption, captionIndex) => {
    const start = ticksToSeconds(caption.startTick);
    const finish = ticksToSeconds(caption.startTick + caption.durationTick);
    const x = caption.style.align === "left" ? "w*0.05" : caption.style.align === "right" ? "w-text_w-w*0.05" : "(w-text_w)/2";
    const y = caption.style.position === "top" ? "h*0.07" : caption.style.position === "center" ? "(h-text_h)/2" : "h-text_h-h*0.08";
    const next = `caption${captionIndex}`;
    const textFile = captionFiles.get(caption.id);
    if (!textFile) throw new StudioException("CAPTION_TEXT_MISSING", `Caption text file missing for ${caption.id}.`, "runtime");
    statements.push(`[${videoLabel}]drawtext=fontfile='${escapeFilterPath(captionFontFile(caption.style.fontFamily, defaultFontFile))}':textfile='${escapeFilterPath(textFile)}':reload=0:expansion=none:fontsize=${caption.style.fontSize}:fontcolor=${ffmpegCaptionColor(caption.style.color)}:box=1:boxcolor=${ffmpegCaptionColor(caption.style.background)}:boxborderw=18:x=${x}:y=${y}:enable='between(t,${start},${finish})'[${next}]`);
    videoLabel = next;
  });

  const audibleTracks = sequence.tracks.filter((track) => track.type === "audio" || track.type === "video");
  const anySolo = audibleTracks.some((track) => track.solo);
  const audioInputs = inputs.filter((input) => input.media?.probe.hasAudio && (() => {
    const track = sequence.tracks.find((candidate) => candidate.id === input.clip.trackId);
    return track && !track.muted && (!anySolo || track.solo) && !input.clip.audio.muted;
  })());
  const audioLabels: string[] = [];
  audioInputs.forEach((input, audioIndex) => {
    const clip = input.clip;
    const track = sequence.tracks.find((candidate) => candidate.id === clip.trackId)!;
    const rate = clip.playbackRate.numerator / clip.playbackRate.denominator;
    const filters = [
      `atrim=start=${ticksToSeconds(clip.sourceInTick)}:duration=${ticksToSeconds(Math.round(clip.durationTick * rate))}`,
      "asetpts=PTS-STARTPTS",
      `aformat=sample_rates=${project.settings.sampleRate}:channel_layouts=${project.settings.channels === 1 ? "mono" : project.settings.channels === 6 ? "5.1" : "stereo"}`,
      ...atempoChain(rate),
      `volume=${clip.audio.gainDb + track.gainDb}dB`,
      `stereotools=balance_out=${Math.max(-1, Math.min(1, clip.audio.pan + track.pan))}`,
      ...(clip.audio.fadeInTick > 0 ? [`afade=t=in:st=0:d=${ticksToSeconds(clip.audio.fadeInTick)}`] : []),
      ...(clip.audio.fadeOutTick > 0 ? [`afade=t=out:st=${Math.max(0, ticksToSeconds(clip.durationTick - clip.audio.fadeOutTick))}:d=${ticksToSeconds(clip.audio.fadeOutTick)}`] : []),
      ...audioEffectFilters([...trackEffects(track), ...clip.audio.effects]),
      `adelay=${Math.round(ticksToSeconds(clip.startTick) * 1000)}:all=1`
    ];
    const label = `aclip${audioIndex}`;
    statements.push(`[${input.inputIndex}:a]${filters.join(",")}[${label}]`);
    audioLabels.push(`[${label}]`);
  });
  let audioLabel = "aout";
  if (audioLabels.length > 0) statements.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=duration=${durationSeconds},apad=whole_dur=${durationSeconds}[${audioLabel}]`);
  else statements.push(`anullsrc=r=${project.settings.sampleRate}:cl=${project.settings.channels === 1 ? "mono" : "stereo"},atrim=duration=${durationSeconds}[${audioLabel}]`);
  const outputWidth = maxWidth && width > maxWidth ? Math.max(2, Math.floor(maxWidth / 2) * 2) : width;
  const outputHeight = outputWidth !== width ? Math.max(2, Math.round(height * outputWidth / width / 2) * 2) : height;
  statements.push(`[${videoLabel}]${outputWidth !== width ? `scale=${outputWidth}:${outputHeight}:flags=lanczos,` : ""}format=yuv420p[vout]`);
  return { graph: statements.join(";\n"), videoLabel: "vout", audioLabel, durationTick: framesToTicks(frameCount, project.settings.fps), frameCount };
}

function trackEffects(_track: Sequence["tracks"][number]): import("@mcp-video-studio/contracts").EffectInstance[] {
  return [];
}

export async function renderSequence(store: ProjectStore, config: StudioConfig, options: RenderOptions): Promise<Record<string, unknown>> {
  const project = await store.read();
  if (options.expectedRevision !== undefined && project.revision !== options.expectedRevision) {
    throw new StudioException("REVISION_CONFLICT", `Preview requested for revision ${options.expectedRevision}, but the project is now revision ${project.revision}.`, "conflict", { expectedRevision: options.expectedRevision, actualRevision: project.revision });
  }
  const sequence = sequenceById(project, options.sequenceId);
  const preset = presetById(project, options.presetId);
  const mediaIds = new Set(sequence.clips.flatMap((clip) => clip.source.type === "media" ? [clip.source.mediaId] : []));
  const animationIds = new Set(sequence.clips.flatMap((clip) => clip.source.type === "animation" ? [clip.source.animationId] : []));
  const renderKey = canonicalHash({
    sequence,
    settings: project.settings,
    preset,
    media: project.media.filter((asset) => mediaIds.has(asset.id)).map((asset) => ({ id: asset.id, hash: asset.storage.sha256, offline: asset.offline ?? false })),
    animations: project.animations.filter((animation) => animationIds.has(animation.id)),
    output: { maxWidth: options.maxWidth ?? null, crf: options.crf ?? null, encoderPreset: options.encoderPreset ?? null, defaultFontFile: config.defaultFontFile ?? null },
    renderer: 3
  });
  const cachePath = path.join(store.root, "cache", "renders", `${renderKey}.${preset.container}`);
  const durationTick = sequenceDuration(sequence);
  if (durationTick <= 0) throw new StudioException("EMPTY_SEQUENCE", "The sequence has no renderable duration.", "input");
  const frameCount = ticksToFrames(durationTick, project.settings.fps, "ceil");
  options.onProgress?.(0.02, "Checking render cache");
  const cached = await stat(cachePath).then((info) => info.isFile() && info.size > 0).catch(() => false);
  if (cached) {
    try {
      await publishFile(cachePath, options.outputPath);
      const now = new Date();
      await utimes(cachePath, now, now).catch(() => undefined);
      const [probe, hash] = await Promise.all([probeMedia(options.outputPath, config, options.signal), sha256File(options.outputPath)]);
      options.onProgress?.(1, "Reused cached render");
      return {
        success: true, cacheHit: true, cachePath, outputPath: path.resolve(options.outputPath), projectId: project.projectId, revision: project.revision,
        sequenceId: sequence.id, renderKey, frameCount, durationTick: framesToTicks(frameCount, project.settings.fps), probe, ...hash, durationMs: 0
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      await Promise.all([rm(cachePath, { force: true }), rm(options.outputPath, { force: true })]).catch(() => undefined);
    }
  }
  const scratch = path.join(config.scratchDir, `render-${randomUUID()}`);
  await mkdir(scratch, { recursive: true });
  try {
    options.onProgress?.(0.01, "Planning render");
    const inputs = await buildInputs(project, sequence, store, config, options.signal, options.onProgress);
    const captionFiles = new Map<string, string>();
    await Promise.all(sequence.captions.map(async (caption, index) => {
      const textPath = path.join(scratch, `caption-${index}.txt`);
      await writeFile(textPath, caption.text, "utf8");
      captionFiles.set(caption.id, textPath);
    }));
    const compiled = buildFilterGraph(project, sequence, inputs, captionFiles, options.maxWidth, config.defaultFontFile);
    const graphPath = path.join(scratch, "filter-complex.txt");
    await writeFile(graphPath, compiled.graph, "utf8");
    const inputArgs = inputs.flatMap((input) => input.args);
    const args = [
      ...inputArgs, "-filter_complex_script", graphPath,
      "-map", `[${compiled.videoLabel}]`, "-map", `[${compiled.audioLabel}]`,
      "-frames:v", String(compiled.frameCount), "-shortest",
      "-c:v", preset.videoCodec ?? "libx264",
      ...(preset.videoCodec === "libx264" ? ["-preset", options.encoderPreset ?? "veryfast", "-crf", String(options.crf ?? preset.crf ?? 18)] : []),
      "-c:a", preset.audioCodec ?? "aac",
      ...(preset.audioBitrate ? ["-b:a", preset.audioBitrate] : []),
      ...(preset.faststart ? ["-movflags", "+faststart"] : []),
      "-progress", "pipe:2"
    ];
    const totalSeconds = Math.max(1, ticksToSeconds(compiled.durationTick));
    const result = await ffmpegArtifact(config, args, options.outputPath, {
      signal: options.signal, timeoutMs: 24 * 60 * 60_000,
      onProgress: (progress) => {
        const microseconds = Number(progress.out_time_us);
        if (Number.isFinite(microseconds)) options.onProgress?.(0.2 + Math.min(0.75, microseconds / 1_000_000 / totalSeconds * 0.75), "Rendering sequence");
      }
    });
    options.onProgress?.(0.97, "Verifying output");
    const [probe, hash] = await Promise.all([probeMedia(options.outputPath, config, options.signal), sha256File(options.outputPath)]);
    await publishFile(options.outputPath, cachePath);
    await writeFile(`${cachePath}.json`, `${JSON.stringify({ renderKey, projectId: project.projectId, sequenceId: sequence.id, createdAt: new Date().toISOString(), presetId: preset.id, frameCount: compiled.frameCount, durationTick: compiled.durationTick, sha256: hash.sha256, bytes: hash.bytes }, null, 2)}\n`, "utf8");
    const cache = await pruneRenderCache(store.root, config.cacheMaxBytes, cachePath);
    options.onProgress?.(1, "Completed");
    return {
      success: true, cacheHit: false, cachePath, outputPath: path.resolve(options.outputPath), projectId: project.projectId, revision: project.revision,
      sequenceId: sequence.id, renderKey, frameCount: compiled.frameCount, durationTick: compiled.durationTick, probe, ...hash,
      ffmpegCommand: { executable: config.ffmpegPath, args }, durationMs: result.durationMs, cache
    };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
