import type { Rational } from "./time.js";

export type UUID = string;
export type TrackType = "video" | "audio" | "overlay" | "caption";
export type MediaKind = "video" | "audio" | "image" | "font" | "subtitle" | "animation";
export type InsertMode = "overwrite" | "insert" | "ripple" | "replace";
export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "difference";
export type Curve = "hold" | "linear" | "easeIn" | "easeOut" | "easeInOut" | "easeOutExpo" | "overshoot";

export interface Raster {
  width: number;
  height: number;
}

export interface ProjectSettings {
  fps: Rational;
  raster: Raster;
  sampleRate: number;
  channels: 1 | 2 | 6;
  colorSpace: "rec709" | "srgb";
  background: string;
}

export interface MediaProbe {
  durationTick: number;
  formatName?: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  frameRate?: Rational;
  videoCodec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
}

export type ManagedStorage = { mode: "managed"; sha256: string; relativePath: string; bytes: number };
export type LinkedStorage = { mode: "linked"; path: string; sha256: string; bytes: number; mtimeMs: number };

export interface MediaAsset {
  id: UUID;
  name: string;
  kind: MediaKind;
  mimeType?: string;
  storage: ManagedStorage | LinkedStorage;
  probe: MediaProbe;
  createdAt: string;
  offline?: boolean;
}

export interface Track {
  id: UUID;
  sequenceId: UUID;
  type: TrackType;
  name: string;
  order: number;
  locked: boolean;
  muted: boolean;
  solo: boolean;
  hidden: boolean;
  gainDb: number;
  pan: number;
  effects?: EffectInstance[];
}

export interface Transform {
  position: [number, number];
  scale: [number, number];
  rotation: number;
  anchor: [number, number];
  opacity: number;
}

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface EffectInstance {
  id: UUID;
  type: string;
  enabled: boolean;
  parameters: Record<string, unknown>;
  version: number;
}

export interface ClipAudio {
  gainDb: number;
  pan: number;
  muted: boolean;
  fadeInTick: number;
  fadeOutTick: number;
  effects: EffectInstance[];
}

export type ClipSource =
  | { type: "media"; mediaId: UUID }
  | { type: "animation"; animationId: UUID }
  | { type: "color"; color: string }
  | { type: "sequence"; sequenceId: UUID };

export interface Clip {
  id: UUID;
  trackId: UUID;
  name: string;
  source: ClipSource;
  startTick: number;
  durationTick: number;
  sourceInTick: number;
  playbackRate: Rational;
  enabled: boolean;
  transform: Transform;
  crop: Crop;
  blendMode: BlendMode;
  effects: EffectInstance[];
  audio: ClipAudio;
  linkedGroupId?: UUID;
  groupId?: UUID;
}

export interface Transition {
  id: UUID;
  sequenceId: UUID;
  fromClipId: UUID;
  toClipId: UUID;
  type: string;
  durationTick: number;
  parameters: Record<string, number | string | boolean>;
}

export interface AutomationPoint {
  tick: number;
  value: number;
  curve: Curve;
}

export interface AutomationLane {
  id: UUID;
  sequenceId: UUID;
  target: string;
  enabled: boolean;
  points: AutomationPoint[];
}

export interface Marker {
  id: UUID;
  tick: number;
  durationTick: number;
  label: string;
  color: string;
}

export interface CaptionStyle {
  fontMediaId?: UUID;
  outlineColor?: string;
  outlineWidth?: number;
  shadowColor?: string;
  shadowOffset?: number;
  marginLeft?: number;
  marginRight?: number;
  marginVertical?: number;
  fontFamily: string;
  fontSize: number;
  color: string;
  background: string;
  position: "top" | "center" | "bottom";
  align: "left" | "center" | "right";
}

export interface CaptionCue {
  id: UUID;
  trackId: UUID;
  startTick: number;
  durationTick: number;
  text: string;
  style: CaptionStyle;
}

export interface QcAllowance { id:UUID;checkId:"video.black"|"video.freeze"|"audio.silence";startTick:number;endTick:number;reason:string }

export interface Sequence {
  id: UUID;
  name: string;
  tracks: Track[];
  clips: Clip[];
  transitions: Transition[];
  automation: AutomationLane[];
  markers: Marker[];
  captions: CaptionCue[];
  qcAllowances?:QcAllowance[];
}

export type AnimationNodeType = "group" | "text" | "rect" | "ellipse" | "line" | "path" | "image" | "video" | "camera" | "particles";

export interface AnimationNode {
  id: UUID;
  parentId?: UUID;
  type: AnimationNodeType;
  name: string;
  properties: Record<string, unknown>;
  transform: Transform;
}

export interface AnimationOperation {
  id: UUID;
  type: "create" | "write" | "fade" | "transform" | "moveAlongPath" | "rotate" | "scale" | "wait" | "morph" | "property";
  targetId: UUID;
  startTick: number;
  durationTick: number;
  easing: Curve;
  parameters: Record<string, unknown>;
}

