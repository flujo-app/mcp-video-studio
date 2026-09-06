import {mkdtemp,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";
import {rippleAutomationPoints,shiftAutomationPoints,defaultClip,framesToTicks,ticksPerSample,type AutomationPoint} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";import {envelopeValue} from "../packages/core/src/envelope.js";
for(const quantum of [1,735,800])it("insertion/removal preserve every retained ramp sample at quantum "+quantum,()=>{
 const points:AutomationPoint[]=[{tick:0,value:-12,curve:"linear"},{tick:200*quantum,value:-3,curve:"linear"},{tick:400*quantum,value:0,curve:"hold"}];
 const inserted=rippleAutomationPoints(points,100*quantum,70*quantum,quantum),deleted=rippleAutomationPoints(points,300*quantum,-200*quantum,quantum);
 for(let sample=0;sample<500;sample++){
  const tick=sample*quantum;
  if(sample<100||sample>=170)expect(envelopeValue(inserted,tick)).toBeCloseTo(envelopeValue(points,(sample<100?sample:sample-70)*quantum),10);
  expect(envelopeValue(deleted,tick)).toBeCloseTo(envelopeValue(points,(sample<100?sample:sample+200)*quantum),10);
 }
 expect(inserted.every(point=>point.tick%quantum===0)).toBe(true);expect(deleted.every(point=>point.tick%quantum===0)).toBe(true);
});
it("empty and late-starting absolute hold lanes preserve their implicit base; rounded collisions use the later point",()=>{
 const points:AutomationPoint[]=[{tick:200,value:.25,curve:"hold"},{tick:400,value:.75,curve:"hold"}];
 expect(rippleAutomationPoints([],300,-200,1)).toEqual([]);
 expect(rippleAutomationPoints(points,100,50,1)).toEqual([{tick:250,value:.25,curve:"hold"},{tick:450,value:.75,curve:"hold"}]);
 expect(shiftAutomationPoints([{tick:1,value:1,curve:"hold"},{tick:2,value:2,curve:"hold"}],0,10)).toEqual([{tick:0,value:2,curve:"hold"}]);
});
it("NTSC clip moves keep audio automation editable on the sample grid and exact non-audio ticks",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-ntsc-envelope-"));try{
  const store=await ProjectStore.create(root,"NTSC"),initial=await store.read(),sequence=initial.sequences[0]!;
  await store.replace(0,p=>{p.settings.fps={numerator:30000,denominator:1001};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const project=await store.read(),frame=framesToTicks(1,project.settings.fps),quantum=ticksPerSample(project.settings.sampleRate);
  const clip=defaultClip(sequence.tracks[1]!.id,{type:"color",color:"#000000"},"Audio",100*frame);clip.startTick=10*frame;
  await store.mutate(1,[{type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"},{type:"automation.set",sequenceId:sequence.id,lane:{id:"pan",sequenceId:sequence.id,target:"clip:"+clip.id+":audio.pan",enabled:true,points:[{tick:0,value:0,curve:"hold"},{tick:10000*quantum,value:.25,curve:"hold"}]}}]);
  await store.mutate(2,[{type:"clip.move",sequenceId:sequence.id,clipIds:[clip.id],targetTrackId:clip.trackId,startTick:11*frame,ripple:false}]);
  const moved=(await store.read()).sequences[0]!;expect(moved.clips[0]!.startTick).toBe(11*frame);expect(moved.automation[0]!.points.every(point=>point.tick%quantum===0)).toBe(true);
  await store.mutate(3,[{type:"audio.parameter.range",sequenceId:sequence.id,targetType:"clip",targetId:clip.id,parameter:"pan",startTick:20000*quantum,endTick:21000*quantum,value:-.5}]);
  const expected=(await store.read()).sequences[0];await new ProjectStore(root).undo(4);await new ProjectStore(root).redo(5);expect((await store.read()).sequences[0]).toEqual(expected);
 }finally{await rm(root,{recursive:true,force:true});}
});
it("closing a real empty interval retains a track ramp on both sides and durable history",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-gap-ramp-"));try{
  const store=await ProjectStore.create(root,"Gap ramp"),p=await store.read(),s=p.sequences[0]!,q=ticksPerSample(p.settings.sampleRate);
  const points:AutomationPoint[]=[{tick:0,value:-12,curve:"linear"},{tick:1000*q,value:0,curve:"hold"}];
  await store.mutate(0,[{type:"automation.set",sequenceId:s.id,lane:{id:"track-gain",sequenceId:s.id,target:"track:"+s.tracks[1]!.id+":gainDbOffset",enabled:true,points}}]);
  await store.mutate(1,[{type:"gap.remove",sequenceId:s.id,startTick:200*q,endTick:400*q}]);
  const expected=(await store.read()).sequences[0]!;
  for(let sample=0;sample<800;sample++)expect(envelopeValue(expected.automation[0]!.points,sample*q)).toBeCloseTo(envelopeValue(points,(sample<200?sample:sample+200)*q),10);
  await new ProjectStore(root).undo(2);await new ProjectStore(root).redo(3);expect((await store.read()).sequences[0]).toEqual(expected);
 }finally{await rm(root,{recursive:true,force:true});}
});
