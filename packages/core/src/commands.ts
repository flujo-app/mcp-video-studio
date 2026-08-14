import { randomUUID } from "node:crypto";
import type { Clip, ProjectCommand, ProjectDelta, Sequence, StudioProject, Track } from "@mcp-video-studio/contracts";
import { rational } from "@mcp-video-studio/contracts";
import { StudioException } from "./errors.js";

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

function rippleAfter(sequence: Sequence, tick: number, amount: number, excluded: Set<string>, trackIds?: Set<string>): void {
  if (amount === 0) return;
  const unlocked = new Set(sequence.tracks.filter((track) => !track.locked && (!trackIds || trackIds.has(track.id))).map((track) => track.id));
  for (const clip of sequence.clips) {
    if (!excluded.has(clip.id) && unlocked.has(clip.trackId) && clip.startTick >= tick) clip.startTick += amount;
  }
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
    if (command.type === "project.rename") {
      next.name = command.name.trim();
      if (!next.name) throw new StudioException("INVALID_NAME", "Project name cannot be empty.", "input");
      continue;
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
      const prior = artifact.activeVersionId ? artifact.versions.find((item) => item.id === artifact.activeVersionId) : undefined;
      if (version.output.mediaId || version.output.animationId) {
        if (!artifact.scope.clipId) throw new StudioException("GENERATION_CLIP_MISSING", "This generated artifact is not bound to a timeline clip.", "input");
        const clip = clipById(sequence, artifact.scope.clipId);
        assertUnlocked(sequence, clip.trackId);
        if (version.output.mediaId) {
          if (!next.media.some((item) => item.id === version.output!.mediaId)) throw new StudioException("MISSING_MEDIA", `Generated media not found: ${version.output.mediaId}`, "input");
          clip.source = { type: "media", mediaId: version.output.mediaId };
        } else if (version.output.animationId) {
          if (!next.animations.some((item) => item.id === version.output!.animationId)) throw new StudioException("MISSING_ANIMATION", `Generated animation not found: ${version.output.animationId}`, "input");
          clip.source = { type: "animation", animationId: version.output.animationId };
        }
        addUnique(changed.clips, clip.id);
      }
      if (version.output.captions) {
        const priorIds = new Set(prior?.output?.captions?.map((caption) => caption.id) ?? []);
        sequence.captions = sequence.captions.filter((caption) => !priorIds.has(caption.id));
        const existing = new Set(sequence.captions.map((caption) => caption.id));
        for (const caption of version.output.captions) {
          if (existing.has(caption.id)) throw new StudioException("DUPLICATE_ID", `Caption id already exists: ${caption.id}`, "input");
          sequence.captions.push(structuredClone(caption));
        }
        addUnique(changed.sequences, sequence.id);
      }
      artifact.activeVersionId = version.id;
      addUnique(changed.generatedArtifacts, artifact.id);
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
      if (command.mode === "insert") rippleAfter(sequence, clip.startTick, clip.durationTick, new Set(), new Set([clip.trackId]));
      else if (command.mode === "ripple") rippleAfter(sequence, clip.startTick, clip.durationTick, new Set());
      else overwriteRange(sequence, clip).forEach((id) => addUnique(changed.clips, id));
      sequence.clips.push(clip);
      addUnique(changed.clips, clip.id);
    } else if (command.type === "clip.move") {
      const selected = command.clipIds.map((id) => clipById(sequence, id));
      assertUnlocked(sequence, command.targetTrackId);
      selected.forEach((clip) => assertUnlocked(sequence, clip.trackId));
      const base = Math.min(...selected.map((clip) => clip.startTick));
      const deltaTick = command.startTick - base;
      if (command.ripple) rippleAfter(sequence, base, -Math.max(...selected.map((clip) => clip.durationTick)), new Set(command.clipIds));
      for (const clip of selected) {
        clip.startTick += deltaTick;
        clip.trackId = command.targetTrackId;
        if (clip.startTick < 0) throw new StudioException("NEGATIVE_TIME", "A moved clip would start before zero.", "input");
        addUnique(changed.clips, clip.id);
      }
    } else if (command.type === "clip.trim") {
      const clip = clipById(sequence, command.clipId);
      assertUnlocked(sequence, clip.trackId);
      const oldEnd = end(clip);
      if (command.edge === "in") {
        if (command.tick < 0 || command.tick >= oldEnd) throw new StudioException("INVALID_TRIM", "Trim-in must be before the clip end.", "input");
        const amount = command.tick - clip.startTick;
        clip.startTick = command.tick;
        clip.durationTick -= amount;
        clip.sourceInTick += sourceAdvance(clip, amount);
      } else {
        if (command.tick <= clip.startTick) throw new StudioException("INVALID_TRIM", "Trim-out must be after the clip start.", "input");
        const oldDuration = clip.durationTick;
        clip.durationTick = command.tick - clip.startTick;
        if (command.ripple) rippleAfter(sequence, oldEnd, clip.durationTick - oldDuration, new Set([clip.id]));
      }
      addUnique(changed.clips, clip.id);
    } else if (command.type === "clip.split") {
      const clip = clipById(sequence, command.clipId);
      assertUnlocked(sequence, clip.trackId);
      if (command.atTick <= clip.startTick || command.atTick >= end(clip)) throw new StudioException("INVALID_SPLIT", "Split point must be inside the clip.", "input");
      const leftDuration = command.atTick - clip.startTick;
      const right: Clip = structuredClone(clip);
      right.id = command.rightClipId;
      right.startTick = command.atTick;
      right.durationTick = clip.durationTick - leftDuration;
      right.sourceInTick += sourceAdvance(clip, leftDuration);
      clip.durationTick = leftDuration;
      sequence.clips.push(right);
      addUnique(changed.clips, clip.id);
      addUnique(changed.clips, right.id);
    } else if (command.type === "clip.remove") {
      const selected = command.clipIds.map((id) => clipById(sequence, id));
      selected.forEach((clip) => assertUnlocked(sequence, clip.trackId));
      sequence.clips = sequence.clips.filter((clip) => !command.clipIds.includes(clip.id));
      sequence.transitions = sequence.transitions.filter((transition) => !command.clipIds.includes(transition.fromClipId) && !command.clipIds.includes(transition.toClipId));
      if (command.ripple && selected.length > 0) {
        const start = Math.min(...selected.map((clip) => clip.startTick));
        const finish = Math.max(...selected.map(end));
        rippleAfter(sequence, finish, start - finish, new Set());
      }
      command.clipIds.forEach((id) => addUnique(changed.clips, id));
    } else if (command.type === "clip.update") {
      const clip = clipById(sequence, command.clipId);
      assertUnlocked(sequence, clip.trackId);
      Object.assign(clip, structuredClone(command.patch));
      if (command.patch.playbackRate) clip.playbackRate = rational(command.patch.playbackRate.numerator, command.patch.playbackRate.denominator);
      addUnique(changed.clips, clip.id);
    } else if (command.type === "transition.add") {
      if (sequence.transitions.some((item) => item.id === command.transition.id)) throw new StudioException("DUPLICATE_ID", `Transition id already exists: ${command.transition.id}`, "input");
      clipById(sequence, command.transition.fromClipId);
      clipById(sequence, command.transition.toClipId);
      sequence.transitions.push(structuredClone(command.transition));
    } else if (command.type === "transition.update") {
      const transition = sequence.transitions.find((item) => item.id === command.transitionId);
      if (!transition) throw new StudioException("TRANSITION_NOT_FOUND", `Transition not found: ${command.transitionId}`, "input");
      Object.assign(transition, structuredClone(command.patch));
    } else if (command.type === "transition.remove") {
      sequence.transitions = sequence.transitions.filter((transition) => transition.id !== command.transitionId);
    } else if (command.type === "automation.set") {
      const index = sequence.automation.findIndex((lane) => lane.id === command.lane.id);
      if (index >= 0) sequence.automation[index] = structuredClone(command.lane);
      else sequence.automation.push(structuredClone(command.lane));
    } else if (command.type === "automation.remove") {
      sequence.automation = sequence.automation.filter((lane) => lane.id !== command.laneId);
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
  return { project: next, changed, warnings };
}