export interface AnimationDocument {
  id: UUID;
  name: string;
  durationTick: number;
  canvas: Raster & { background: string };
  seed: number;
  mode: "declarative" | "html";
  /** Self-contained HTML. Define window.renderFrame({ frame, tick, time, seed }) for deterministic scripted frames. */
  html?: string;
  nodes: AnimationNode[];
  operations: AnimationOperation[];
  htmlAssetId?: UUID;
}

export type GeneratedArtifactKind = "narration" | "music" | "captions" | "animation";
export type GeneratedVersionStatus = "queued" | "generating" | "draft" | "approved" | "rejected" | "failed" | "superseded";

export interface GenerationScope {
  sequenceId: UUID;
  startTick: number;
  durationTick: number;
  trackId?: UUID;
  clipId?: UUID;
}

export interface GenerationRequest {
  provider: string;
  model?: string;
  prompt?: string;
  text?: string;
  voiceId?: string;
  language?: string;
  sourceMediaId?: UUID;
  seed?: number;
  outputFormat?: string;
  parameters?: Record<string, unknown>;
}

export interface GenerationProvenance {
  provider: string;
  model: string;
  requestHash: string;
  sourceRevision: number;
  requestId?: string;
}

export interface GeneratedSegment {
  offsetTick: number;
  durationTick: number;
  source: { type: "media"; mediaId: UUID } | { type: "animation"; animationId: UUID };
  sourceInTick: number;
}

export interface GeneratedArtifactOutput {
  /** Complete composition; each region keeps its original source and offset. */
  segments?: GeneratedSegment[];
  mediaId?: UUID;
  animationId?: UUID;
  captions?: CaptionCue[];
}

export interface GenerationReview {
  reviewer: string;
  reviewedAt: string;
  note?: string;
}

export interface GeneratedArtifactVersion {
  /** Region is relative to artifact.scope, not to the current playhead. */
  region?: { offsetTick: number; durationTick: number };
  autoActivate?: boolean;
  id: UUID;
  parentVersionId?: UUID;
  status: GeneratedVersionStatus;
  request: GenerationRequest;
  provenance: GenerationProvenance;
  createdAt: string;
  output?: GeneratedArtifactOutput;
  review?: GenerationReview;
  error?: StudioError;
}

export interface GeneratedArtifact {
  /** Persisted ownership of split clips; unrelated timeline clips are never replaced. */
  clipBindings?: Array<{ clipId: UUID; offsetTick: number; durationTick: number }>;
  id: UUID;
  kind: GeneratedArtifactKind;
  name: string;
  scope: GenerationScope;
  activeVersionId?: UUID;
  approvedVersionId?: UUID;
  versions: GeneratedArtifactVersion[];
}

export interface ExportPreset {
  id: UUID;
  name: string;
  container: "mp4" | "webm" | "mkv" | "gif" | "wav";
  videoCodec?: "libx264" | "libx265" | "libvpx-vp9" | "ffv1" | "gif";
  audioCodec?: "aac" | "libopus" | "flac" | "pcm_s24le";
  crf?: number;
  videoBitrate?: string;
  audioBitrate?: string;
  faststart?: boolean;
}

