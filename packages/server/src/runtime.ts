import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { chromium } from "patchright";
import {
  defaultClip,
  defaultTransform,
  defaultTrack,
  framesToTicks,
  secondsToTicks,
  ticksToFrames,
  type AnimationDocument,
  type CaptionCue,
  type ClipSource,
  type GeneratedArtifact,
  type GeneratedArtifactKind,
  type GeneratedArtifactVersion,
  type GenerationRequest,
  type MediaAsset,
  type ProjectCommand,
  type ProjectDelta,
  type StudioProject,
  type TrackType
} from "@mcp-video-studio/contracts";
import { asStudioError, atomicWrite, discoverProjects, ProjectStore, projectSummary, StudioException, validateProject } from "@mcp-video-studio/core";
import {
  createProxy,
  createThumbnail,
  createWaveform,
  consolidateMedia,
  doctor,
  importMedia,
  inspectMedia,
  loadConfig,
  mediaPath,
  probeMedia,
  providerStatus,
  relinkMedia,
  type StudioConfig
} from "@mcp-video-studio/media";
import { JobManager, renderCacheStats, renderSequence, runQc } from "@mcp-video-studio/renderer";
import { renderAnimation } from "@mcp-video-studio/animation";
import { GenerationProviders, type TranscriptionResult } from "./generation.js";

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "project";
}

function generationHash(request: GenerationRequest, scope: GeneratedArtifact["scope"]): string {
  return createHash("sha256").update(JSON.stringify({ request, scope })).digest("hex");
}

function generationDelta(artifactId: string, extra: Partial<ProjectDelta> = {}): ProjectDelta {
  return { sequences: [], tracks: [], clips: [], media: [], animations: [], generatedArtifacts: [artifactId], ...extra };
}

async function mutateLatest(store: ProjectStore, commands: ProjectCommand[]): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const project = await store.read();
    try { await store.mutate(project.revision, commands); return; }
    catch (error) {
      if (!(error instanceof StudioException) || error.studio.code !== "REVISION_CONFLICT" || attempt === 7) throw error;
    }
  }
}

async function replaceLatest(store: ProjectStore, mutator: (project: StudioProject) => void, changed: ProjectDelta): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const project = await store.read();
    try { await store.replace(project.revision, mutator, changed); return; }
    catch (error) {
      if (!(error instanceof StudioException) || error.studio.code !== "REVISION_CONFLICT" || attempt === 7) throw error;
    }
  }
}

function effectiveModel(config: StudioConfig, kind: GeneratedArtifactKind, request: GenerationRequest): string {
  if (request.model) return request.model;
  if (kind === "animation") return config.providers.language.model;
  if (request.provider === "elevenlabs") {
    if (kind === "narration") return config.providers.elevenLabs.speechModel;
    if (kind === "captions") return config.providers.elevenLabs.transcriptionModel;
    return config.providers.elevenLabs.musicModel;
  }
  return kind === "narration" ? config.providers.openaiAudio.speechModel : config.providers.openaiAudio.transcriptionModel;
}

function transcriptCues(transcript: TranscriptionResult, artifact: GeneratedArtifact, trackId: string, project: StudioProject): CaptionCue[] {
  const frameTick = framesToTicks(1, project.settings.fps);
  const align = (tick: number, mode: "floor" | "ceil" = "floor") => framesToTicks(ticksToFrames(Math.max(0, tick), project.settings.fps, mode), project.settings.fps);
  const style = { fontFamily: "Arial", fontSize: Math.round(54 * project.settings.raster.height / 1080), color: "#ffffff", background: "#000000aa", position: "bottom" as const, align: "center" as const };
  if (transcript.words.length === 0) return [{ id: randomUUID(), trackId, startTick: artifact.scope.startTick, durationTick: artifact.scope.durationTick, text: transcript.text.trim() || "[No speech detected]", style }];
  const groups: typeof transcript.words[] = [];
  let current: typeof transcript.words = [];
  for (const word of transcript.words) {
    const nextText = [...current, word].map((item) => item.text.trim()).join(" ");
    const duration = current.length ? word.endSeconds - current[0]!.startSeconds : 0;
    if (current.length && (nextText.length > 54 || duration > 4.5 || /[.!?]$/.test(current.at(-1)!.text.trim()))) { groups.push(current); current = []; }
    current.push(word);
  }
  if (current.length) groups.push(current);
  return groups.flatMap((group) => {
    const rawStart = artifact.scope.startTick + secondsToTicks(group[0]!.startSeconds);
    if (rawStart >= artifact.scope.startTick + artifact.scope.durationTick) return [];
    const startTick = align(rawStart);
    const rawEnd = Math.min(artifact.scope.startTick + artifact.scope.durationTick, artifact.scope.startTick + secondsToTicks(group.at(-1)!.endSeconds));
    const endTick = Math.max(startTick + frameTick, align(rawEnd, "ceil"));
    return [{ id: randomUUID(), trackId, startTick, durationTick: endTick - startTick, text: group.map((word) => word.text.trim()).join(" ").replace(/\s+([,.!?;:])/g, "$1"), style }];
  });
}

