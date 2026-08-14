import { z } from "zod";
import { TICKS_PER_SECOND } from "./time.js";

const safeInteger = z.number().int().safe();
const positiveTick = safeInteger.positive();
const id = z.string().min(1).max(200);
const rationalSchema = z.object({
  numerator: safeInteger,
  denominator: safeInteger.refine((value) => value !== 0, "Denominator cannot be zero.")
});
const transformSchema = z.object({
  position: z.tuple([z.number().finite(), z.number().finite()]),
  scale: z.tuple([z.number().finite(), z.number().finite()]),
  rotation: z.number().finite(),
  anchor: z.tuple([z.number().finite(), z.number().finite()]),
  opacity: z.number().finite().min(0).max(1)
});
const effectSchema = z.object({
  id,
  type: id,
  enabled: z.boolean(),
  parameters: z.record(z.string(), z.unknown()),
  version: safeInteger.positive()
});

const trackSchema = z.object({
  id,
  sequenceId: id,
  type: z.enum(["video", "audio", "overlay", "caption"]),
  name: z.string().min(1).max(200),
  order: safeInteger,
  locked: z.boolean(),
  muted: z.boolean(),
  solo: z.boolean(),
  hidden: z.boolean(),
  gainDb: z.number().finite().min(-120).max(24),
  pan: z.number().finite().min(-1).max(1)
});

const clipSchema = z.object({
  id,
  trackId: id,
  name: z.string().min(1).max(300),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("media"), mediaId: id }),
    z.object({ type: z.literal("animation"), animationId: id }),
    z.object({ type: z.literal("color"), color: z.string().min(1) }),
    z.object({ type: z.literal("sequence"), sequenceId: id })
  ]),
  startTick: safeInteger.nonnegative(),
  durationTick: positiveTick,
  sourceInTick: safeInteger.nonnegative(),
  playbackRate: rationalSchema,
  enabled: z.boolean(),
  transform: transformSchema,
  crop: z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }),
  blendMode: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten", "difference"]),
  effects: z.array(effectSchema),
  audio: z.object({
    gainDb: z.number().finite().min(-120).max(24),
    pan: z.number().finite().min(-1).max(1),
    muted: z.boolean(),
    fadeInTick: safeInteger.nonnegative(),
    fadeOutTick: safeInteger.nonnegative(),
    effects: z.array(effectSchema)
  }),
  linkedGroupId: id.optional(),
  groupId: id.optional()
});

const captionSchema = z.object({
  id,
  trackId: id,
  startTick: safeInteger.nonnegative(),
  durationTick: positiveTick,
  text: z.string().min(1).max(10_000),
  style: z.object({
    fontFamily: z.string().min(1).max(200),
    fontSize: z.number().finite().positive().max(500),
    color: z.string().min(1),
    background: z.string().min(1),
    position: z.enum(["top", "center", "bottom"]),
    align: z.enum(["left", "center", "right"])
  })
});

const sequenceSchema = z.object({
  id,
  name: z.string().min(1).max(200),
  tracks: z.array(trackSchema),
  clips: z.array(clipSchema),
  transitions: z.array(z.object({
    id,
    sequenceId: id,
    fromClipId: id,
    toClipId: id,
    type: id,
    durationTick: positiveTick,
    parameters: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
  })),
  automation: z.array(z.object({
    id,
    sequenceId: id,
    target: id,
    enabled: z.boolean(),
    points: z.array(z.object({ tick: safeInteger.nonnegative(), value: z.number().finite(), curve: z.enum(["hold", "linear", "easeIn", "easeOut", "easeInOut", "easeOutExpo", "overshoot"]) }))
  })),
  markers: z.array(z.object({ id, tick: safeInteger.nonnegative(), durationTick: safeInteger.nonnegative(), label: z.string(), color: z.string() })),
  captions: z.array(captionSchema).default([])
});