export interface StudioProject {
  schemaVersion: 2;
  projectId: UUID;
  revision: number;
  name: string;
  timebase: number;
  settings: ProjectSettings;
  media: MediaAsset[];
  sequences: Sequence[];
  animations: AnimationDocument[];
  generatedArtifacts: GeneratedArtifact[];
  exportPresets: ExportPreset[];
  activeSequenceId: UUID;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDelta {
  sequences: UUID[];
  tracks: UUID[];
  clips: UUID[];
  media: UUID[];
  animations: UUID[];
  generatedArtifacts: UUID[];
}

export interface MutationResult {
  success: true;
  projectId: UUID;
  revision: number;
  transactionId: UUID;
  changed: ProjectDelta;
  warnings: string[];
}

export interface StudioError {
  code: string;
  message: string;
  category: "input" | "conflict" | "policy" | "runtime" | "dependency";
  details?: Record<string, unknown>;
}

export interface FailureResult {
  success: false;
  error: StudioError;
}

export type StudioResult<T> = ({ success: true } & T) | FailureResult;

export interface JobRecord {
  id: UUID;
  type: "probe" | "proxy" | "thumbnail" | "waveform" | "preview" | "render" | "animation" | "generation" | "qc";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  result?: Record<string, unknown>;
  error?: StudioError;
}

export type AdvancedProjectCommand =
  | { type: "clip.slip"; sequenceId: UUID; clipId: UUID; deltaTick: number }
  | { type: "clip.roll"; sequenceId: UUID; clipId: UUID; tick: number }
  | { type: "clip.slide"; sequenceId: UUID; clipId: UUID; deltaTick: number }
  | { type: "gap.remove"; sequenceId: UUID; startTick: number; endTick: number }
  | { type: "audio.gain.range"; sequenceId: UUID; targetType: "clip" | "track"; targetId: UUID; startTick: number; endTick: number; gainDb: number; laneId?: UUID }
  | { type: "animation.node.add"; animationId: UUID; node: AnimationNode }
  | { type: "animation.node.update"; animationId: UUID; nodeId: UUID; patch: Partial<Pick<AnimationNode, "name" | "properties" | "transform">> & { parentId?: UUID | null } }
  | { type: "animation.node.remove"; animationId: UUID; nodeId: UUID; cascade: boolean }
  | { type: "animation.operation.add"; animationId: UUID; operation: AnimationOperation }
  | { type: "animation.operation.update"; animationId: UUID; operationId: UUID; patch: Partial<Omit<AnimationOperation, "id">> }
  | { type: "animation.operation.remove"; animationId: UUID; operationId: UUID }
  | { type: "animation.operations.reorder"; animationId: UUID; operationIds: UUID[] };

export type ProjectCommand =
  | AdvancedProjectCommand
  | { type: "track.add"; sequenceId: UUID; track: Omit<Track, "sequenceId"> }
  | { type: "track.update"; sequenceId: UUID; trackId: UUID; patch: Partial<Pick<Track, "name" | "order" | "locked" | "muted" | "solo" | "hidden" | "gainDb" | "pan" | "effects">> }
  | { type: "track.remove"; sequenceId: UUID; trackId: UUID; removeClips: boolean }
  | { type: "clip.add"; sequenceId: UUID; clip: Clip; mode: InsertMode }
  | { type: "clip.move"; sequenceId: UUID; clipIds: UUID[]; targetTrackId: UUID; startTick: number; ripple: boolean }
  | { type: "clip.trim"; sequenceId: UUID; clipId: UUID; edge: "in" | "out"; tick: number; ripple: boolean }
  | { type: "clip.split"; sequenceId: UUID; clipId: UUID; atTick: number; rightClipId: UUID }
  | { type: "clip.relate"; sequenceId: UUID; clipIds: UUID[]; relation: "group" | "link"; relationshipId: UUID | null }
  | { type: "clip.remove"; sequenceId: UUID; clipIds: UUID[]; ripple: boolean }
  | { type: "clip.update"; sequenceId: UUID; clipId: UUID; patch: Partial<Pick<Clip, "name" | "sourceInTick" | "durationTick" | "playbackRate" | "enabled" | "transform" | "crop" | "blendMode" | "effects" | "audio" | "linkedGroupId" | "groupId">> }
  | { type: "transition.add"; sequenceId: UUID; transition: Transition }
  | { type: "transition.update"; sequenceId: UUID; transitionId: UUID; patch: Partial<Pick<Transition, "type" | "durationTick" | "parameters">> }
  | { type: "transition.remove"; sequenceId: UUID; transitionId: UUID }
  | { type: "automation.set"; sequenceId: UUID; lane: AutomationLane }
  | { type: "automation.remove"; sequenceId: UUID; laneId: UUID }
  | { type: "qc.allowance.set"; sequenceId:UUID; allowance:QcAllowance }
  | { type: "qc.allowance.remove"; sequenceId:UUID; allowanceId:UUID }
  | { type: "marker.add"; sequenceId: UUID; marker: Marker }
  | { type: "marker.update"; sequenceId: UUID; markerId: UUID; patch: Partial<Pick<Marker, "tick" | "durationTick" | "label" | "color">> }
  | { type: "marker.remove"; sequenceId: UUID; markerId: UUID }
  | { type: "caption.add"; sequenceId: UUID; caption: CaptionCue }
  | { type: "caption.update"; sequenceId: UUID; captionId: UUID; patch: Partial<Pick<CaptionCue, "trackId" | "startTick" | "durationTick" | "text" | "style">> }
  | { type: "caption.remove"; sequenceId: UUID; captionIds: UUID[] }
  | { type: "animation.set"; animation: AnimationDocument }
  | { type: "generation.create"; artifact: GeneratedArtifact }
  | { type: "generation.version.add"; artifactId: UUID; version: GeneratedArtifactVersion }
  | { type: "generation.version.update"; artifactId: UUID; versionId: UUID; patch: Partial<Pick<GeneratedArtifactVersion, "status" | "output" | "review" | "error">> }
  | { type: "generation.version.activate"; artifactId: UUID; versionId: UUID }
  | { type: "project.rename"; name: string }
  | { type: "sequence.add"; sequence: Sequence }
  | { type: "sequence.rename"; sequenceId: UUID; name: string }
  | { type: "sequence.activate"; sequenceId: UUID }
  | { type: "sequence.remove"; sequenceId: UUID };
