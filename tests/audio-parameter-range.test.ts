import {expect,it} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {defaultClip,secondsToTicks,ticksPerSample,resolveAudioParameter,type AudioParameterRangeCommand} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";
import {audioParameterVariants} from "../packages/renderer/src/audio-ranges.js";
it("range edits compose without altering earlier intervals, reject invalid targets and restore through durable undo",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"audio-range-contract-"));
 try{
  const store=await ProjectStore.create(root,"Ranges"),p=await store.read(),s=p.sequences[0]!,track=s.tracks.find(t=>t.type==="audio")!,q=ticksPerSample(p.settings.sampleRate);
  const clip=defaultClip(track.id,{type:"color",color:"#123456"},"Timeline audio target",secondsToTicks(1));
  await store.mutate(0,[{type:"clip.add",sequenceId:s.id,clip,mode:"overwrite"}]);
  const command:AudioParameterRangeCommand={type:"audio.parameter.range",sequenceId:s.id,targetType:"clip",targetId:clip.id,parameter:"pan",startTick:100*q,endTick:200*q,value:.7};
  await store.mutate(1,[command]);await store.mutate(2,[{...command,startTick:150*q,endTick:250*q,value:-.5}]);
  const current=await store.read(),sequence=current.sequences[0]!,lane=sequence.automation[0]!;
  expect(sequence.automation).toHaveLength(1);
  expect(lane.points.map(p=>[p.tick/q,p.value])).toEqual([[100,.7],[150,-.5],[250,0]]);
  const variants=audioParameterVariants(current,sequence,48000)!;
  const covered=Array.from({length:48000},()=>0);
  for(const variant of variants)for(const window of variant.windows)for(let n=window.startSample;n<window.endSample;n++)covered[n]!++;
  expect(new Set(covered)).toEqual(new Set([1]));
  await expect(store.mutate(3,[{...command,startTick:100*q+1}])).rejects.toThrow(/sample/);
  await expect(store.mutate(3,[{...command,value:1.01}])).rejects.toThrow(/between/);
  await expect(store.mutate(3,[{...command,parameter:"effect",effectId:"missing",parameterKey:"__proto__"}])).rejects.toThrow(/target|effect/);
  const bad=structuredClone(sequence);bad.automation[0]!.points[0]!.curve="linear";
  expect(()=>audioParameterVariants(current,bad,48000)).toThrow(/hold/);
  const bad2=structuredClone(sequence);bad2.automation.push({...lane,id:"duplicate"});
  expect(()=>audioParameterVariants(current,bad2,48000)).toThrow(/one active lane/);
  expect(resolveAudioParameter(sequence,lane.target).base).toBe(0);
  await store.undo(3);expect((await store.read()).sequences[0]!.automation[0]!.points.map(p=>[p.tick/q,p.value])).toEqual([[100,.7],[200,0]]);
 }finally{await rm(root,{recursive:true,force:true});}
});
