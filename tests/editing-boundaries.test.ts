import {mkdtemp,rm} from "node:fs/promises";
import path from "node:path";import os from "node:os";
import {afterEach,expect,it} from "vitest";
import {defaultClip,framesToTicks,secondsToTicks,copyClipSelection,pasteClipSelection,type Clip} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-linked-cuts-"));roots.push(root);
 const store=await ProjectStore.create(root,"Linked editing"),p=await store.read(),s=p.sequences[0]!,f=framesToTicks(1,p.settings.fps);
 const pairs:Clip[][]=[0,1,2].map(i=>s.tracks.slice(0,2).map((track,j)=>({...defaultClip(track.id,{type:"color",color:"#123456"},["Video","Audio"][j]+" "+i,30*f),startTick:i*30*f,sourceInTick:30*f,linkedGroupId:"pair"+i})));
 await store.mutate(0,[...pairs.flat().map(clip=>({type:"clip.add" as const,sequenceId:s.id,clip,mode:"overwrite" as const})),{type:"automation.set",sequenceId:s.id,lane:{id:"envelope",sequenceId:s.id,target:"clip:"+pairs[1]![1]!.id+":gainDbOffset",enabled:true,points:[{tick:30*f,value:-12,curve:"linear"},{tick:60*f,value:0,curve:"linear"}]}}]);
 return{root,store,s,f,pairs};
}
it("rolls and slides linked AV cuts, preserving identity, source, automation and durable undo/redo",async()=>{
 const {root,store,s,f,pairs}=await fixture();
 await store.mutate(1,[{type:"clip.roll",sequenceId:s.id,clipId:pairs[0]![0]!.id,tick:35*f}]);
 let seq=(await store.read()).sequences[0]!;
 for(const clip of pairs[0]!)expect(seq.clips.find(c=>c.id===clip.id)!.durationTick).toBe(35*f);
 for(const clip of pairs[1]!)expect(seq.clips.find(c=>c.id===clip.id)).toMatchObject({startTick:35*f,durationTick:25*f,sourceInTick:35*f});
 await new ProjectStore(root).undo(2);
 await store.mutate(3,[{type:"clip.slide",sequenceId:s.id,clipId:pairs[1]![0]!.id,deltaTick:5*f}]);
 seq=(await store.read()).sequences[0]!;
 for(const clip of pairs[1]!)expect(seq.clips.find(c=>c.id===clip.id)).toMatchObject({startTick:35*f,durationTick:30*f,sourceInTick:30*f});
 expect(seq.automation[0]!.points.map(p=>p.tick)).toEqual([35*f,65*f]);
 const expected=structuredClone(seq);await new ProjectStore(root).undo(4);await new ProjectStore(root).redo(5);
 expect((await store.read()).sequences[0]).toEqual(expected);
});
it("rejects locked or structurally incomplete linked cuts without changing project/history",async()=>{
 const {store,s,pairs,f}=await fixture();
 await store.mutate(1,[{type:"track.update",sequenceId:s.id,trackId:pairs[2]![1]!.trackId,patch:{locked:true}}]);
 const before=await store.read();
 await expect(store.mutate(2,[{type:"clip.slide",sequenceId:s.id,clipId:pairs[1]![0]!.id,deltaTick:f}])).rejects.toThrow("Unlock");
 expect(await store.read()).toEqual(before);
 await store.mutate(2,[{type:"track.update",sequenceId:s.id,trackId:pairs[2]![1]!.trackId,patch:{locked:false}},{type:"clip.move",sequenceId:s.id,clipIds:[pairs[2]![1]!.id],targetTrackId:pairs[2]![1]!.trackId,startTick:65*f,ripple:false}]);
 await expect(store.mutate(3,[{type:"clip.slide",sequenceId:s.id,clipId:pairs[1]![0]!.id,deltaTick:f}])).rejects.toThrow("adjacent");
 expect((await store.read()).revision).toBe(3);
});
it("overwrites the same AV range while keeping split automation, separate right links and undo/redo",async()=>{
 const {root,store,s,pairs,f}=await fixture();
 const insert=defaultClip(pairs[1]![0]!.trackId,{type:"color",color:"#ffffff"},"Replacement",10*f);insert.startTick=40*f;
 await store.mutate(1,[{type:"clip.add",sequenceId:s.id,clip:insert,mode:"overwrite"}]);
 const seq=(await store.read()).sequences[0]!,right=seq.clips.filter(c=>c.startTick===50*f);
 expect(right).toHaveLength(2);expect(right[0]!.linkedGroupId).toBe(right[1]!.linkedGroupId);expect(right[0]!.linkedGroupId).not.toBe("pair1");
 const audio=right.find(c=>c.trackId===pairs[1]![1]!.trackId)!;
 expect(seq.automation.find(l=>l.target==="clip:"+audio.id+":gainDbOffset")!.points).toEqual([{tick:30*f,value:-12,curve:"linear"},{tick:60*f,value:0,curve:"linear"}]);
 expect(seq.clips.filter(c=>c.trackId===pairs[1]![1]!.trackId&&c.startTick<50*f&&c.startTick+c.durationTick>40*f)).toEqual([]);
 await new ProjectStore(root).undo(2);await new ProjectStore(root).redo(3);expect((await store.read()).sequences[0]).toEqual(seq);
});
it("overwriting a linked range rejects a locked partner atomically",async()=>{
 const {store,s,pairs,f}=await fixture();
 await store.mutate(1,[{type:"track.update",sequenceId:s.id,trackId:pairs[1]![1]!.trackId,patch:{locked:true}}]);const before=await store.read();
 const insert=defaultClip(pairs[1]![0]!.trackId,{type:"color",color:"#ffffff"},"Replacement",10*f);insert.startTick=40*f;
 await expect(store.mutate(2,[{type:"clip.add",sequenceId:s.id,clip:insert,mode:"overwrite"}])).rejects.toThrow();
 expect(await store.read()).toEqual(before);
});