export class StudioRuntime {
  readonly config: StudioConfig;
  readonly jobs: JobManager;
  readonly generation: GenerationProviders;

  constructor(config: StudioConfig = loadConfig()) {
    this.config = config;
    this.jobs = new JobManager(path.join(config.dataDir, "jobs"), config.maxConcurrentJobs);
    this.generation = new GenerationProviders(config);
  }

  async initialize(): Promise<void> {
    await this.jobs.initialize();
  }

  store(projectPath: string): ProjectStore {
    if (!projectPath?.trim()) throw new StudioException("PROJECT_PATH_REQUIRED", "projectPath is required.", "input");
    return new ProjectStore(projectPath);
  }

  async doctor(): Promise<Record<string, unknown>> {
    const result = await doctor(this.config);
    const executablePath = chromium.executablePath();
    const browser = await stat(executablePath).then((info) => ({ available: info.isFile(), executablePath, bytes: info.size })).catch((error) => ({ available: false, executablePath, error: error instanceof Error ? error.message : String(error) }));
    return { ...result, browser };
  }

  async listProjects(): Promise<Record<string, unknown>> {
    return { success: true, projects: await discoverProjects(this.config.projectsDir), projectsDir: this.config.projectsDir };
  }

  async createProject(name: string, requestedPath?: string): Promise<Record<string, unknown>> {
    const projectPath = path.resolve(requestedPath?.trim() || path.join(this.config.projectsDir, `${slug(name)}-${randomUUID().slice(0, 8)}`));
    const store = await ProjectStore.create(projectPath, name);
    const project = await store.read();
    return { success: true, projectPath, project, summary: projectSummary(project) };
  }

  async getProject(projectPath: string): Promise<Record<string, unknown>> {
    const project = await this.store(projectPath).read();
    return { success: true, projectPath: path.resolve(projectPath), project, summary: projectSummary(project) };
  }

  async getSequence(projectPath: string, sequenceId?: string): Promise<Record<string, unknown>> {
    const project = await this.store(projectPath).read();
    const id = sequenceId || project.activeSequenceId;
    const sequence = project.sequences.find((candidate) => candidate.id === id);
    if (!sequence) throw new StudioException("SEQUENCE_NOT_FOUND", `Sequence not found: ${id}`, "input");
    return { success: true, projectPath: path.resolve(projectPath), projectId: project.projectId, revision: project.revision, sequence };
  }

  async apply(projectPath: string, expectedRevision: number, commands: ProjectCommand[]): Promise<Record<string, unknown>> {
    const store = this.store(projectPath);
    const mutation = await store.mutate(expectedRevision, commands);
    const project = await store.read();
    return { ...mutation, projectPath: store.root, project, summary: projectSummary(project) };
  }

  async undo(projectPath: string, expectedRevision: number): Promise<Record<string, unknown>> {
    const store = this.store(projectPath);
    const mutation = await store.undo(expectedRevision);
    return { ...mutation, project: await store.read(), projectPath: store.root };
  }

  async redo(projectPath: string, expectedRevision: number): Promise<Record<string, unknown>> {
    const store = this.store(projectPath);
    const mutation = await store.redo(expectedRevision);
    return { ...mutation, project: await store.read(), projectPath: store.root };
  }

  async addTrack(projectPath: string, expectedRevision: number, sequenceId: string, type: TrackType, name?: string): Promise<Record<string, unknown>> {
    const project = await this.store(projectPath).read();
    const sequence = project.sequences.find((candidate) => candidate.id === sequenceId);
    if (!sequence) throw new StudioException("SEQUENCE_NOT_FOUND", `Sequence not found: ${sequenceId}`, "input");
    const sameType = sequence.tracks.filter((track) => track.type === type);
    const nextOrder = Math.max(-1, ...sequence.tracks.map((track) => track.order)) + 1;
    const track = defaultTrack(sequenceId, type, nextOrder, name ?? `${type[0]?.toUpperCase()}${type.slice(1)} ${sameType.length + 1}`);
    const { sequenceId: _sequenceId, ...commandTrack } = track;
    return this.apply(projectPath, expectedRevision, [{ type: "track.add", sequenceId, track: commandTrack }]);
  }

  async addClip(input: {
    projectPath: string; expectedRevision: number; sequenceId: string; trackId: string; source: ClipSource;
    name: string; startTick: number; durationTick: number; mode?: "overwrite" | "insert" | "ripple" | "replace";
  }): Promise<Record<string, unknown>> {
    const clip = defaultClip(input.trackId, input.source, input.name, input.durationTick);
    clip.startTick = input.startTick;
    return this.apply(input.projectPath, input.expectedRevision, [{ type: "clip.add", sequenceId: input.sequenceId, clip, mode: input.mode ?? "overwrite" }]);
  }

