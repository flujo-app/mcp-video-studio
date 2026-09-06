import { activateGenerated } from "./generation.js";
import { randomUUID } from "node:crypto";
import type { Clip, ProjectCommand, ProjectDelta, Sequence, StudioProject, Track } from "@mcp-video-studio/contracts";
import { rational } from "@mcp-video-studio/contracts";
import { rippleTimeline, shiftClipAutomation, splitClipAt, cleanupClipReferences } from "./timeline.js";
import { StudioException } from "./errors.js";
import { isAdvancedCommand, expandAdvancedCommand, relatedClipIds } from "./advanced.js";

function sequenceById(project: StudioProject, id: string): Sequence {
  const sequence = project.sequences.find((candidate) => candidate.id === id);
  if (!sequence) throw new StudioException("SEQUENCE_NOT_FOUND", `Sequence not found: ${id}`, "input");
  return sequence;
}

function trackById(sequence: Sequence, id: string): Track {
  const track = sequence.tracks.find((candidate) => candidate.id === id);
  if (!track) throw new StudioException("TRACK_NOT_FOUND", `Track not found: ${id}`, "input");
  return track;
}

function clipById(sequence: Sequence, id: string): Clip {
  const clip = sequence.clips.find((candidate) => candidate.id === id);
  if (!clip) throw new StudioException("CLIP_NOT_FOUND", `Clip not found: ${id}`, "input");
  return clip;
}

function end(clip: Clip): number {
  return clip.startTick + clip.durationTick;
}

function sourceAdvance(clip: Clip, timelineTicks: number): number {
  return Math.round(timelineTicks * clip.playbackRate.numerator / clip.playbackRate.denominator);
}

function assertUnlocked(sequence: Sequence, trackId: string): Track {
  const track = trackById(sequence, trackId);
  if (track.locked) throw new StudioException("TRACK_LOCKED", `Track ${track.name} is locked.`, "input", { trackId });
  return track;
}

function delta(): ProjectDelta {
  return { sequences: [], tracks: [], clips: [], media: [], animations: [], generatedArtifacts: [] };
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}


function overwriteRange(sequence: Sequence, incoming: Clip): string[] {
  const removed: string[] = [];
  const start = incoming.startTick;
  const finish = end(incoming);
  const replacements: Clip[] = [];
  for (const existing of sequence.clips) {
    if (existing.trackId !== incoming.trackId || existing.id === incoming.id || end(existing) <= start || existing.startTick >= finish) continue;
    const existingEnd = end(existing);
    if (existing.startTick < start && existingEnd > finish) {
      const right: Clip = structuredClone(existing);
      right.id = randomUUID();
      right.startTick = finish;
      right.durationTick = existingEnd - finish;
      right.sourceInTick += sourceAdvance(existing, finish - existing.startTick);
      existing.durationTick = start - existing.startTick;
      replacements.push(right);
    } else if (existing.startTick < start) {
      existing.durationTick = start - existing.startTick;
    } else if (existingEnd > finish) {
      const advance = finish - existing.startTick;
      existing.startTick = finish;
      existing.durationTick = existingEnd - finish;
      existing.sourceInTick += sourceAdvance(existing, advance);
    } else {
      removed.push(existing.id);
    }
  }
  cleanupClipReferences(sequence,new Set(removed));
  sequence.clips = sequence.clips.filter((clip) => !removed.includes(clip.id));
  sequence.clips.push(...replacements);
  return removed;
}

function sortSequence(sequence: Sequence): void {
  sequence.tracks.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  sequence.clips.sort((a, b) => a.startTick - b.startTick || a.trackId.localeCompare(b.trackId) || a.id.localeCompare(b.id));
  sequence.automation.forEach((lane) => lane.points.sort((a, b) => a.tick - b.tick));
  sequence.captions.sort((a, b) => a.startTick - b.startTick || a.id.localeCompare(b.id));
}

