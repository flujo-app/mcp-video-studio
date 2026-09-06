import {isAudioAutomation,rippleAutomationPoints} from "@mcp-video-studio/contracts";
import { linkedBoundaryEdit } from "./edit-boundaries.js";
import { duckAudio } from "./audio-ducking.js";
import { audioParameterRange } from "./audio-ranges.js";
import { randomUUID } from "node:crypto";
import { defaultTransform, ticksPerSample, type AdvancedProjectCommand, type AnimationDocument, type Clip, type ProjectCommand, type Sequence, type StudioProject } from "@mcp-video-studio/contracts";
import {spliceEnvelope} from "./envelope.js";
import { StudioException } from "./errors.js";

const kinds = new Set(["clip.slip", "clip.roll", "clip.slide", "gap.remove", "audio.gain.range", "audio.parameter.range", "audio.duck", "animation.node.add", "animation.node.update", "animation.node.remove", "animation.operation.add", "animation.operation.update", "animation.operation.remove", "animation.operations.reorder"]);
export function isAdvancedCommand(command: ProjectCommand): command is AdvancedProjectCommand { return kinds.has(command.type); }
function fail(message: string): never { throw new StudioException("INVALID_EDIT", message, "input"); }
function integer(value: number): number { if (!Number.isSafeInteger(value)) fail("Edit times must be safe integer ticks."); return value; }
function finish(clip: Clip): number { return clip.startTick + clip.durationTick; }
function unlocked(sequence: Sequence, clip: Clip): void {
  const track = sequence.tracks.find(item => item.id === clip.trackId);
  if (!track || track.locked) fail("Unlock every affected track before editing.");
}
function sourceHandles(project: StudioProject, clip: Clip, sourceIn: number, duration = clip.durationTick): void {
  integer(sourceIn); integer(duration);
  if (sourceIn < 0 || duration <= 0) fail("The edit exceeds the clip's source handles.");
  let available: number | undefined;
  if (clip.source.type === "media") {
    const asset = project.media.find(item => clip.source.type === "media" && item.id === clip.source.mediaId);
    if (asset?.kind !== "image") available = asset?.probe.durationTick;
  } else if (clip.source.type === "animation") available = project.animations.find(item => clip.source.type === "animation" && item.id === clip.source.animationId)?.durationTick;
  const rate = clip.playbackRate.numerator / clip.playbackRate.denominator;
  if (!(rate > 0) || (available !== undefined && sourceIn + Math.round(duration * rate) > available)) fail("The edit exceeds the clip's source handles.");
}
export function relatedClipIds(sequence: Sequence, ids: string[]): string[] {
  const selected = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    const related = sequence.clips.filter(clip => selected.has(clip.id));
    for (const clip of sequence.clips) {
      if (!selected.has(clip.id) && related.some(item => (item.groupId && item.groupId === clip.groupId) || (item.linkedGroupId && item.linkedGroupId === clip.linkedGroupId))) {
        selected.add(clip.id); changed = true;
      }
    }
  }
  return [...selected];
}
export function expandAdvancedCommand(project: StudioProject, command: AdvancedProjectCommand): ProjectCommand[] {
  if ("animationId" in command) {
    const original = project.animations.find(item => item.id === command.animationId);
    if (!original || original.mode !== "declarative") fail("Select an existing declarative animation.");
    const animation = structuredClone(original);
    if (command.type === "animation.node.add") {
      if (animation.nodes.some(node => node.id === command.node.id)) fail("Animation node ID already exists.");
      animation.nodes.push(structuredClone(command.node));
    } else if (command.type === "animation.node.update") {
      const node = animation.nodes.find(item => item.id === command.nodeId); if (!node) fail("Animation node not found.");
      const { parentId, ...patch } = command.patch;
      Object.assign(node, structuredClone(patch));
      if (parentId === null) delete node.parentId; else if (parentId !== undefined) node.parentId = parentId;
    } else if (command.type === "animation.node.remove") {
      if (!animation.nodes.some(node => node.id === command.nodeId)) fail("Animation node not found.");
      const removed = new Set([command.nodeId]);
      let grew = true;
      while (grew) { grew = false; for (const node of animation.nodes) if (node.parentId && removed.has(node.parentId) && !removed.has(node.id)) { removed.add(node.id); grew = true; } }
      if (removed.size > 1 && !command.cascade) fail("This node has children; choose cascade to remove them.");
      animation.nodes = animation.nodes.filter(node => !removed.has(node.id));
      animation.operations = animation.operations.filter(operation => !removed.has(operation.targetId));
    } else if (command.type === "animation.operation.add") {
      if (animation.operations.some(operation => operation.id === command.operation.id)) fail("Animation operation ID already exists.");
      animation.operations.push(structuredClone(command.operation));
    } else if (command.type === "animation.operation.update") {
      const operation = animation.operations.find(item => item.id === command.operationId); if (!operation) fail("Animation operation not found.");
      Object.assign(operation, structuredClone(command.patch));
    } else if (command.type === "animation.operation.remove") {
      if (!animation.operations.some(operation => operation.id === command.operationId)) fail("Animation operation not found.");
      animation.operations = animation.operations.filter(operation => operation.id !== command.operationId);
    } else if (command.type === "animation.operations.reorder") {
      if (command.operationIds.length !== animation.operations.length || new Set(command.operationIds).size !== animation.operations.length) fail("List every animation operation once.");
      animation.operations = command.operationIds.map(id => animation.operations.find(item => item.id === id) ?? fail("Unknown animation operation."));
    }
    return [{ type: "animation.set", animation }];
  }
  const sequence = project.sequences.find(item => item.id === command.sequenceId);
  if (!sequence) fail("Sequence not found.");
  if (command.type === "audio.duck") return duckAudio(project,sequence,command);
  if (command.type === "audio.parameter.range") return audioParameterRange(project,sequence,command);
  if (command.type === "audio.gain.range") {
    const start = integer(command.startTick), end = integer(command.endTick);
    const sample = ticksPerSample(project.settings.sampleRate);
    if (start < 0 || end <= start || start % sample || end % sample) fail("Audio range must align to the sample grid.");
    if (!Number.isFinite(command.gainDb) || command.gainDb < -120 || command.gainDb > 24) fail("Range gain must be between -120 and +24 dB.");
    if (command.targetType === "clip") {
      const clip = sequence.clips.find(item => item.id === command.targetId); if (!clip) fail("Clip not found."); unlocked(sequence, clip);
      if (start < clip.startTick || end > finish(clip)) fail("The audio range must stay inside the clip.");
    } else {
      const track = sequence.tracks.find(item => item.id === command.targetId); if (!track || track.locked) fail("Select an unlocked track.");
    }
    const target=command.targetType+":"+command.targetId+":gainDbOffset";
    const existing=command.laneId?sequence.automation.find(lane=>lane.id===command.laneId):undefined;
    if(existing&&existing.target!==target)fail("The selected automation lane belongs to another target.");
    return [{type:"automation.set",sequenceId:sequence.id,lane:{id:command.laneId??randomUUID(),sequenceId:sequence.id,enabled:existing?.enabled??true,target,
      points:spliceEnvelope(existing?.points??[],start,end,command.gainDb,sample)}}];
  }
  if (command.type === "gap.remove") {
    const start = integer(command.startTick), end = integer(command.endTick);
    if (start < 0 || end <= start) fail("The gap must have positive duration.");
    if (sequence.clips.some(clip => clip.startTick < end && finish(clip) > start) || sequence.captions.some(cue => cue.startTick < end && cue.startTick + cue.durationTick > start)) fail("The selected range contains clips or captions.");
    const amount = end - start;
    const moving = sequence.clips.filter(clip => clip.startTick >= end);
    moving.forEach(clip => unlocked(sequence, clip));
    if (relatedClipIds(sequence, moving.map(clip => clip.id)).some(id => !moving.some(clip => clip.id === id))) fail("The gap crosses a linked or grouped selection. Ungroup it before closing this gap.");
    const commands: ProjectCommand[] = [];
    if (moving.length) {
      const first = moving.reduce((a, b) => a.startTick <= b.startTick ? a : b);
      commands.push({ type: "clip.move", sequenceId: sequence.id, clipIds: moving.map(clip => clip.id), targetTrackId: first.trackId, startTick: first.startTick - amount, ripple: false });
    }
    for (const cue of sequence.captions.filter(cue => cue.startTick >= end)) {
      if (sequence.tracks.find(track => track.id === cue.trackId)?.locked) fail("Unlock every affected caption track.");
      commands.push({ type: "caption.update", sequenceId: sequence.id, captionId: cue.id, patch: { startTick: cue.startTick - amount } });
    }
    const mapTime = (tick: number) => tick < start ? tick : tick < end ? start : tick - amount;
    for (const marker of sequence.markers) commands.push({ type: "marker.update", sequenceId: sequence.id, markerId: marker.id, patch: { tick: mapTime(marker.tick), durationTick: mapTime(marker.tick + marker.durationTick) - mapTime(marker.tick) } });
    for (const lane of sequence.automation) {
      const points=isAudioAutomation(lane.target)?rippleAutomationPoints(lane.points,end,-amount,ticksPerSample(project.settings.sampleRate)):[...new Map(lane.points.map(point=>[mapTime(point.tick),{...point,tick:mapTime(point.tick)}])).values()];
      commands.push({type:"automation.set",sequenceId:sequence.id,lane:{...lane,points}});
    }
    return commands;
  }
  const clip = sequence.clips.find(item => item.id === command.clipId); if (!clip) fail("Clip not found."); unlocked(sequence, clip);
  if (command.type === "clip.slip") {
    integer(command.deltaTick);
    return relatedClipIds(sequence, [clip.id]).map(id => {
      const target = sequence.clips.find(item => item.id === id)!; unlocked(sequence, target);
      sourceHandles(project, target, target.sourceInTick + command.deltaTick);
      return { type: "clip.update", sequenceId: sequence.id, clipId: target.id, patch: { sourceInTick: target.sourceInTick + command.deltaTick } };
    });
  }
  const delta = command.type === "clip.roll" ? integer(command.tick) - finish(clip) : integer(command.deltaTick);
  return linkedBoundaryEdit(project,sequence,clip,relatedClipIds(sequence,[clip.id]),command.type,delta,ids=>relatedClipIds(sequence,ids));
}