  async import(input: { projectPath: string; filePath: string; storageMode?: "managed" | "linked"; expectedRevision: number }): Promise<Record<string, unknown>> {
    const store = this.store(input.projectPath);
    const imported = await importMedia(store, input.filePath, input.storageMode ?? "managed", input.expectedRevision, this.config);
    const asset = imported.asset.media;
    const jobIds: string[] = [];
    if (!imported.asset.deduplicated) {
      if (asset.probe.hasVideo) {
        const thumb = await this.jobs.enqueue("thumbnail", `Creating thumbnail for ${asset.name}`, async ({ signal, progress }) => {
          await progress(0.1, "Creating thumbnail");
          const result = await createThumbnail(store, asset, this.config, 0, signal);
          await progress(1); return result;
        });
        const proxy = await this.jobs.enqueue("proxy", `Creating proxy for ${asset.name}`, async ({ signal, progress }) => createProxy(store, asset, this.config, signal, (value) => void progress(value, "Creating proxy")));
        jobIds.push(thumb.id, proxy.id);
      }
      if (asset.probe.hasAudio) {
        const waveform = await this.jobs.enqueue("waveform", `Creating waveform for ${asset.name}`, async ({ signal, progress }) => {
          await progress(0.1, "Creating waveform");
          const result = await createWaveform(store, asset, this.config, signal);
          await progress(1); return result;
        });
        jobIds.push(waveform.id);
      }
    }
    return { success: true, ...imported, projectPath: store.root, project: await store.read(), jobIds };
  }

  async relink(input: { projectPath: string; mediaId: string; filePath: string; expectedRevision: number }): Promise<Record<string, unknown>> {
    const store = this.store(input.projectPath);
    const result = await relinkMedia(store, input.mediaId, input.filePath, input.expectedRevision, this.config);
    return { success: true, ...result, projectPath: store.root, project: await store.read() };
  }

  async consolidate(input: { projectPath: string; mediaIds?: string[]; expectedRevision: number }): Promise<Record<string, unknown>> {
    const store = this.store(input.projectPath);
    const result = await consolidateMedia(store, input.mediaIds, input.expectedRevision);
    return { success: true, ...result, projectPath: store.root, project: await store.read() };
  }

  async inspect(projectPath: string, mediaIds?: string[]): Promise<Record<string, unknown>> {
    const store = this.store(projectPath);
    const project = await store.read();
    return { success: true, projectId: project.projectId, revision: project.revision, media: await inspectMedia(store, mediaIds) };
  }

  async cacheStatus(projectPath: string): Promise<Record<string, unknown>> {
    const store = this.store(projectPath);
    const project = await store.read();
    return { success: true, projectId: project.projectId, revision: project.revision, maxBytes: this.config.cacheMaxBytes, renderCache: await renderCacheStats(store.root) };
  }

  async getProviderStatus(): Promise<Record<string, unknown>> {
    return { success: true, providers: providerStatus(this.config) };
  }

  async listGeneratedArtifacts(projectPath: string): Promise<Record<string, unknown>> {
    const project = await this.store(projectPath).read();
    return { success: true, projectId: project.projectId, revision: project.revision, artifacts: project.generatedArtifacts };
  }

