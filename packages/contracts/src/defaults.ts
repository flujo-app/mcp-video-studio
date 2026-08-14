import { TICKS_PER_SECOND } from "./time.js";
import type { Clip, ExportPreset, Sequence, StudioProject, Track, TrackType } from "./types.js";

export function defaultTransform() {
  return { position: [0.5, 0.5] as [number, number], scale: [1, 1] as [number, number], rotation: 0, anchor: [0.5, 0.5] as [number, number], opacity: 1 };
}

export function defaultTrack(sequenceId: string, type: TrackType, order: number, name?: string): Track {
  return { id: crypto.randomUUID(), sequenceId, type, name: name ?? `${type[0]?.toUpperCase()}${type.slice(1)} ${order + 1}`, order, locked: false, muted: false, solo: false, hidden: false, gainDb: 0, pan: 0 };
}

export function defaultClip(trackId: string, source: Clip["source"], name: string, durationTick: number): Clip {
  return {
    id: crypto.randomUUID(), trackId, name, source, startTick: 0, durationTick, sourceInTick: 0,
    playbackRate: { numerator: 1, denominator: 1 }, enabled: true, transform: defaultTransform(),
    crop: { left: 0, top: 0, right: 0, bottom: 0 }, blendMode: "normal", effects: [],
    audio: { gainDb: 0, pan: 0, muted: false, fadeInTick: 0, fadeOutTick: 0, effects: [] }
  };
}

export const DEFAULT_EXPORT_PRESETS: ExportPreset[] = [
  { id: "web-h264-1080p", name: "Web H.264", container: "mp4", videoCodec: "libx264", audioCodec: "aac", crf: 18, audioBitrate: "192k", faststart: true },
  { id: "archive-ffv1", name: "Lossless FFV1", container: "mkv", videoCodec: "ffv1", audioCodec: "flac" }
];

export function createDefaultProject(name: string): StudioProject {
  const now = new Date().toISOString();
  const sequenceId = crypto.randomUUID();
  const tracks = [defaultTrack(sequenceId, "video", 0, "Video 1"), defaultTrack(sequenceId, "audio", 1, "Audio 1"), defaultTrack(sequenceId, "caption", 2, "Captions")];
  const sequence: Sequence = { id: sequenceId, name: "Main sequence", tracks, clips: [], transitions: [], automation: [], markers: [], captions: [] };
  return {
    schemaVersion: 1, projectId: crypto.randomUUID(), revision: 0, name, timebase: TICKS_PER_SECOND,
    settings: { fps: { numerator: 30, denominator: 1 }, raster: { width: 1920, height: 1080 }, sampleRate: 48000, channels: 2, colorSpace: "rec709", background: "#000000" },
    media: [], sequences: [sequence], animations: [], generatedArtifacts: [], exportPresets: DEFAULT_EXPORT_PRESETS.map((preset) => ({ ...preset })),
    activeSequenceId: sequenceId, createdAt: now, updatedAt: now
  };
}
