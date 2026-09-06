import {expect,it} from "vitest";
import {envelopeValue,spliceEnvelope} from "../packages/core/src/envelope.js";
it("range replacement preserves every outside sample including linear interpolation at each edge",()=>{
 const original=[{tick:0,value:0,curve:"linear" as const},{tick:200,value:-12,curve:"linear" as const},{tick:400,value:0,curve:"hold" as const}];
 const edited=spliceEnvelope(original,100,300,-6,1);
 for(let sample=0;sample<500;sample++)expect(envelopeValue(edited,sample)).toBeCloseTo(sample>=100&&sample<300?-6:envelopeValue(original,sample),10);
 expect(original).toHaveLength(3);
});
it("zero start, existing boundary points, empty lanes and unsupported curves are explicit",()=>{
 expect(spliceEnvelope([],0,10,-9,1)).toEqual([{tick:0,value:-9,curve:"hold"},{tick:10,value:0,curve:"hold"}]);
 const points=[{tick:0,value:-3,curve:"hold" as const},{tick:10,value:-12,curve:"linear" as const},{tick:20,value:0,curve:"hold" as const}];
 const edited=spliceEnvelope(points,5,10,-6,1);expect(envelopeValue(edited,4)).toBe(-3);expect(envelopeValue(edited,9)).toBe(-6);expect(envelopeValue(edited,15)).toBe(-6);
 expect(()=>spliceEnvelope([{tick:0,value:0,curve:"easeIn"}],0,1,-1,1)).toThrow("hold/linear");
});

it("actual range command preserves the existing lane outside the edit and rejects cross-target reuse",async()=>{
 const {mkdtemp,rm}=await import("node:fs/promises"),path=await import("node:path"),os=await import("node:os");
 const {ProjectStore}=await import("@mcp-video-studio/core"),{defaultClip,ticksPerSample}=await import("@mcp-video-studio/contracts");
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-envelope-"));try{
  const store=await ProjectStore.create(root,"Envelope"),project=await store.read(),sequence=project.sequences[0]!,clip=defaultClip(sequence.tracks[0]!.id,{type:"color",color:"#000000"},"Clip",35280000);
  const quantum=ticksPerSample(project.settings.sampleRate);
  const points=[{tick:0,value:0,curve:"linear" as const},{tick:200*quantum,value:-12,curve:"linear" as const},{tick:400*quantum,value:0,curve:"hold" as const}];
  await store.mutate(0,[{type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"},{type:"automation.set",sequenceId:sequence.id,lane:{id:"gain",sequenceId:sequence.id,target:"clip:"+clip.id+":gainDbOffset",enabled:true,points}}]);
  await store.mutate(1,[{type:"audio.gain.range",sequenceId:sequence.id,targetType:"clip",targetId:clip.id,laneId:"gain",startTick:100*quantum,endTick:300*quantum,gainDb:-6}]);
  const saved=(await store.read()).sequences[0]!.automation[0]!;
  for(let n=0;n<500;n++)expect(envelopeValue(saved.points,n*quantum)).toBeCloseTo(n>=100&&n<300?-6:envelopeValue(points,n*quantum),10);
  await expect(store.mutate(2,[{type:"audio.gain.range",sequenceId:sequence.id,targetType:"track",targetId:sequence.tracks[0]!.id,laneId:"gain",startTick:100*quantum,endTick:300*quantum,gainDb:-9}])).rejects.toThrow("another target");
  expect((await store.read()).revision).toBe(2);
  await store.undo(2);expect((await store.read()).sequences[0]!.automation[0]!.points).toEqual(points);
 }finally{await rm(root,{recursive:true,force:true});}
});