const animationSchema = z.object({
  id,
  name: z.string().min(1).max(200),
  durationTick: positiveTick,
  canvas: z.object({ width: safeInteger.positive(), height: safeInteger.positive(), background: z.string() }),
  seed: safeInteger,
  mode: z.enum(["declarative", "html"]),
  html: z.string().optional(),
  nodes: z.array(z.object({ id, parentId: id.optional(), type: z.enum(["group", "text", "rect", "ellipse", "line", "path", "image", "video", "camera"]), name: z.string(), properties: z.record(z.string(), z.unknown()), transform: transformSchema })),
  operations: z.array(z.object({ id, type: z.enum(["create", "write", "fade", "transform", "moveAlongPath", "rotate", "scale", "wait"]), targetId: id, startTick: safeInteger.nonnegative(), durationTick: safeInteger.nonnegative(), easing: z.enum(["hold", "linear", "easeIn", "easeOut", "easeInOut", "easeOutExpo", "overshoot"]), parameters: z.record(z.string(), z.unknown()) })),
  htmlAssetId: id.optional()
});

const generationRequestSchema = z.object({
  provider: id,
  model: z.string().min(1).max(300).optional(),
  prompt: z.string().max(100_000).optional(),
  text: z.string().max(100_000).optional(),
  voiceId: z.string().min(1).max(500).optional(),
  language: z.string().min(1).max(100).optional(),
  sourceMediaId: id.optional(),
  seed: safeInteger.optional(),
  outputFormat: z.string().min(1).max(200).optional(),
  parameters: z.record(z.string(), z.unknown()).optional()
});
const generatedArtifactSchema = z.object({
  id,
  kind: z.enum(["narration", "music", "captions", "animation"]),
  name: z.string().min(1).max(300),
  scope: z.object({
    sequenceId: id,
    startTick: safeInteger.nonnegative(),
    durationTick: positiveTick,
    trackId: id.optional(),
    clipId: id.optional()
  }),
  activeVersionId: id.optional(),
  approvedVersionId: id.optional(),
  versions: z.array(z.object({
    id,
    parentVersionId: id.optional(),
    status: z.enum(["queued", "generating", "draft", "approved", "rejected", "failed", "superseded"]),
    request: generationRequestSchema,
    provenance: z.object({ provider: id, model: z.string().max(300), requestHash: z.string().regex(/^[a-f0-9]{64}$/), sourceRevision: safeInteger.nonnegative(), requestId: z.string().optional() }),
    createdAt: z.string(),
    output: z.object({ mediaId: id.optional(), animationId: id.optional(), captions: z.array(captionSchema).optional() }).optional(),
    review: z.object({ reviewer: z.string().min(1).max(300), reviewedAt: z.string(), note: z.string().max(10_000).optional() }).optional(),
    error: z.object({ code: z.string(), message: z.string(), category: z.enum(["input", "conflict", "policy", "runtime", "dependency"]), details: z.record(z.string(), z.unknown()).optional() }).optional()
  })).min(1)
});

