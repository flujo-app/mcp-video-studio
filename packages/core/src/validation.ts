import { StudioProjectSchema, ticksPerFrame, type Clip, type Sequence, type StudioProject } from "@mcp-video-studio/contracts";
import { StudioException } from "./errors.js";

function clipEnd(clip: Clip): number {
  return clip.startTick + clip.durationTick;
}

export function sequenceDuration(sequence: Sequence): number {
  const clipDuration = sequence.clips.reduce((duration, clip) => clip.enabled ? Math.max(duration, clipEnd(clip)) : duration, 0);
  return sequence.captions.reduce((duration, caption) => Math.max(duration, caption.startTick + caption.durationTick), clipDuration);
}

export function validateProject(project: StudioProject): StudioProject {
  const parsed = StudioProjectSchema.safeParse(project);
  if (!parsed.success) {
    throw new StudioException("INVALID_PROJECT", "Project validation failed.", "input", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
    });
  }

  const mediaIds = new Set(project.media.map((media) => media.id));
  const sequenceIds = new Set(project.sequences.map((sequence) => sequence.id));
  const animationIds = new Set(project.animations.map((animation) => animation.id));
  const frameTick = ticksPerFrame(project.settings.fps);

  const normalized = parsed.data as StudioProject;
  for (const sequence of normalized.sequences) {
    const clips = new Map(sequence.clips.map((clip) => [clip.id, clip]));
    for (const clip of sequence.clips) {
      const track = sequence.tracks.find((item) => item.id === clip.trackId);
      if (!track) continue;
      if ((track.type === "video" || track.type === "overlay" || track.type === "caption") && (clip.startTick % frameTick !== 0 || clip.durationTick % frameTick !== 0)) {
        throw new StudioException("VIDEO_GRID_MISMATCH", `Clip ${clip.id} is not aligned to the project frame grid.`, "input", { clipId: clip.id, frameTick });
      }
      if (clip.source.type === "media" && !mediaIds.has(clip.source.mediaId)) throw new StudioException("MISSING_MEDIA", `Clip ${clip.id} references unknown media ${clip.source.mediaId}.`, "input");
      if (clip.source.type === "animation" && !animationIds.has(clip.source.animationId)) throw new StudioException("MISSING_ANIMATION", `Clip ${clip.id} references unknown animation ${clip.source.animationId}.`, "input");
      if (clip.source.type === "sequence" && (!sequenceIds.has(clip.source.sequenceId) || clip.source.sequenceId === sequence.id)) throw new StudioException("INVALID_NESTED_SEQUENCE", `Clip ${clip.id} has an invalid nested sequence.`, "input");
    }
    for (const transition of sequence.transitions) {
      const from = clips.get(transition.fromClipId);
      const to = clips.get(transition.toClipId);
      if (!from || !to) throw new StudioException("INVALID_TRANSITION", `Transition ${transition.id} references a missing clip.`, "input");
      if (transition.durationTick > Math.min(from.durationTick, to.durationTick)) throw new StudioException("INVALID_TRANSITION", `Transition ${transition.id} exceeds a clip handle.`, "input");
    }
    for (const caption of sequence.captions) {
      const track = sequence.tracks.find((item) => item.id === caption.trackId);
      if (!track || track.type !== "caption") throw new StudioException("INVALID_CAPTION_TRACK", `Caption ${caption.id} must reference a caption track.`, "input");
      if (caption.startTick % frameTick !== 0 || caption.durationTick % frameTick !== 0) throw new StudioException("CAPTION_GRID_MISMATCH", `Caption ${caption.id} is not aligned to the project frame grid.`, "input", { captionId: caption.id, frameTick });
    }
  }
  for (const artifact of normalized.generatedArtifacts) {
    const sequence = normalized.sequences.find((item) => item.id === artifact.scope.sequenceId);
    if (!sequence) throw new StudioException("GENERATION_SEQUENCE_MISSING", `Generated artifact ${artifact.id} references an unknown sequence.`, "input");
    if (artifact.scope.trackId && !sequence.tracks.some((item) => item.id === artifact.scope.trackId)) throw new StudioException("GENERATION_TRACK_MISSING", `Generated artifact ${artifact.id} references an unknown track.`, "input");
    if (artifact.activeVersionId && artifact.scope.clipId && !sequence.clips.some((item) => item.id === artifact.scope.clipId)) throw new StudioException("GENERATION_CLIP_MISSING", `Active generated artifact ${artifact.id} references an unknown clip.`, "input");
    for (const version of artifact.versions) {
      if (version.output?.mediaId && !mediaIds.has(version.output.mediaId)) throw new StudioException("MISSING_MEDIA", `Generated version ${version.id} references unknown media ${version.output.mediaId}.`, "input");
      if (version.output?.animationId && !animationIds.has(version.output.animationId)) throw new StudioException("MISSING_ANIMATION", `Generated version ${version.id} references unknown animation ${version.output.animationId}.`, "input");
      for (const caption of version.output?.captions ?? []) {
        if (!sequence.tracks.some((track) => track.id === caption.trackId && track.type === "caption")) throw new StudioException("INVALID_CAPTION_TRACK", `Generated caption ${caption.id} must reference a caption track.`, "input");
      }
    }
  }
  return normalized;
}

export function projectSummary(project: StudioProject) {
  return {
    projectId: project.projectId,
    revision: project.revision,
    name: project.name,
    activeSequenceId: project.activeSequenceId,
    settings: project.settings,
    mediaCount: project.media.length,
    animationCount: project.animations.length,
    generatedArtifactCount: project.generatedArtifacts.length,
    sequences: project.sequences.map((sequence) => ({
      id: sequence.id,
      name: sequence.name,
      durationTick: sequenceDuration(sequence),
      trackCount: sequence.tracks.length,
      clipCount: sequence.clips.length
    }))
  };
}
