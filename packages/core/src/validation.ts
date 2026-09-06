import {MaskParametersSchema} from "@mcp-video-studio/contracts";
import {sequenceDependencies} from "./nesting.js";
import { framesToTicks, ticksToFrames, animationProblems, StudioProjectSchema, ticksPerSample, ticksPerFrame, type Clip, type Sequence, type StudioProject } from "@mcp-video-studio/contracts";
import {prepareTransitionTimeline} from "./transitions.js";
import { StudioException } from "./errors.js";

function clipEnd(clip: Clip): number {
  return clip.startTick + clip.durationTick;
}

export function sequenceDuration(sequence: Sequence): number {
  const clipDuration = sequence.clips.reduce((duration, clip) => clip.enabled ? Math.max(duration, clipEnd(clip)) : duration, 0);
  return sequence.captions.reduce((duration, caption) => Math.max(duration, caption.startTick + caption.durationTick), clipDuration);
}

export function validateProject(project: StudioProject): StudioProject {
  // Schema 1 is read-compatible. The first committed edit upgrades the on-disk format.
  if((project as unknown as {schemaVersion:number}).schemaVersion===1)project={...project,schemaVersion:2};
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
    sequenceDependencies(normalized,sequence.id,true);
    prepareTransitionTimeline(normalized,sequence);
    for(const caption of sequence.captions)if(caption.style.fontMediaId&&!normalized.media.some(media=>media.id===caption.style.fontMediaId&&media.kind==="font"))throw new StudioException("MISSING_CAPTION_FONT","Caption font must reference an imported font asset.","input");
    const clips = new Map(sequence.clips.map((clip) => [clip.id, clip]));
    for (const clip of sequence.clips) {
      for(const effect of clip.effects.filter(effect=>effect.type==="mask"))if(!MaskParametersSchema.safeParse(effect.parameters).success)throw new StudioException("INVALID_MASK","Mask requires bounded rectangle/ellipse geometry and scalar controls.","input");
      const track = sequence.tracks.find((item) => item.id === clip.trackId);
      if (!track) continue;
      if ((track.type === "video" || track.type === "overlay" || track.type === "caption") && (clip.startTick % frameTick !== 0 || clip.durationTick % frameTick !== 0)) {
        throw new StudioException("VIDEO_GRID_MISMATCH", `Clip ${clip.id} is not aligned to the project frame grid.`, "input", { clipId: clip.id, frameTick });
      }
      const rate=clip.playbackRate.numerator/clip.playbackRate.denominator;
      if(!(rate>0)||rate>100)throw new StudioException("INVALID_SPEED","Clip playback rate must be greater than zero and at most 100.","input");
      let sourceDuration:number|undefined;
      if(clip.source.type==="media"){
        const source=normalized.media.find(item=>clip.source.type==="media"&&item.id===clip.source.mediaId);
        if(source&&["font","subtitle"].includes(source.kind))throw new StudioException("NON_TIMELINE_MEDIA","Font/subtitle assets belong in caption styles or caption import, not AV clips.","input");
        if(source&&source.kind!=="image")sourceDuration=source.probe.durationTick;
      }else if(clip.source.type==="animation")sourceDuration=normalized.animations.find(item=>clip.source.type==="animation"&&item.id===clip.source.animationId)?.durationTick;
      if(clip.source.type==="sequence"){const source=normalized.sequences.find(item=>clip.source.type==="sequence"&&item.id===clip.source.sequenceId);if(source)sourceDuration=framesToTicks(ticksToFrames(sequenceDuration(source),normalized.settings.fps,"ceil"),normalized.settings.fps);}
      if(sourceDuration!==undefined&&clip.sourceInTick+Math.round(clip.durationTick*rate)>sourceDuration+ticksPerSample(normalized.settings.sampleRate))throw new StudioException("SOURCE_HANDLES","Clip trim or speed exceeds available source media.","input",{clipId:clip.id});
      if(clip.crop.left+clip.crop.right>=1||clip.crop.top+clip.crop.bottom>=1)throw new StudioException("INVALID_CROP","Crop must leave a visible positive area.","input");
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
  for (const animation of normalized.animations) {
    const problems=animationProblems(animation);if(problems.length)throw new StudioException("INVALID_ANIMATION",problems[0]!,"input",{problems});
    const nodes = new Map(animation.nodes.map(node => [node.id, node]));
    if (nodes.size !== animation.nodes.length || new Set(animation.operations.map(operation => operation.id)).size !== animation.operations.length) throw new StudioException('DUPLICATE_ID', 'Animation IDs must be unique.', 'input');
    for (const node of animation.nodes) {
      const seen = new Set([node.id]); let parentId = node.parentId;
      while (parentId) {
        if (seen.has(parentId) || !nodes.has(parentId)) throw new StudioException('INVALID_HIERARCHY', 'Animation parent references must exist and be acyclic.', 'input');
        seen.add(parentId); parentId = nodes.get(parentId)!.parentId;
      }
    }
    for (const operation of animation.operations) if (operation.type !== 'wait' && !nodes.has(operation.targetId)) throw new StudioException('INVALID_ANIMATION_TARGET', 'Animation operation target does not exist.', 'input');
  }
  for (const artifact of normalized.generatedArtifacts) {
    const sequence = normalized.sequences.find((item) => item.id === artifact.scope.sequenceId);
    if (!sequence) throw new StudioException("GENERATION_SEQUENCE_MISSING", `Generated artifact ${artifact.id} references an unknown sequence.`, "input");
    if (artifact.scope.trackId && !sequence.tracks.some((item) => item.id === artifact.scope.trackId)) throw new StudioException("GENERATION_TRACK_MISSING", `Generated artifact ${artifact.id} references an unknown track.`, "input");
    if (artifact.activeVersionId && artifact.scope.clipId && !sequence.clips.some((item) => item.id === artifact.scope.clipId)) throw new StudioException("GENERATION_CLIP_MISSING", `Active generated artifact ${artifact.id} references an unknown clip.`, "input");
    if(artifact.clipBindings){const ids=new Set<string>();for(const binding of artifact.clipBindings){if(ids.has(binding.clipId)||!sequence.clips.some(c=>c.id===binding.clipId)||binding.offsetTick+binding.durationTick>artifact.scope.durationTick)throw new StudioException("GENERATION_BINDING_INVALID","Generated clip bindings must be unique, present, and inside the artifact slot.","input");ids.add(binding.clipId);}}
    for (const version of artifact.versions) {
      if(version.region&&version.region.offsetTick+version.region.durationTick>artifact.scope.durationTick)throw new StudioException("GENERATION_REGION_INVALID","Regeneration region exceeds its artifact slot.","input");
      if(version.output?.segments){let cursor=0;for(const segment of version.output.segments){if(segment.offsetTick!==cursor||(segment.source.type==="media"?!mediaIds.has(segment.source.mediaId):!animationIds.has(segment.source.animationId)))throw new StudioException("GENERATION_SEGMENTS_INVALID","Version segments must cover the slot contiguously and reference existing sources.","input");cursor+=segment.durationTick;}if(cursor!==artifact.scope.durationTick)throw new StudioException("GENERATION_SEGMENTS_INVALID","Version segments must cover the complete slot.","input");}

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