export const StudioProjectSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: id,
  revision: safeInteger.nonnegative(),
  name: z.string().min(1).max(200),
  timebase: z.literal(TICKS_PER_SECOND),
  settings: z.object({
    fps: rationalSchema,
    raster: z.object({ width: safeInteger.positive().max(16384), height: safeInteger.positive().max(16384) }),
    sampleRate: z.union([z.literal(44100), z.literal(48000)]),
    channels: z.union([z.literal(1), z.literal(2), z.literal(6)]),
    colorSpace: z.enum(["rec709", "srgb"]),
    background: z.string().min(1)
  }),
  media: z.array(z.object({
    id,
    name: z.string().min(1),
    kind: z.enum(["video", "audio", "image", "font", "subtitle", "animation"]),
    mimeType: z.string().optional(),
    storage: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("managed"), sha256: z.string().regex(/^[a-f0-9]{64}$/), relativePath: z.string().min(1), bytes: safeInteger.nonnegative() }),
      z.object({ mode: z.literal("linked"), path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: safeInteger.nonnegative(), mtimeMs: z.number().nonnegative() })
    ]),
    probe: z.object({
      durationTick: safeInteger.nonnegative(),
      formatName: z.string().optional(),
      hasVideo: z.boolean(),
      hasAudio: z.boolean(),
      width: safeInteger.positive().optional(),
      height: safeInteger.positive().optional(),
      frameRate: rationalSchema.optional(),
      videoCodec: z.string().optional(),
      audioCodec: z.string().optional(),
      sampleRate: safeInteger.positive().optional(),
      channels: safeInteger.positive().optional()
    }),
    createdAt: z.string(),
    offline: z.boolean().optional()
  })),
  sequences: z.array(sequenceSchema).min(1),
  animations: z.array(animationSchema),
  generatedArtifacts: z.array(generatedArtifactSchema).default([]),
  exportPresets: z.array(z.object({
    id,
    name: z.string(),
    container: z.enum(["mp4", "webm", "mkv", "gif", "wav"]),
    videoCodec: z.enum(["libx264", "libx265", "libvpx-vp9", "ffv1", "gif"]).optional(),
    audioCodec: z.enum(["aac", "libopus", "flac", "pcm_s24le"]).optional(),
    crf: safeInteger.optional(),
    videoBitrate: z.string().optional(),
    audioBitrate: z.string().optional(),
    faststart: z.boolean().optional()
  })),
  activeSequenceId: id,
  createdAt: z.string(),
  updatedAt: z.string()
}).superRefine((project, context) => {
  const ids = new Set<string>();
  const add = (value: string, path: (string | number)[]) => {
    if (ids.has(value)) context.addIssue({ code: "custom", message: `Duplicate id: ${value}`, path });
    ids.add(value);
  };
  project.media.forEach((item, index) => add(item.id, ["media", index, "id"]));
  project.sequences.forEach((sequence, sequenceIndex) => {
    add(sequence.id, ["sequences", sequenceIndex, "id"]);
    const trackIds = new Set(sequence.tracks.map((track) => track.id));
    sequence.tracks.forEach((track, index) => {
      add(track.id, ["sequences", sequenceIndex, "tracks", index, "id"]);
      if (track.sequenceId !== sequence.id) context.addIssue({ code: "custom", message: "Track sequenceId mismatch.", path: ["sequences", sequenceIndex, "tracks", index, "sequenceId"] });
    });
    sequence.clips.forEach((clip, index) => {
      add(clip.id, ["sequences", sequenceIndex, "clips", index, "id"]);
      if (!trackIds.has(clip.trackId)) context.addIssue({ code: "custom", message: `Unknown track: ${clip.trackId}`, path: ["sequences", sequenceIndex, "clips", index, "trackId"] });
      if (clip.audio.fadeInTick + clip.audio.fadeOutTick > clip.durationTick) context.addIssue({ code: "custom", message: "Audio fades exceed clip duration.", path: ["sequences", sequenceIndex, "clips", index, "audio"] });
    });
  });
  project.animations.forEach((animation, index) => add(animation.id, ["animations", index, "id"]));
  project.generatedArtifacts.forEach((artifact, artifactIndex) => {
    add(artifact.id, ["generatedArtifacts", artifactIndex, "id"]);
    if (!project.sequences.some((sequence) => sequence.id === artifact.scope.sequenceId)) context.addIssue({ code: "custom", message: "Generated artifact sequence does not exist.", path: ["generatedArtifacts", artifactIndex, "scope", "sequenceId"] });
    const versionIds = new Set(artifact.versions.map((version) => version.id));
    if (artifact.activeVersionId && !versionIds.has(artifact.activeVersionId)) context.addIssue({ code: "custom", message: "activeVersionId does not exist.", path: ["generatedArtifacts", artifactIndex, "activeVersionId"] });
    if (artifact.approvedVersionId && !versionIds.has(artifact.approvedVersionId)) context.addIssue({ code: "custom", message: "approvedVersionId does not exist.", path: ["generatedArtifacts", artifactIndex, "approvedVersionId"] });
    artifact.versions.forEach((version, versionIndex) => add(version.id, ["generatedArtifacts", artifactIndex, "versions", versionIndex, "id"]));
  });
  if (!project.sequences.some((sequence) => sequence.id === project.activeSequenceId)) context.addIssue({ code: "custom", message: "activeSequenceId does not exist.", path: ["activeSequenceId"] });
});