export function applyProjectCommands(project: StudioProject, commands: ProjectCommand[]): { project: StudioProject; changed: ProjectDelta; warnings: string[] } {
  const next = structuredClone(project);
  const changed = delta();
  const warnings: string[] = [];

  for (const command of commands) {
    if (isAdvancedCommand(command)) {
      const applied = applyProjectCommands(next, expandAdvancedCommand(next, command));
      Object.assign(next, applied.project);
      for (const key of Object.keys(changed) as Array<keyof ProjectDelta>) for (const id of applied.changed[key]) addUnique(changed[key], id);
      warnings.push(...applied.warnings);
      continue;
    }
    if (command.type === "project.rename") {
      next.name = command.name.trim();
      if (!next.name) throw new StudioException("INVALID_NAME", "Project name cannot be empty.", "input");
      continue;
    }
    if(command.type==="sequence.add"){
      if(next.sequences.some(sequence=>sequence.id===command.sequence.id))throw new StudioException("DUPLICATE_ID","Sequence ID already exists.","input");
      next.sequences.push(structuredClone(command.sequence));addUnique(changed.sequences,command.sequence.id);for(const track of command.sequence.tracks)addUnique(changed.tracks,track.id);continue;
    }
    if(command.type==="sequence.activate"){sequenceById(next,command.sequenceId);next.activeSequenceId=command.sequenceId;addUnique(changed.sequences,command.sequenceId);continue;}
    if(command.type==="sequence.rename"){const sequence=sequenceById(next,command.sequenceId);if(!command.name.trim())throw new StudioException("INVALID_NAME","Sequence name cannot be empty.","input");sequence.name=command.name.trim();addUnique(changed.sequences,sequence.id);continue;}
    if(command.type==="sequence.remove"){
      const sequence=sequenceById(next,command.sequenceId);
      if(next.sequences.length===1||next.sequences.some(owner=>owner.clips.some(clip=>clip.source.type==="sequence"&&clip.source.sequenceId===sequence.id))||next.generatedArtifacts.some(artifact=>artifact.scope.sequenceId===sequence.id))throw new StudioException("SEQUENCE_IN_USE","Keep at least one sequence and remove nested/generated references before deleting a sequence.","input");
      next.sequences=next.sequences.filter(item=>item.id!==sequence.id);if(next.activeSequenceId===sequence.id)next.activeSequenceId=next.sequences[0]!.id;addUnique(changed.sequences,sequence.id);continue;
    }
    if (command.type === "animation.set") {
      const index = next.animations.findIndex((item) => item.id === command.animation.id);
      if (index >= 0) next.animations[index] = structuredClone(command.animation);
      else next.animations.push(structuredClone(command.animation));
      addUnique(changed.animations, command.animation.id);
      continue;
    }
    if (command.type === "generation.create") {
      if (next.generatedArtifacts.some((item) => item.id === command.artifact.id)) throw new StudioException("DUPLICATE_ID", `Generated artifact id already exists: ${command.artifact.id}`, "input");
      next.generatedArtifacts.push(structuredClone(command.artifact));
      addUnique(changed.generatedArtifacts, command.artifact.id);
      continue;
    }
    if (command.type === "generation.version.add") {
      const artifact = next.generatedArtifacts.find((item) => item.id === command.artifactId);
      if (!artifact) throw new StudioException("GENERATION_NOT_FOUND", `Generated artifact not found: ${command.artifactId}`, "input");
      if (artifact.versions.some((item) => item.id === command.version.id)) throw new StudioException("DUPLICATE_ID", `Generated version id already exists: ${command.version.id}`, "input");
      artifact.versions.push(structuredClone(command.version));
      addUnique(changed.generatedArtifacts, artifact.id);
      continue;
    }
    if (command.type === "generation.version.update") {
      const artifact = next.generatedArtifacts.find((item) => item.id === command.artifactId);
      if (!artifact) throw new StudioException("GENERATION_NOT_FOUND", `Generated artifact not found: ${command.artifactId}`, "input");
      const version = artifact.versions.find((item) => item.id === command.versionId);
      if (!version) throw new StudioException("GENERATION_VERSION_NOT_FOUND", `Generated version not found: ${command.versionId}`, "input");
      Object.assign(version, structuredClone(command.patch));
      if (command.patch.status === "approved") artifact.approvedVersionId = version.id;
      addUnique(changed.generatedArtifacts, artifact.id);
      continue;
    }
    if (command.type === "generation.version.activate") {
      const artifact = next.generatedArtifacts.find((item) => item.id === command.artifactId);
      if (!artifact) throw new StudioException("GENERATION_NOT_FOUND", `Generated artifact not found: ${command.artifactId}`, "input");
      const version = artifact.versions.find((item) => item.id === command.versionId);
      if (!version) throw new StudioException("GENERATION_VERSION_NOT_FOUND", `Generated version not found: ${command.versionId}`, "input");
      if (!version.output) throw new StudioException("GENERATION_OUTPUT_MISSING", `Generated version ${command.versionId} has no output.`, "input");
      const sequence = sequenceById(next, artifact.scope.sequenceId);
      activateGenerated(next, artifact, version, sequence, changed);
      sortSequence(sequence);
      continue;
    }

    const sequence = sequenceById(next, command.sequenceId);
    addUnique(changed.sequences, sequence.id);

    if (command.type === "track.add") {
      if (sequence.tracks.some((track) => track.id === command.track.id)) throw new StudioException("DUPLICATE_ID", `Track id already exists: ${command.track.id}`, "input");
      sequence.tracks.push({ ...structuredClone(command.track), sequenceId: sequence.id });
      addUnique(changed.tracks, command.track.id);
    } else if (command.type === "track.update") {
      const track = trackById(sequence, command.trackId);
      Object.assign(track, command.patch);
      addUnique(changed.tracks, track.id);
    } else if (command.type === "track.remove") {
      const track = assertUnlocked(sequence, command.trackId);
      const owned = sequence.clips.filter((clip) => clip.trackId === track.id);
      const ownedCaptions = sequence.captions.filter((caption) => caption.trackId === track.id);
      if ((owned.length > 0 || ownedCaptions.length > 0) && !command.removeClips) throw new StudioException("TRACK_NOT_EMPTY", "Remove or move the track's clips and captions first.", "input");
      sequence.clips = sequence.clips.filter((clip) => clip.trackId !== track.id);
      sequence.captions = sequence.captions.filter((caption) => caption.trackId !== track.id);
      sequence.tracks = sequence.tracks.filter((item) => item.id !== track.id);
      owned.forEach((clip) => addUnique(changed.clips, clip.id));
      addUnique(changed.tracks, track.id);
    } else if (command.type === "clip.add") {
      assertUnlocked(sequence, command.clip.trackId);
      if (sequence.clips.some((clip) => clip.id === command.clip.id)) throw new StudioException("DUPLICATE_ID", `Clip id already exists: ${command.clip.id}`, "input");
      const clip = structuredClone(command.clip);
      clip.playbackRate = rational(clip.playbackRate.numerator, clip.playbackRate.denominator);
      if (command.mode === "insert") rippleTimeline(sequence, clip.startTick, clip.durationTick, new Set(), new Set([clip.trackId]));
      else if (command.mode === "ripple") rippleTimeline(sequence, clip.startTick, clip.durationTick, new Set());
      else overwriteRange(sequence, clip).forEach((id) => addUnique(changed.clips, id));
      sequence.clips.push(clip);
      addUnique(changed.clips, clip.id);
    } else if (command.type === "clip.move") {
      const explicit = command.clipIds.map((id) => clipById(sequence, id));
      const selected = relatedClipIds(sequence, command.clipIds).map(id => clipById(sequence, id));
      assertUnlocked(sequence, command.targetTrackId);
      selected.forEach((clip) => assertUnlocked(sequence, clip.trackId));
      const base = Math.min(...explicit.map((clip) => clip.startTick));
      const sourceTrack = explicit.find(clip => clip.startTick === base)!.trackId;
      const deltaTick = command.startTick - base;
      const selectedIds = new Set(selected.map(clip => clip.id));
      if (command.ripple) {
        const finish = Math.max(...selected.map(end)), span = finish - base;
        if (command.startTick > base && command.startTick < finish) throw new StudioException("RIPPLE_BOUNDARY", "Ripple destination cannot be inside the moving selection.", "input");
        rippleTimeline(sequence, finish, -span, selectedIds);
        rippleTimeline(sequence, command.startTick, span, selectedIds);
      }
      for (const clip of selected) {
        clip.startTick += deltaTick;
        shiftClipAutomation(sequence, clip.id, deltaTick);
        if (clip.trackId === sourceTrack) clip.trackId = command.targetTrackId;
        if (clip.startTick < 0) throw new StudioException("NEGATIVE_TIME", "A moved clip would start before zero.", "input");
        addUnique(changed.clips, clip.id);
      }
    } else if (command.type === "clip.trim") {
      const anchor = clipById(sequence, command.clipId);
      const selected = relatedClipIds(sequence, [anchor.id]).map(id => clipById(sequence,id));
      const amount = command.tick - (command.edge === "in" ? anchor.startTick : end(anchor));
      const oldBoundary = command.edge === "in" ? anchor.startTick : end(anchor);
      if (selected.some(clip => (command.edge === "in" ? clip.startTick : end(clip)) !== oldBoundary)) throw new StudioException("LINKED_TRIM_BOUNDARY", "Linked or grouped edges must align for a shared trim. Split at a common boundary first.", "input");
      for (const clip of selected) {
        assertUnlocked(sequence, clip.trackId);
        if (command.edge === "in") {
          clip.sourceInTick += sourceAdvance(clip, amount); clip.durationTick -= amount;
          if (!command.ripple) clip.startTick += amount;
        } else clip.durationTick += amount;
        if (clip.startTick < 0 || clip.sourceInTick < 0 || clip.durationTick <= 0) throw new StudioException("INVALID_TRIM", "Trim exceeds the clip's available source handles.", "input");
        clip.audio.fadeInTick = Math.min(clip.audio.fadeInTick,clip.durationTick);
        clip.audio.fadeOutTick = Math.min(clip.audio.fadeOutTick,clip.durationTick-clip.audio.fadeInTick);
        addUnique(changed.clips,clip.id);
      }
      if (command.ripple) {
        if (command.edge === "in") {
          for(const clip of selected)shiftClipAutomation(sequence,clip.id,-amount);
          // Keep the trimmed source at its original timeline start; close/open its removed head.
          rippleTimeline(sequence, oldBoundary + Math.max(0,amount), -amount, new Set(selected.map(clip=>clip.id)));
        } else rippleTimeline(sequence, oldBoundary, amount, new Set(selected.map(clip=>clip.id)));
      }
    } else if (command.type === "clip.split") {
      const anchor = clipById(sequence,command.clipId);
      const selected = relatedClipIds(sequence,[anchor.id]).map(id=>clipById(sequence,id));
      const newGroups = new Map<string,string>(), newLinks = new Map<string,string>();
      const fresh = (map:Map<string,string>,id:string) => { let value=map.get(id); if(!value){value=randomUUID();map.set(id,value);} return value; };
      for (const clip of selected) {
        const right = splitClipAt(sequence,clip,command.atTick,clip.id===anchor.id?command.rightClipId:randomUUID());
        if(right.groupId)right.groupId=fresh(newGroups,right.groupId);
        if(right.linkedGroupId)right.linkedGroupId=fresh(newLinks,right.linkedGroupId);
        addUnique(changed.clips,clip.id);addUnique(changed.clips,right.id);
      }
    } else if (command.type === "clip.relate") {
      if(!Array.isArray(command.clipIds)||!command.clipIds.length)throw new StudioException("EMPTY_SELECTION","Select clips to group or link.","input");
      if(command.relationshipId!==null&&!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(command.relationshipId))throw new StudioException("INVALID_ID","Relationship ID must be a portable identifier.","input");
      for(const id of command.clipIds){
        const clip=clipById(sequence,id);assertUnlocked(sequence,clip.trackId);
        const key=command.relation==="group"?"groupId":"linkedGroupId";
        if(command.relationshipId===null)delete clip[key];else clip[key]=command.relationshipId;
        addUnique(changed.clips,id);
      }
    } else if (command.type === "clip.remove") {
      const selected = relatedClipIds(sequence, command.clipIds).map((id) => clipById(sequence, id));
      selected.forEach((clip) => assertUnlocked(sequence, clip.trackId));
      const removedIds = new Set(selected.map(clip=>clip.id));
      sequence.clips = sequence.clips.filter(clip=>!removedIds.has(clip.id));
      cleanupClipReferences(sequence,removedIds);
      if (command.ripple && selected.length > 0) {
        const start = Math.min(...selected.map((clip) => clip.startTick));
        const finish = Math.max(...selected.map(end));
        rippleTimeline(sequence, finish, start - finish, new Set());
      }
      selected.forEach((clip) => addUnique(changed.clips, clip.id));
    } else if (command.type === "clip.update") {
      const clip = clipById(sequence, command.clipId);
      assertUnlocked(sequence, clip.trackId);
      Object.assign(clip, structuredClone(command.patch));
      if (command.patch.playbackRate) clip.playbackRate = rational(command.patch.playbackRate.numerator, command.patch.playbackRate.denominator);
      addUnique(changed.clips, clip.id);
    } else if (command.type === "transition.add") {
      if (sequence.transitions.some((item) => item.id === command.transition.id)) throw new StudioException("DUPLICATE_ID", `Transition id already exists: ${command.transition.id}`, "input");
      assertUnlocked(sequence,clipById(sequence, command.transition.fromClipId).trackId);
      assertUnlocked(sequence,clipById(sequence, command.transition.toClipId).trackId);
      sequence.transitions.push(structuredClone(command.transition));
    } else if (command.type === "transition.update") {
      const transition = sequence.transitions.find((item) => item.id === command.transitionId);
      if (!transition) throw new StudioException("TRANSITION_NOT_FOUND", `Transition not found: ${command.transitionId}`, "input");
      assertUnlocked(sequence,clipById(sequence,transition.fromClipId).trackId);assertUnlocked(sequence,clipById(sequence,transition.toClipId).trackId);
      Object.assign(transition, structuredClone(command.patch));
    } else if (command.type === "transition.remove") {
      sequence.transitions = sequence.transitions.filter((transition) => transition.id !== command.transitionId);
    } else if (command.type === "automation.set") {
      const index = sequence.automation.findIndex((lane) => lane.id === command.lane.id);
      if (index >= 0) sequence.automation[index] = structuredClone(command.lane);
      else sequence.automation.push(structuredClone(command.lane));
    } else if (command.type === "automation.remove") {
      sequence.automation = sequence.automation.filter((lane) => lane.id !== command.laneId);
    } else if(command.type==="qc.allowance.set"){
      const allowances=sequence.qcAllowances??[],index=allowances.findIndex(item=>item.id===command.allowance.id);
      if(index<0)allowances.push(structuredClone(command.allowance));else allowances[index]=structuredClone(command.allowance);
      sequence.qcAllowances=allowances;
    } else if(command.type==="qc.allowance.remove"){
      sequence.qcAllowances=(sequence.qcAllowances??[]).filter(item=>item.id!==command.allowanceId);
    } else if (command.type === "marker.add") {
      if (sequence.markers.some((marker) => marker.id === command.marker.id)) throw new StudioException("DUPLICATE_ID", `Marker id already exists: ${command.marker.id}`, "input");
      sequence.markers.push(structuredClone(command.marker));
    } else if (command.type === "marker.update") {
      const marker = sequence.markers.find((item) => item.id === command.markerId);
      if (!marker) throw new StudioException("MARKER_NOT_FOUND", `Marker not found: ${command.markerId}`, "input");
      Object.assign(marker, structuredClone(command.patch));
    } else if (command.type === "marker.remove") {
      sequence.markers = sequence.markers.filter((marker) => marker.id !== command.markerId);
    } else if (command.type === "caption.add") {
      if (sequence.captions.some((caption) => caption.id === command.caption.id)) throw new StudioException("DUPLICATE_ID", `Caption id already exists: ${command.caption.id}`, "input");
      const track = assertUnlocked(sequence, command.caption.trackId);
      if (track.type !== "caption") throw new StudioException("INVALID_CAPTION_TRACK", "Captions must be placed on a caption track.", "input");
      sequence.captions.push(structuredClone(command.caption));
    } else if (command.type === "caption.update") {
      const caption = sequence.captions.find((item) => item.id === command.captionId);
      if (!caption) throw new StudioException("CAPTION_NOT_FOUND", `Caption not found: ${command.captionId}`, "input");
      assertUnlocked(sequence, caption.trackId);
      if (command.patch.trackId) {
        const track = assertUnlocked(sequence, command.patch.trackId);
        if (track.type !== "caption") throw new StudioException("INVALID_CAPTION_TRACK", "Captions must be placed on a caption track.", "input");
      }
      Object.assign(caption, structuredClone(command.patch));
      for (const artifact of next.generatedArtifacts.filter((item) => item.scope.sequenceId === sequence.id && item.activeVersionId)) {
        const active = artifact.versions.find((item) => item.id === artifact.activeVersionId);
        const generatedCaption = active?.output?.captions?.find((item) => item.id === command.captionId);
        if (generatedCaption) {
          Object.assign(generatedCaption, structuredClone(command.patch));
          addUnique(changed.generatedArtifacts, artifact.id);
        }
      }
    } else if (command.type === "caption.remove") {
      for (const captionId of command.captionIds) {
        const caption = sequence.captions.find((item) => item.id === captionId);
        if (!caption) throw new StudioException("CAPTION_NOT_FOUND", `Caption not found: ${captionId}`, "input");
        assertUnlocked(sequence, caption.trackId);
      }
      sequence.captions = sequence.captions.filter((caption) => !command.captionIds.includes(caption.id));
      for (const artifact of next.generatedArtifacts.filter((item) => item.scope.sequenceId === sequence.id && item.activeVersionId)) {
        const active = artifact.versions.find((item) => item.id === artifact.activeVersionId);
        if (active?.output?.captions?.some((caption) => command.captionIds.includes(caption.id))) {
          active.output.captions = active.output.captions.filter((caption) => !command.captionIds.includes(caption.id));
          addUnique(changed.generatedArtifacts, artifact.id);
        }
      }
    } else {
      throw new StudioException("UNKNOWN_COMMAND", `Unknown project command: ${(command as { type?: unknown }).type ?? "missing type"}`, "input");
    }
    sortSequence(sequence);
  }
  for (const artifact of next.generatedArtifacts) {
    const sequence = next.sequences.find(item=>item.id===artifact.scope.sequenceId);
    if(artifact.scope.trackId&&!sequence?.tracks.some(track=>track.id===artifact.scope.trackId))delete artifact.scope.trackId;
    if(artifact.clipBindings){
      artifact.clipBindings=artifact.clipBindings.filter(binding=>sequence?.clips.some(clip=>clip.id===binding.clipId));
      if(artifact.clipBindings.length){artifact.scope.clipId=artifact.clipBindings[0]!.clipId;}
      else {delete artifact.clipBindings;delete artifact.scope.clipId;delete artifact.activeVersionId;}
      continue;
    }
    if (artifact.scope.clipId) {
      const clip=sequence?.clips.find(item=>item.id===artifact.scope.clipId);
      if (clip) { artifact.scope.startTick=clip.startTick;artifact.scope.durationTick=clip.durationTick;artifact.scope.trackId=clip.trackId; }
      else if(artifact.activeVersionId) { delete artifact.scope.clipId;delete artifact.activeVersionId; }
    }
  }
  return { project: next, changed, warnings };
}
