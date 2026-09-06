import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";import path from "node:path";
import { afterEach,expect,it } from "vitest";
import { defaultClip,framesToTicks } from "@mcp-video-studio/contracts";
import { ProjectStore } from "@mcp-video-studio/core";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-ripple-"));roots.push(root);const store=await ProjectStore.create(root,"Ripple");
 const p=await store.read(),seq=p.sequences[0]!,v=seq.tracks[0]!,a=seq.tracks[1]!,f=framesToTicks(1,p.settings.fps);
 const video=defaultClip(v.id,{type:"color",color:"#123456"},"Video",30*f);video.sourceInTick=30*f;video.linkedGroupId="pair";
 const audio={...structuredClone(video),id:crypto.randomUUID(),trackId:a.id,name:"Audio"};
 const tail=defaultClip(v.id,{type:"color",color:"#654321"},"Tail",30*f);tail.startTick=30*f;tail.sourceInTick=30*f;
 await store.mutate(0,[...[video,audio,tail].map(clip=>({type:"clip.add" as const,sequenceId:seq.id,clip,mode:"overwrite" as const})),
 {type:"marker.add",sequenceId:seq.id,marker:{id:"marker",tick:40*f,durationTick:5*f,label:"Review",color:"#ffffff"}},
 {type:"automation.set",sequenceId:seq.id,lane:{id:"gain",sequenceId:seq.id,target:"clip:"+video.id+":gainDbOffset",enabled:true,points:[{tick:20*f,value:-6,curve:"hold"},{tick:25*f,value:0,curve:"hold"}]}}]);
 return{root,store,seq,v,a,f,video,audio,tail};
}
it("splits linked AV together, gives the right pair a distinct link and moves its copied automation",async()=>{
 const {root,store,seq,v,f,video,audio}=await fixture();
 await store.mutate(1,[{type:"clip.split",sequenceId:seq.id,clipId:video.id,atTick:15*f,rightClipId:"right"}]);
 let s=(await store.read()).sequences[0]!,right=s.clips.find(c=>c.id==="right")!,partner=s.clips.find(c=>c.trackId===audio.trackId&&c.startTick===15*f)!;
 expect(right.linkedGroupId).toBe(partner.linkedGroupId);expect(right.linkedGroupId).not.toBe("pair");
 expect(partner.sourceInTick).toBe(45*f);
 await store.mutate(2,[{type:"clip.move",sequenceId:seq.id,clipIds:["right"],targetTrackId:v.id,startTick:60*f,ripple:false}]);
 s=(await store.read()).sequences[0]!;
 expect(s.clips.find(c=>c.id===partner.id)!.startTick).toBe(60*f);
 expect(s.automation.find(l=>l.target==="clip:right:gainDbOffset")!.points[0]!.tick).toBe(65*f);
 await new ProjectStore(root).undo(3);expect((await store.read()).sequences[0]!.clips.find(c=>c.id==="right")!.startTick).toBe(15*f);
});
it("ripple trim-in changes linked source heads while retaining their timeline start and moving later metadata",async()=>{
 const {store,seq,f,video,audio,tail}=await fixture();
 await store.mutate(1,[{type:"clip.trim",sequenceId:seq.id,clipId:video.id,edge:"in",tick:5*f,ripple:true}]);
 const s=(await store.read()).sequences[0]!;
 for(const id of [video.id,audio.id])expect(s.clips.find(c=>c.id===id)).toMatchObject({startTick:0,durationTick:25*f,sourceInTick:35*f});
 expect(s.clips.find(c=>c.id===tail.id)!.startTick).toBe(25*f);
 expect(s.markers[0]).toMatchObject({tick:35*f,durationTick:5*f});
 expect(s.automation[0]!.points[0]!.tick).toBe(15*f);
});
it("ripple edits reject locked partners atomically and remove linked media without leaving automation",async()=>{
 const {store,seq,a,f,video,audio,tail}=await fixture();
 await store.mutate(1,[{type:"track.update",sequenceId:seq.id,trackId:a.id,patch:{locked:true}}]);
 await expect(store.mutate(2,[{type:"clip.trim",sequenceId:seq.id,clipId:video.id,edge:"out",tick:25*f,ripple:true}])).rejects.toThrow();
 expect((await store.read()).revision).toBe(2);
 await store.mutate(2,[{type:"track.update",sequenceId:seq.id,trackId:a.id,patch:{locked:false}},{type:"clip.remove",sequenceId:seq.id,clipIds:[video.id],ripple:true}]);
 const s=(await store.read()).sequences[0]!;
 expect(s.clips.map(c=>c.id)).toEqual([tail.id]);expect(s.clips[0]!.startTick).toBe(0);
 expect(s.automation).toEqual([]);expect(s.clips.some(c=>c.id===audio.id)).toBe(false);
});
it("ripple insertion splits spanning linked clips and opens the same interval across tracks",async()=>{
 const {store,seq,v,f,video,audio,tail}=await fixture();
 const inserted=defaultClip(v.id,{type:"color",color:"#ffffff"},"Insert",10*f);inserted.startTick=15*f;
 await store.mutate(1,[{type:"clip.add",sequenceId:seq.id,clip:inserted,mode:"ripple"}]);
 const s=(await store.read()).sequences[0]!;
 expect(s.clips.find(c=>c.id===video.id)!.durationTick).toBe(15*f);
 expect(s.clips.find(c=>c.id===audio.id)!.durationTick).toBe(15*f);
 expect(s.clips.filter(c=>c.startTick===25*f)).toHaveLength(2);
 expect(s.clips.find(c=>c.id===tail.id)!.startTick).toBe(40*f);
 expect(s.markers[0]!.tick).toBe(50*f);
});
it("ripple move closes the source interval and inserts at the requested final time",async()=>{
 const {store,seq,v,f,video,audio,tail}=await fixture();
 await store.mutate(1,[{type:"clip.move",sequenceId:seq.id,clipIds:[video.id],targetTrackId:v.id,startTick:60*f,ripple:true}]);
 const s=(await store.read()).sequences[0]!;
 expect(s.clips.find(c=>c.id===tail.id)!.startTick).toBe(0);
 for(const id of [video.id,audio.id])expect(s.clips.find(c=>c.id===id)!.startTick).toBe(60*f);
 expect(s.automation[0]!.points[0]!.tick).toBe(80*f);
});