export const ANIMATION_PRESETS = ["title", "lower-third", "callout", "logo-reveal", "bar-chart", "diagram"] as const;
export function animationPreset(preset: typeof ANIMATION_PRESETS[number], text: string, width: number, height: number, durationTick: number): AnimationDocument {
  if (!ANIMATION_PRESETS.includes(preset)) fail("Unknown animation preset.");
  const id = randomUUID();
  const nodes: AnimationDocument["nodes"] = [];
  const node = (type: "rect" | "text", name: string, x: number, y: number, properties: Record<string, unknown>) => {
    const value = { id: randomUUID(), type, name, properties, transform: { ...defaultTransform(), position: [x, y] as [number, number] } };
    nodes.push(value); return value;
  };
  const font = Math.max(16, Math.round(height / 12));
  if (preset === "lower-third" || preset === "callout") node("rect", "Backing", width / 2, height * .8, { width: width * .85, height: height * .2, fill: "#17315a" });
  if (preset === "bar-chart") for (let i = 0; i < 3; i++) node("rect", "Bar " + (i + 1), width * (.25 + i * .25), height * .6, { width: width * .15, height: height * (.15 + i * .12), fill: ["#5b8cff", "#45c9a2", "#ffb547"][i] });
  if (preset === "diagram") for (let i = 0; i < 3; i++) {
    node("rect", "Step " + (i + 1), width * (.2 + i * .3), height * .6, { width: width * .23, height: height * .25, fill: "#17315a" });
    node("text", "Step label " + (i + 1), width * (.2 + i * .3), height * .6, { text: String(i + 1), fontSize: font, fill: "#ffffff" });
  }
  node("text", "Title", width / 2, ["lower-third", "callout"].includes(preset) ? height * .8 : ["bar-chart", "diagram"].includes(preset) ? height * .18 : height / 2,
    { text: text.slice(0, 200), fontSize: font, fill: "#ffffff", fontFamily: "sans-serif" });
  return { id, name: preset + ": " + text.slice(0, 60), durationTick, canvas: { width, height, background: "transparent" }, seed: 1, mode: "declarative", nodes,
    operations: nodes.map((target, index) => ({ id: randomUUID(), type: "create", targetId: target.id, startTick: Math.round(durationTick * .02 * index), durationTick: Math.round(durationTick * .2), easing: "easeOut", parameters: { opacity: 1 } })) };
}
