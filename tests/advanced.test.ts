import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { defaultClip, framesToTicks, parseCaptions, serializeCaptions, type Clip } from "@mcp-video-studio/contracts";
import { ProjectStore, animationPreset } from "@mcp-video-studio/core";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-advanced-")); roots.push(root);
  const store = await ProjectStore.create(root, "Advanced");
  const p = await store.read(), seq = p.sequences[0]!, video = seq.tracks[0]!, audio = seq.tracks[1]!, frame = framesToTicks(1, p.settings.fps);
  const clips = [0, 1, 2].map(i => { const c = defaultClip(video.id, { type: "color", color: "#123456" }, "Clip" + i, frame * 30); c.startTick = i * frame * 30; c.sourceInTick = frame * 30; return c; });
  await store.mutate(0, clips.map(clip => ({ type: "clip.add", sequenceId: seq.id, clip, mode: "overwrite" })));
  return { store, seq, video, audio, frame, clips };
}
it("roll and slide preserve boundaries, source continuity, identity and durable undo", async () => {
  const { store, seq, clips, frame } = await fixture();
  await store.mutate(1, [{ type: "clip.roll", sequenceId: seq.id, clipId: clips[0]!.id, tick: 35 * frame }]);
  let changed = (await store.read()).sequences[0]!.clips;
  expect(changed.map(c => [c.startTick/frame,c.durationTick/frame,c.sourceInTick/frame])).toEqual([[0,35,30],[35,25,35],[60,30,30]]);
  await store.undo(2); await store.mutate(3, [{ type: "clip.slide", sequenceId: seq.id, clipId: clips[1]!.id, deltaTick: 5*frame }]);
  changed = (await store.read()).sequences[0]!.clips;
  expect(changed.map(c => [c.startTick/frame,c.durationTick/frame,c.sourceInTick/frame])).toEqual([[0,35,30],[35,30,30],[65,25,35]]);
  expect(changed.map(c => c.id)).toEqual(clips.map(c => c.id));
  await expect(store.mutate(4, [{ type: "clip.slip", sequenceId: seq.id, clipId: clips[1]!.id, deltaTick: -31*frame }])).rejects.toThrow();
  expect((await store.read()).revision).toBe(4);
});
it("moves linked audio with its video while retaining track, and rejects locked partners", async () => {
  const { store, seq, video, audio, clips, frame } = await fixture();
  const partner: Clip = { ...structuredClone(clips[0]!), id: crypto.randomUUID(), trackId: audio.id, linkedGroupId: "av" };
  await store.mutate(1, [{ type: "clip.update", sequenceId: seq.id, clipId: clips[0]!.id, patch: { linkedGroupId: "av" } }, { type: "clip.add", sequenceId: seq.id, clip: partner, mode: "overwrite" }]);
  await store.mutate(2, [{ type: "clip.move", sequenceId: seq.id, clipIds: [clips[0]!.id], targetTrackId: video.id, startTick: frame, ripple: false }]);
  const changed = (await store.read()).sequences[0]!.clips.find(c => c.id === partner.id)!;
  expect(changed.trackId).toBe(audio.id); expect(changed.startTick).toBe(frame);
  await store.mutate(3, [{ type: "track.update", sequenceId: seq.id, trackId: audio.id, patch: { locked: true } }]);
  await expect(store.mutate(4, [{ type: "clip.slip", sequenceId: seq.id, clipId: clips[0]!.id, deltaTick: frame }])).rejects.toThrow();
});
it("gap removal preserves cross-track positions and refuses a gap crossed by grouped clips", async () => {
  const { store, seq, clips, audio, frame } = await fixture();
  await store.mutate(1, [{ type: "clip.remove", sequenceId: seq.id, clipIds: [clips[1]!.id], ripple: false }, { type: "clip.move", sequenceId: seq.id, clipIds: [clips[2]!.id], targetTrackId: audio.id, startTick: 60*frame, ripple: false }]);
  await store.mutate(2, [{ type: "gap.remove", sequenceId: seq.id, startTick: 30*frame, endTick: 60*frame }]);
  expect((await store.read()).sequences[0]!.clips.map(c => c.startTick/frame)).toEqual([0,30]);
  await store.undo(3);
  await store.mutate(4, clips.filter((_,i)=>i!==1).map(clip=>({ type: "clip.update", sequenceId: seq.id, clipId: clip.id, patch: { groupId: "group" } })));
  await expect(store.mutate(5, [{ type: "gap.remove", sequenceId: seq.id, startTick: 30*frame, endTick: 60*frame }])).rejects.toThrow();
});
it("typed animation edits preserve other nodes and reject invalid hierarchy", async () => {
  const { store, frame } = await fixture(); const a = animationPreset("diagram", "Plan", 320,180,60*frame);
  await store.mutate(1, [{ type: "animation.set", animation: a }]);
  await store.mutate(2, [{ type: "animation.node.update", animationId: a.id, nodeId: a.nodes[0]!.id, patch: { name: "Changed" } }]);
  expect((await store.read()).animations[0]!.nodes.slice(1)).toEqual(a.nodes.slice(1));
  await expect(store.mutate(3, [{ type: "animation.node.update", animationId: a.id, nodeId: a.nodes[0]!.id, patch: { parentId: a.nodes[0]!.id } }])).rejects.toThrow();
  await store.mutate(3, [{ type: "animation.operations.reorder", animationId: a.id, operationIds: a.operations.map(o=>o.id).reverse() }]);
  expect((await store.read()).animations[0]!.operations.map(o=>o.id)).toEqual(a.operations.map(o=>o.id).reverse());
});
it("round-trips multiline UTF-8 SRT and WebVTT, aligns to frames and rejects malformed imports", () => {
  const style = {fontFamily:"Arial",fontSize:24,color:"#ffffff",background:"#000000aa",position:"bottom" as const,align:"center" as const}, fps={numerator:30,denominator:1};
  const cues = parseCaptions("1\n00:00:00,000 --> 00:00:01,500\n¡Hola!\nSecond line", "srt", "track",fps,style);
  expect(cues[0]!.durationTick).toBe(framesToTicks(45,fps));
  expect(parseCaptions(serializeCaptions(cues,"vtt"),"vtt","track",fps,style)[0]!.text).toBe(cues[0]!.text);
  expect(() => parseCaptions("WEBVTT\n\n00:02.000 --> 00:01.000\nbad", "vtt", "track", fps,style)).toThrow();
});