  private async queueGeneratedArtifact(input: {
    projectPath: string;
    expectedRevision: number;
    kind: GeneratedArtifactKind;
    name: string;
    sequenceId: string;
    trackId?: string;
    clipId?: string;
    startTick: number;
    durationTick: number;
    request: GenerationRequest;
    artifactId?: string;
    parentVersionId?: string;
  }): Promise<Record<string, unknown>> {
    const store = this.store(input.projectPath);
    const project = await store.read();
    if (project.revision !== input.expectedRevision) throw new StudioException("REVISION_CONFLICT", "Project revision changed.", "conflict", { expectedRevision: input.expectedRevision, actualRevision: project.revision });
    const sequence = project.sequences.find((item) => item.id === input.sequenceId);
    if (!sequence) throw new StudioException("SEQUENCE_NOT_FOUND", `Sequence not found: ${input.sequenceId}`, "input");
    if (input.durationTick <= 0) throw new StudioException("INVALID_GENERATION_RANGE", "Generated content requires a positive duration.", "input");
    const track = input.trackId ? sequence.tracks.find((item) => item.id === input.trackId) : undefined;
    if (input.kind === "captions" && track?.type !== "caption") throw new StudioException("INVALID_CAPTION_TRACK", "Caption generation requires a caption track.", "input");
    if ((input.kind === "narration" || input.kind === "music") && track?.type !== "audio" && !input.clipId) throw new StudioException("INVALID_AUDIO_TRACK", "Audio generation requires an audio track or an existing clip.", "input");
    if (input.kind === "animation" && track?.type !== "video" && track?.type !== "overlay" && !input.clipId) throw new StudioException("INVALID_ANIMATION_TRACK", "Animation generation requires a video/overlay track or an existing clip.", "input");
    if (input.request.sourceMediaId && !project.media.some((item) => item.id === input.request.sourceMediaId)) throw new StudioException("MEDIA_NOT_FOUND", `Source media not found: ${input.request.sourceMediaId}`, "input");

    const artifactId = input.artifactId ?? randomUUID();
    const versionId = randomUUID();
    const scope: GeneratedArtifact["scope"] = {
      sequenceId: input.sequenceId,
      startTick: input.startTick,
      durationTick: input.durationTick,
      ...(input.trackId ? { trackId: input.trackId } : {}),
      ...((input.kind === "narration" || input.kind === "music" || input.kind === "animation") ? { clipId: input.clipId ?? randomUUID() } : {})
    };
    const version: GeneratedArtifactVersion = {
      id: versionId,
      ...(input.parentVersionId ? { parentVersionId: input.parentVersionId } : {}),
      status: "queued",
      request: structuredClone(input.request),
      provenance: { provider: input.request.provider, model: effectiveModel(this.config, input.kind, input.request), requestHash: generationHash(input.request, scope), sourceRevision: project.revision },
      createdAt: new Date().toISOString()
    };
    if (input.artifactId) {
      const artifact = project.generatedArtifacts.find((item) => item.id === input.artifactId);
      if (!artifact) throw new StudioException("GENERATION_NOT_FOUND", `Generated artifact not found: ${input.artifactId}`, "input");
      if (artifact.kind !== input.kind) throw new StudioException("GENERATION_KIND_MISMATCH", "A generated artifact cannot change kind.", "input");
      await store.mutate(project.revision, [{ type: "generation.version.add", artifactId, version }]);
    } else {
      const artifact: GeneratedArtifact = { id: artifactId, kind: input.kind, name: input.name, scope, versions: [version] };
      await store.mutate(project.revision, [{ type: "generation.create", artifact }]);
    }

    const job = await this.jobs.enqueue("generation", `Generating ${input.kind}: ${input.name}`, async ({ signal, progress }) => {
      try {
        await mutateLatest(store, [{ type: "generation.version.update", artifactId, versionId, patch: { status: "generating" } }]);
        await progress(0.08, `Requesting ${input.request.provider}`);
        const current = await store.read();
        const artifact = current.generatedArtifacts.find((item) => item.id === artifactId)!;
        if (input.kind === "captions") {
          const sourceId = input.request.sourceMediaId;
          if (!sourceId) throw new StudioException("SOURCE_MEDIA_REQUIRED", "Caption generation requires sourceMediaId.", "input");
          const media = current.media.find((item) => item.id === sourceId);
          if (!media) throw new StudioException("MEDIA_NOT_FOUND", `Source media not found: ${sourceId}`, "input");
          const transcript = await this.generation.transcribe(input.request, mediaPath(store, media), signal);
          await progress(0.72, "Converting transcript to editable cues");
          const captionTrackId = artifact.scope.trackId;
          if (!captionTrackId) throw new StudioException("INVALID_CAPTION_TRACK", "Generated captions are not bound to a caption track.", "runtime");
          const captions = transcriptCues(transcript, artifact, captionTrackId, current);
          await replaceLatest(store, (draft) => {
            const target = draft.generatedArtifacts.find((item) => item.id === artifactId)!;
            const targetVersion = target.versions.find((item) => item.id === versionId)!;
            targetVersion.status = "draft";
            targetVersion.output = { captions };
            targetVersion.provenance.model = transcript.model;
            if (transcript.requestId) targetVersion.provenance.requestId = transcript.requestId;
            if (!target.activeVersionId) {
              const targetSequence = draft.sequences.find((item) => item.id === target.scope.sequenceId)!;
              targetSequence.captions.push(...structuredClone(captions));
              target.activeVersionId = versionId;
            }
          }, generationDelta(artifactId, { sequences: [artifact.scope.sequenceId] }));
          await progress(1, "Caption draft ready for review");
          return { artifactId, versionId, kind: input.kind, captionCount: captions.length };
        }
        if (input.kind === "animation") {
          const result = await this.generation.generateAnimation(input.request, { name: input.name, durationTick: artifact.scope.durationTick, canvas: current.settings.raster, fps: current.settings.fps }, signal);
          const candidate = structuredClone(current);
          candidate.animations.push(result.animation);
          validateProject(candidate);
          await progress(0.72, "Saving animation draft");
          await replaceLatest(store, (draft) => {
            draft.animations.push(structuredClone(result.animation));
            const target = draft.generatedArtifacts.find((item) => item.id === artifactId)!;
            const targetVersion = target.versions.find((item) => item.id === versionId)!;
            targetVersion.status = "draft";
            targetVersion.output = { animationId: result.animation.id };
            targetVersion.provenance.model = result.model;
            if (result.requestId) targetVersion.provenance.requestId = result.requestId;
            if (!target.activeVersionId) {
              const targetSequence = draft.sequences.find((item) => item.id === target.scope.sequenceId)!;
              let clip = target.scope.clipId ? targetSequence.clips.find((item) => item.id === target.scope.clipId) : undefined;
              if (!clip) {
                if (!target.scope.trackId || !target.scope.clipId) throw new StudioException("GENERATION_SCOPE_INVALID", "Animation generation requires a track and clip binding.", "runtime");
                clip = defaultClip(target.scope.trackId, { type: "animation", animationId: result.animation.id }, target.name, target.scope.durationTick);
                clip.id = target.scope.clipId; clip.startTick = target.scope.startTick; targetSequence.clips.push(clip);
              } else clip.source = { type: "animation", animationId: result.animation.id };
              target.activeVersionId = versionId;
            }
          }, generationDelta(artifactId, { sequences: [artifact.scope.sequenceId], clips: artifact.scope.clipId ? [artifact.scope.clipId] : [], animations: [result.animation.id] }));
          await progress(1, "Animation draft ready for review");
          return { artifactId, versionId, kind: input.kind, animationId: result.animation.id };
        }

        const binary = input.kind === "music"
          ? await this.generation.composeMusic(input.request, artifact.scope.durationTick, signal)
          : await this.generation.synthesizeSpeech(input.request, signal);
        await progress(0.65, "Importing generated audio");
        const sha256 = createHash("sha256").update(binary.data).digest("hex");
        const relativePath = path.join("assets", sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.${binary.extension}`);
        const filePath = path.join(store.root, relativePath);
        await atomicWrite(filePath, binary.data);
        const probe = await probeMedia(filePath, this.config, signal);
        const latest = await store.read();
        const existing = latest.media.find((item) => item.storage.sha256 === sha256);
        const media: MediaAsset = existing ?? { id: randomUUID(), name: `${input.name}.${binary.extension}`, kind: "audio", mimeType: binary.mimeType, storage: { mode: "managed", sha256, relativePath, bytes: binary.data.byteLength }, probe, createdAt: new Date().toISOString() };
        await replaceLatest(store, (draft) => {
          if (!draft.media.some((item) => item.id === media.id)) draft.media.push(structuredClone(media));
          const target = draft.generatedArtifacts.find((item) => item.id === artifactId)!;
          const targetVersion = target.versions.find((item) => item.id === versionId)!;
          targetVersion.status = "draft";
          targetVersion.output = { mediaId: media.id };
          targetVersion.provenance.model = binary.model;
          if (binary.requestId) targetVersion.provenance.requestId = binary.requestId;
          if (!target.activeVersionId) {
            const targetSequence = draft.sequences.find((item) => item.id === target.scope.sequenceId)!;
            let clip = target.scope.clipId ? targetSequence.clips.find((item) => item.id === target.scope.clipId) : undefined;
            if (!clip) {
              if (!target.scope.trackId || !target.scope.clipId) throw new StudioException("GENERATION_SCOPE_INVALID", "Audio generation requires a track and clip binding.", "runtime");
              clip = defaultClip(target.scope.trackId, { type: "media", mediaId: media.id }, target.name, target.scope.durationTick);
              clip.id = target.scope.clipId; clip.startTick = target.scope.startTick; targetSequence.clips.push(clip);
            } else clip.source = { type: "media", mediaId: media.id };
            target.activeVersionId = versionId;
          }
        }, generationDelta(artifactId, { sequences: [artifact.scope.sequenceId], clips: artifact.scope.clipId ? [artifact.scope.clipId] : [], media: existing ? [] : [media.id] }));
        const waveform = await this.jobs.enqueue("waveform", `Creating waveform for ${media.name}`, ({ signal: waveformSignal }) => createWaveform(store, media, this.config, waveformSignal));
        await progress(1, `${input.kind === "music" ? "Music" : "Narration"} draft ready for review`);
        return { artifactId, versionId, kind: input.kind, mediaId: media.id, waveformJobId: waveform.id };
      } catch (error) {
        await mutateLatest(store, [{ type: "generation.version.update", artifactId, versionId, patch: { status: "failed", error: asStudioError(error) } }]).catch(() => undefined);
        throw error;
      }
    });
    return { success: true, projectPath: store.root, artifactId, versionId, job, project: await store.read() };
  }

  async generateNarration(input: { projectPath: string; expectedRevision: number; sequenceId: string; trackId: string; clipId?: string; startTick: number; durationTick: number; name: string; text: string; provider: "openai" | "elevenlabs"; model?: string; voiceId?: string; language?: string; seed?: number; parameters?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.queueGeneratedArtifact({ ...input, kind: "narration", request: { provider: input.provider, text: input.text, ...(input.model ? { model: input.model } : {}), ...(input.voiceId ? { voiceId: input.voiceId } : {}), ...(input.language ? { language: input.language } : {}), ...(input.seed !== undefined ? { seed: input.seed } : {}), ...(input.parameters ? { parameters: input.parameters } : {}) } });
  }

  async generateMusic(input: { projectPath: string; expectedRevision: number; sequenceId: string; trackId: string; clipId?: string; startTick: number; durationTick: number; name: string; prompt: string; model?: string; seed?: number; parameters?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.queueGeneratedArtifact({ ...input, kind: "music", request: { provider: "elevenlabs", prompt: input.prompt, ...(input.model ? { model: input.model } : {}), ...(input.seed !== undefined ? { seed: input.seed } : {}), ...(input.parameters ? { parameters: input.parameters } : {}) } });
  }

  async generateCaptions(input: { projectPath: string; expectedRevision: number; sequenceId: string; trackId: string; startTick: number; durationTick: number; name: string; sourceMediaId: string; provider: "openai" | "elevenlabs"; model?: string; language?: string; parameters?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.queueGeneratedArtifact({ ...input, kind: "captions", request: { provider: input.provider, sourceMediaId: input.sourceMediaId, ...(input.model ? { model: input.model } : {}), ...(input.language ? { language: input.language } : {}), ...(input.parameters ? { parameters: input.parameters } : {}) } });
  }

  async generateAnimation(input: { projectPath: string; expectedRevision: number; sequenceId: string; trackId: string; clipId?: string; startTick: number; durationTick: number; name: string; prompt: string; model?: string; seed?: number; parameters?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    return this.queueGeneratedArtifact({ ...input, kind: "animation", request: { provider: "language", prompt: input.prompt, ...(input.model ? { model: input.model } : {}), ...(input.seed !== undefined ? { seed: input.seed } : {}), ...(input.parameters ? { parameters: input.parameters } : {}) } });
  }

  async regenerateGeneratedArtifact(input: { projectPath: string; expectedRevision: number; artifactId: string; requestPatch?: Partial<GenerationRequest> }): Promise<Record<string, unknown>> {
    const project = await this.store(input.projectPath).read();
    const artifact = project.generatedArtifacts.find((item) => item.id === input.artifactId);
    if (!artifact) throw new StudioException("GENERATION_NOT_FOUND", `Generated artifact not found: ${input.artifactId}`, "input");
    const parent = artifact.versions.find((item) => item.id === artifact.activeVersionId) ?? artifact.versions.at(-1);
    if (!parent) throw new StudioException("GENERATION_VERSION_NOT_FOUND", "The generated artifact has no version to regenerate.", "input");
    const request = { ...structuredClone(parent.request), ...structuredClone(input.requestPatch ?? {}) };
    return this.queueGeneratedArtifact({ projectPath: input.projectPath, expectedRevision: input.expectedRevision, artifactId: artifact.id, parentVersionId: parent.id, kind: artifact.kind, name: artifact.name, sequenceId: artifact.scope.sequenceId, startTick: artifact.scope.startTick, durationTick: artifact.scope.durationTick, ...(artifact.scope.trackId ? { trackId: artifact.scope.trackId } : {}), ...(artifact.scope.clipId ? { clipId: artifact.scope.clipId } : {}), request });
  }

  async reviewGeneratedVersion(input: { projectPath: string; expectedRevision: number; artifactId: string; versionId: string; action: "activate" | "approve" | "reject"; reviewer: string; note?: string }): Promise<Record<string, unknown>> {
    const commands: ProjectCommand[] = [];
    if (input.action === "activate" || input.action === "approve") commands.push({ type: "generation.version.activate", artifactId: input.artifactId, versionId: input.versionId });
    if (input.action === "approve" || input.action === "reject") commands.push({ type: "generation.version.update", artifactId: input.artifactId, versionId: input.versionId, patch: { status: input.action === "approve" ? "approved" : "rejected", review: { reviewer: input.reviewer, reviewedAt: new Date().toISOString(), ...(input.note ? { note: input.note } : {}) } } });
    return this.apply(input.projectPath, input.expectedRevision, commands);
  }

  async createMediaArtifacts(projectPath: string, mediaIds?: string[]): Promise<Record<string, unknown>> {
    const store = this.store(projectPath);
    const project = await store.read();
    const selected = project.media.filter((media) => !mediaIds || mediaIds.includes(media.id));
    const jobs = [];
    for (const media of selected) {
      if (media.probe.hasVideo) {
        jobs.push(await this.jobs.enqueue("proxy", `Creating proxy for ${media.name}`, ({ signal, progress }) => createProxy(store, media, this.config, signal, (value) => void progress(value, "Creating proxy"))));
        jobs.push(await this.jobs.enqueue("thumbnail", `Creating thumbnail for ${media.name}`, ({ signal }) => createThumbnail(store, media, this.config, 0, signal)));
      }
      if (media.probe.hasAudio) jobs.push(await this.jobs.enqueue("waveform", `Creating waveform for ${media.name}`, ({ signal }) => createWaveform(store, media, this.config, signal)));
    }
    return { success: true, jobs };
  }

  async extractFrames(projectPath: string, mediaId: string, timesTick: number[]): Promise<Record<string, unknown>> {
    const store = this.store(projectPath);
    const project = await store.read();
    const media = project.media.find((candidate) => candidate.id === mediaId);
    if (!media) throw new StudioException("MEDIA_NOT_FOUND", `Media not found: ${mediaId}`, "input");
    const job = await this.jobs.enqueue("thumbnail", `Extracting ${timesTick.length} frames from ${media.name}`, async ({ signal, progress }) => {
      const frames: Record<string, unknown>[] = [];
      for (let index = 0; index < timesTick.length; index += 1) {
        frames.push(await createThumbnail(store, media, this.config, timesTick[index]!, signal));
        await progress((index + 1) / timesTick.length, `Extracted frame ${index + 1}/${timesTick.length}`);
      }
      return { mediaId, frames };
    });
    return { success: true, job };
  }

  async compose(input: { name: string; projectPath?: string; mediaPaths: string[]; imageDurationSeconds?: number; outputPath?: string }): Promise<Record<string, unknown>> {
    if (input.mediaPaths.length === 0) throw new StudioException("MEDIA_REQUIRED", "compose_video requires at least one media path.", "input");
    const created = await this.createProject(input.name, input.projectPath) as { projectPath: string; project: StudioProject };
    const store = this.store(created.projectPath);
    const media: MediaAsset[] = [];
    let project = created.project;
    for (const filePath of input.mediaPaths) {
      const imported = await this.import({ projectPath: store.root, filePath, storageMode: "managed", expectedRevision: project.revision }) as { project: StudioProject; asset: { media: MediaAsset } };
      project = imported.project;
      media.push(imported.asset.media);
    }
    const sequence = project.sequences.find((candidate) => candidate.id === project.activeSequenceId)!;
    const videoTrack = sequence.tracks.find((track) => track.type === "video")!;
    const audioTrack = sequence.tracks.find((track) => track.type === "audio")!;
    let visualCursor = 0;
    let audioCursor = 0;
    const commands: ProjectCommand[] = media.map((asset) => {
      const track = asset.kind === "audio" ? audioTrack : videoTrack;
      const rawDuration = asset.kind === "image" ? secondsToTicks(input.imageDurationSeconds ?? 5) : Math.max(asset.probe.durationTick, secondsToTicks(1));
      const durationTick = track.type === "audio" ? rawDuration : framesToTicks(ticksToFrames(rawDuration, project.settings.fps, "ceil"), project.settings.fps);
      const startTick = track.type === "audio" ? audioCursor : visualCursor;
      const clip = defaultClip(track.id, { type: "media", mediaId: asset.id }, asset.name, durationTick);
      clip.startTick = startTick;
      if (track.type === "audio") audioCursor += durationTick; else visualCursor += durationTick;
      return { type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" };
    });
    const edited = await this.apply(store.root, project.revision, commands) as { project: StudioProject };
    const render = input.outputPath ? await this.render({ projectPath: store.root, sequenceId: sequence.id, presetId: edited.project.exportPresets[0]!.id, outputPath: input.outputPath }) : undefined;
    return { success: true, projectPath: store.root, project: edited.project, ...(render ? { render } : {}) };
  }

  async setAnimation(projectPath: string, expectedRevision: number, animation: AnimationDocument): Promise<Record<string, unknown>> {
    return this.apply(projectPath, expectedRevision, [{ type: "animation.set", animation }]);
  }

  async getAnimation(projectPath: string, animationId: string): Promise<Record<string, unknown>> {
    const project = await this.store(projectPath).read();
    const animation = project.animations.find((candidate) => candidate.id === animationId);
    if (!animation) throw new StudioException("ANIMATION_NOT_FOUND", `Animation not found: ${animationId}`, "input");
    return { success: true, projectId: project.projectId, revision: project.revision, animation };
  }

  async validateAnimation(projectPath: string, animation: AnimationDocument): Promise<Record<string, unknown>> {
    const project = structuredClone(await this.store(projectPath).read());
    const index = project.animations.findIndex((candidate) => candidate.id === animation.id);
    if (index >= 0) project.animations[index] = animation; else project.animations.push(animation);
    validateProject(project);
    return { success: true, valid: true, animationId: animation.id };
  }

  async createAnimationClip(input: { projectPath: string; expectedRevision: number; sequenceId: string; trackId: string; startTick: number; animation: AnimationDocument; mode?: "overwrite" | "insert" | "ripple" | "replace" }): Promise<Record<string, unknown>> {
    const clip = defaultClip(input.trackId, { type: "animation", animationId: input.animation.id }, input.animation.name, input.animation.durationTick);
    clip.startTick = input.startTick;
    return this.apply(input.projectPath, input.expectedRevision, [
      { type: "animation.set", animation: input.animation },
      { type: "clip.add", sequenceId: input.sequenceId, clip, mode: input.mode ?? "overwrite" }
    ]);
  }

  async addTitle(input: { projectPath: string; expectedRevision: number; sequenceId: string; trackId: string; text: string; startTick: number; durationTick: number; fontSize?: number; color?: string }): Promise<Record<string, unknown>> {
    const project = await this.store(input.projectPath).read();
    const nodeId = randomUUID();
    const animation: AnimationDocument = {
      id: randomUUID(), name: input.text.slice(0, 80) || "Title", durationTick: input.durationTick,
      canvas: { ...project.settings.raster, background: "transparent" }, seed: 1, mode: "declarative",
      nodes: [{ id: nodeId, type: "text", name: input.text, properties: { text: input.text, fontSize: input.fontSize ?? 96, fontWeight: 700, fill: input.color ?? "#ffffff" }, transform: { ...defaultTransform(), position: [project.settings.raster.width / 2, project.settings.raster.height / 2] } }],
      operations: [
        { id: randomUUID(), type: "write", targetId: nodeId, startTick: 0, durationTick: Math.min(input.durationTick, secondsToTicks(0.8)), easing: "easeOut", parameters: {} },
        { id: randomUUID(), type: "fade", targetId: nodeId, startTick: Math.max(0, input.durationTick - secondsToTicks(0.5)), durationTick: Math.min(input.durationTick, secondsToTicks(0.5)), easing: "easeIn", parameters: { from: 1, to: 0 } }
      ]
    };
    return this.createAnimationClip({ ...input, animation });
  }

  async renderAnimationPreview(input: { projectPath: string; animationId: string; outputPath: string }): Promise<Record<string, unknown>> {
    const project = await this.store(input.projectPath).read();
    const animation = project.animations.find((candidate) => candidate.id === input.animationId);
    if (!animation) throw new StudioException("ANIMATION_NOT_FOUND", `Animation not found: ${input.animationId}`, "input");
    const job = await this.jobs.enqueue("animation", `Rendering ${animation.name}`, ({ signal, progress }) => renderAnimation(animation, this.config, { outputPath: path.resolve(input.outputPath), fps: project.settings.fps, signal, onProgress: (value) => void progress(value, "Rendering animation") }));
    return { success: true, job };
  }

  async render(input: { projectPath: string; sequenceId: string; presetId: string; outputPath: string }): Promise<Record<string, unknown>> {
    const store = this.store(input.projectPath);
    const job = await this.jobs.enqueue("render", "Waiting to render", ({ signal, progress }) => renderSequence(store, this.config, {
      sequenceId: input.sequenceId,
      presetId: input.presetId,
      outputPath: path.resolve(input.outputPath),
      signal,
      onProgress: (value, message) => void progress(value, message)
    }));
    return { success: true, job };
  }

  async renderPreview(input: { projectPath: string; sequenceId: string }): Promise<Record<string, unknown>> {
    const store = this.store(input.projectPath);
    const project = await store.read();
    const sequence = project.sequences.find((candidate) => candidate.id === input.sequenceId);
    if (!sequence) throw new StudioException("SEQUENCE_NOT_FOUND", `Sequence not found: ${input.sequenceId}`, "input");
    if (sequence.clips.length === 0 && sequence.captions.length === 0) throw new StudioException("EMPTY_SEQUENCE", "Add a clip or caption before building a program preview.", "input");
    const preset = project.exportPresets.find((candidate) => candidate.videoCodec === "libx264") ?? project.exportPresets[0];
    if (!preset) throw new StudioException("PRESET_NOT_FOUND", "The project has no video export preset.", "input");
    const revision = project.revision;
    const outputPath = path.join(store.root, "cache", "previews", `${sequence.id}-r${revision}.mp4`);
    const cached = await stat(outputPath).then((info) => info.isFile() && info.size > 0).catch(() => false);
    if (cached) return { success: true, cached: true, projectId: project.projectId, sequenceId: sequence.id, revision };
    const job = await this.jobs.enqueue("preview", `Building program preview for ${sequence.name}`, ({ signal, progress }) => renderSequence(store, this.config, {
      sequenceId: sequence.id,
      presetId: preset.id,
      outputPath,
      expectedRevision: revision,
      maxWidth: 960,
      crf: 25,
      encoderPreset: "superfast",
      signal,
      onProgress: (value, message) => void progress(value, message)
    }));
    return { success: true, cached: false, revision, job };
  }

  async qc(input: { projectPath: string; sequenceId: string; filePath: string }): Promise<Record<string, unknown>> {
    const store = this.store(input.projectPath);
    const job = await this.jobs.enqueue("qc", "Waiting for quality control", async ({ signal, progress }) => {
      await progress(0.05, "Decoding and measuring output");
      const result = await runQc(store, input.sequenceId, input.filePath, this.config, signal);
      await progress(1); return result;
    });
    return { success: true, job };
  }
}
