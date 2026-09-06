import {isAudioAutomation,shiftAutomationPoints,rippleAutomationPoints} from "@mcp-video-studio/contracts";
import { randomUUID } from "node:crypto";
import type { Clip, Sequence } from "@mcp-video-studio/contracts";
import { StudioException } from "./errors.js";

const end = (clip: Clip) => clip.startTick + clip.durationTick;
const fail = (message: string): never => { throw new StudioException("RIPPLE_BOUNDARY", message, "input"); };
export function requireUnlocked(sequence: Sequence, trackId: string): void {
  const track = sequence.tracks.find(item => item.id === trackId);
  if (!track || track.locked) throw new StudioException("TRACK_LOCKED", "Unlock every affected track before editing.", "input", { trackId });
}
export function shiftClipAutomation(sequence: Sequence, clipId: string, amount: number, sampleTick=1): void {
  for (const lane of sequence.automation.filter(item => item.target.startsWith("clip:" + clipId + ":"))) {
    lane.points = shiftAutomationPoints(lane.points,amount,isAudioAutomation(lane.target)?sampleTick:1);
  }
}
export function splitClipAt(sequence: Sequence, clip: Clip, tick: number, rightId: string = randomUUID()): Clip {
  if (tick <= clip.startTick || tick >= end(clip)) fail("Split point must be inside each affected clip.");
  requireUnlocked(sequence, clip.trackId);
  const right = structuredClone(clip), leftDuration = tick - clip.startTick;
  right.id = rightId; right.startTick = tick; right.durationTick -= leftDuration;
  right.sourceInTick += Math.round(leftDuration * clip.playbackRate.numerator / clip.playbackRate.denominator);
  // A split is a continuous edit, not a new fade at the cut.
  right.audio.fadeInTick = Math.max(0, clip.audio.fadeInTick - leftDuration);
  clip.audio.fadeOutTick = Math.max(0, clip.audio.fadeOutTick - right.durationTick);
  clip.durationTick = leftDuration;
  right.audio.fadeInTick = Math.min(right.durationTick, right.audio.fadeInTick);
  right.audio.fadeOutTick = Math.min(right.durationTick - right.audio.fadeInTick, right.audio.fadeOutTick);
  clip.audio.fadeInTick = Math.min(clip.durationTick, clip.audio.fadeInTick);
  clip.audio.fadeOutTick = Math.min(clip.durationTick - clip.audio.fadeInTick, clip.audio.fadeOutTick);
  for (const lane of [...sequence.automation].filter(item => item.target.startsWith("clip:" + clip.id + ":"))) {
    sequence.automation.push({ ...structuredClone(lane), id: randomUUID(), target: lane.target.replace("clip:" + clip.id + ":", "clip:" + right.id + ":") });
  }
  for (const transition of sequence.transitions) if (transition.fromClipId === clip.id) transition.fromClipId = right.id;
  sequence.clips.push(right);
  return right;
}
/** Insert positive time or remove an empty interval ending at tick. All checks run on a transaction clone. */
export function rippleTimeline(sequence: Sequence, tick: number, amount: number, excluded: Set<string>, trackIds?: Set<string>, sampleTick=1): void {
  if (amount === 0) return;
  if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(amount) || tick < 0 || tick + amount < 0) fail("Ripple times must stay on the nonnegative integer timeline.");
  const affects = (trackId: string) => !trackIds || trackIds.has(trackId);
  const candidates = sequence.clips.filter(clip => !excluded.has(clip.id) && affects(clip.trackId));
  if (amount < 0 && candidates.some(clip => clip.startTick < tick && end(clip) > tick + amount)) fail("The removed interval contains an unselected clip. Split or select that clip first.");
  const crossing = amount > 0 ? candidates.filter(clip => clip.startTick < tick && end(clip) > tick) : [];
  const moving = candidates.filter(clip => clip.startTick >= tick);
  const involved = new Set([...crossing, ...moving].map(clip => clip.id));
  for (const clip of [...crossing, ...moving]) {
    requireUnlocked(sequence, clip.trackId);
    for (const peer of sequence.clips) {
      if (excluded.has(peer.id) || involved.has(peer.id)) continue;
      if ((clip.groupId && clip.groupId === peer.groupId) || (clip.linkedGroupId && clip.linkedGroupId === peer.linkedGroupId)) fail("Ripple crosses a linked or grouped boundary. Include its tracks and split the group at this boundary first.");
    }
  }
  const groupIds = new Map<string, string>(), linkIds = new Map<string, string>();
  const fresh = (map: Map<string,string>, id: string) => { let value = map.get(id); if (!value) { value = randomUUID(); map.set(id,value); } return value; };
  for (const clip of crossing) {
    const right = splitClipAt(sequence, clip, tick);
    if (right.groupId) right.groupId = fresh(groupIds,right.groupId);
    if (right.linkedGroupId) right.linkedGroupId = fresh(linkIds,right.linkedGroupId);
    moving.push(right);
  }
  const mapTime = (value: number) => amount > 0 ? (value >= tick ? value + amount : value) : value >= tick ? value + amount : Math.min(value, tick + amount);
  for (const clip of moving) clip.startTick += amount;
  const cues = sequence.captions.filter(cue => affects(cue.trackId));
  for (const cue of cues) {
    const finish = cue.startTick + cue.durationTick;
    if (finish <= (amount < 0 ? tick + amount : tick)) continue;
    requireUnlocked(sequence,cue.trackId);
    if (amount < 0 && cue.startTick < tick && finish > tick + amount) fail("The removed interval contains captions. Remove or split them first.");
    if (amount > 0 && cue.startTick < tick && finish > tick) {
      sequence.captions.push({ ...structuredClone(cue), id: randomUUID(), startTick: tick + amount, durationTick: finish - tick });
      cue.durationTick = tick - cue.startTick;
    } else if (cue.startTick >= tick) cue.startTick += amount;
  }
  for (const lane of sequence.automation) {
    const target = lane.target.split(":");
    if(target[0]==="clip"&&excluded.has(target[1]!))continue;
    const owner = target[0] === "clip" ? sequence.clips.find(clip => clip.id === target[1])?.trackId : target[0] === "track" ? target[1] : undefined;
    if (trackIds && (!owner || !affects(owner))) continue;
    if(isAudioAutomation(lane.target))lane.points=rippleAutomationPoints(lane.points,tick,amount,sampleTick);
    else{const points=new Map(lane.points.map(point=>[mapTime(point.tick),{...point,tick:mapTime(point.tick)}]));lane.points=[...points.values()];}
  }
  if (!trackIds) for (const marker of sequence.markers) {
    const finish = mapTime(marker.tick + marker.durationTick);
    marker.tick = mapTime(marker.tick); marker.durationTick = Math.max(0,finish-marker.tick);
  }
}
export function cleanupClipReferences(sequence: Sequence, removedIds: Set<string>): void {
  sequence.transitions = sequence.transitions.filter(item => !removedIds.has(item.fromClipId) && !removedIds.has(item.toClipId));
  sequence.automation = sequence.automation.filter(item => !(item.target.startsWith("clip:") && removedIds.has(item.target.split(":")[1]!)));
}