it("sparse groups retain spacing and unrelated work; ripple deletion cannot consume their gap",async()=>{
 const {root,store,s,pairs,f}=await fixture();
 await store.mutate(1,[{type:"clip.relate",sequenceId:s.id,clipIds:[pairs[0]![0]!.id,pairs[2]![0]!.id],relation:"group",relationshipId:"sparse"}]);
 const before=await store.read();
 await expect(store.mutate(2,[{type:"clip.remove",sequenceId:s.id,clipIds:[pairs[0]![0]!.id],ripple:true}])).rejects.toThrow("unselected");
 expect(await store.read()).toEqual(before);
 await store.mutate(2,[{type:"clip.move",sequenceId:s.id,clipIds:[pairs[0]![0]!.id],targetTrackId:pairs[0]![0]!.trackId,startTick:90*f,ripple:false}]);
 const seq=(await store.read()).sequences[0]!;
 for(const clip of pairs[1]!)expect(seq.clips.find(c=>c.id===clip.id)).toEqual(clip);
 expect(seq.clips.find(c=>c.id===pairs[2]![0]!.id)!.startTick-seq.clips.find(c=>c.id===pairs[0]![0]!.id)!.startTick).toBe(60*f);
 await new ProjectStore(root).undo(3);await new ProjectStore(root).redo(4);expect((await store.read()).sequences[0]).toEqual(seq);
});

it("copying earlier preserves interpolated automation at zero and remaps transition/group identity",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-copy-envelope-"));roots.push(root);
 const store=await ProjectStore.create(root,"Copy envelope"),project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks[0]!,tick=secondsToTicks;
 const clips=[20,30].map(start=>({...defaultClip(track.id,{type:"color" as const,color:"#123456"},"Group",tick(10)),startTick:tick(start),groupId:"source-group"}));
 await store.mutate(0,[...clips.map(clip=>({type:"clip.add" as const,sequenceId:sequence.id,clip,mode:"overwrite" as const})),{type:"transition.add",sequenceId:sequence.id,transition:{id:"source-transition",sequenceId:sequence.id,fromClipId:clips[0]!.id,toClipId:clips[1]!.id,type:"crossfade",durationTick:tick(.4),parameters:{}}},{type:"automation.set",sequenceId:sequence.id,lane:{id:"source-envelope",sequenceId:sequence.id,target:"clip:"+clips[0]!.id+":gainDbOffset",enabled:true,points:[{tick:0,value:-12,curve:"linear"},{tick:tick(40),value:0,curve:"linear"}]}}]);
 const before=(await store.read()).sequences[0]!,paste=pasteClipSelection(sequence.id,copyClipSelection(before,[clips[0]!.id]),0);
 await store.mutate(1,paste.commands);const result=(await store.read()).sequences[0]!,copied=result.clips.filter(c=>paste.clipIds.includes(c.id));
 expect(copied).toHaveLength(2);expect(new Set(copied.map(c=>c.groupId)).size).toBe(1);expect(copied[0]!.groupId).not.toBe("source-group");
 expect(result.clips.filter(c=>clips.some(original=>original.id===c.id))).toEqual(clips);
 const lane=result.automation.find(l=>l.id!=="source-envelope")!;expect(lane.points).toEqual([{tick:0,value:-6,curve:"linear"},{tick:tick(20),value:0,curve:"linear"}]);
 const transition=result.transitions.find(t=>t.id!=="source-transition")!;expect(paste.clipIds).toContain(transition.fromClipId);expect(paste.clipIds).toContain(transition.toClipId);
 await new ProjectStore(root).undo(2);await new ProjectStore(root).redo(3);expect((await store.read()).sequences[0]).toEqual(result);
});
