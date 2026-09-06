import {expect,it} from "vitest";import {copyFile} from "node:fs/promises";import path from "node:path";
import {secondsToTicks,ticksPerSample,type StudioProject} from "@mcp-video-studio/contracts";
import {generationFixture,generationInput} from "./generation-fixture.js";
import {envelopeValue} from "../packages/core/src/envelope.js";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("gain/pan/effect automation survives three reviewed source versions and partial regeneration across modern/legacy MCP",async()=>{
 const f=await generationFixture();
 try{
  const modern=await f.client("auto");let p=await f.store.read();
  const first=await f.call(modern,"generate_narration",{projectPath:f.projectPath,...generationInput(p,"narration",f.sourceMediaId),autoActivate:true});await f.done(first.job.id);
  p=await f.store.read();const s=p.sequences[0]!,clip=s.clips[0]!,q=ticksPerSample(p.settings.sampleRate);
  await f.call(modern,"apply_timeline_transaction",{projectPath:f.projectPath,expectedRevision:p.revision,commands:[
   {type:"clip.update",sequenceId:s.id,clipId:clip.id,patch:{audio:{...clip.audio,effects:[{id:"echo",type:"delay",enabled:true,version:1,parameters:{delayMs:150,decay:.3}}]}}},
   {type:"audio.gain.range",sequenceId:s.id,targetType:"clip",targetId:clip.id,startTick:12000*q,endTick:120000*q,gainDb:-6},
   {type:"audio.parameter.range",sequenceId:s.id,targetType:"clip",targetId:clip.id,parameter:"pan",startTick:24000*q,endTick:96000*q,value:.4},
   {type:"audio.parameter.range",sequenceId:s.id,targetType:"clip",targetId:clip.id,parameter:"effect",effectId:"echo",parameterKey:"decay",startTick:30000*q,endTick:150000*q,value:.6}
  ]});
  const baseline=(await f.store.read()).sequences[0]!;
  await modern.close();const legacy=await f.client("legacy");
  p=await f.store.read();const second=await f.call(legacy,"regenerate_generated_artifact",{projectPath:f.projectPath,expectedRevision:p.revision,artifactId:first.artifactId,parentVersionId:first.versionId,region:{offsetTick:secondsToTicks(1),durationTick:secondsToTicks(1)}});
  await f.done(second.job.id);
  p=await f.store.read();await f.call(legacy,"apply_timeline_transaction",{projectPath:f.projectPath,expectedRevision:p.revision,commands:[{type:"generation.version.activate",artifactId:first.artifactId,versionId:second.versionId}]});
  function assertAutomation(project:StudioProject){
   const sequence=project.sequences[0]!;
   for(const owned of sequence.clips){
    expect(owned.audio.effects).toEqual(clip.audio.effects.length?clip.audio.effects:baseline.clips[0]!.audio.effects);
    const lanes=sequence.automation.filter(lane=>lane.target.startsWith("clip:"+owned.id+":"));expect(lanes).toHaveLength(3);
    for(const lane of lanes){const original=baseline.automation.find(item=>item.target.split(":").slice(2).join(":")===lane.target.split(":").slice(2).join(":"))!;expect(lane.points).toEqual(original.points);expect(lane.points.every(point=>point.tick%q===0)).toBe(true);
     for(let n=Math.round(owned.startTick/q);n<Math.round((owned.startTick+owned.durationTick)/q);n+=137)expect(envelopeValue(lane.points,n*q)).toBe(envelopeValue(original.points,n*q));
    }
   }
  }
  assertAutomation(await f.store.read());
  const replacement=path.join(f.root,"spoken-replacement.wav");await copyFile(path.resolve("tests/fixtures/audio/voiceover.wav"),replacement);
  p=await f.store.read();await f.call(legacy,"import_media",{projectPath:f.projectPath,expectedRevision:p.revision,filePath:replacement,storageMode:"managed"});
  p=await f.store.read();const media=p.media.find(m=>m.name==="spoken-replacement.wav")!,artifact=p.generatedArtifacts.find(a=>a.id===first.artifactId)!;
  // A complete, locally imported third take exercises a real source swap without a vendor call.
  await f.call(legacy,"apply_timeline_transaction",{projectPath:f.projectPath,expectedRevision:p.revision,commands:[{type:"generation.version.add",artifactId:artifact.id,version:{id:"spoken-third-take",parentVersionId:second.versionId,status:"draft",request:{provider:"local",sourceMediaId:media.id},provenance:{provider:"local",model:"imported-media",requestHash:"a".repeat(64),sourceRevision:p.revision},createdAt:new Date().toISOString(),output:{mediaId:media.id}}}]});
  p=await f.store.read();await f.call(legacy,"apply_timeline_transaction",{projectPath:f.projectPath,expectedRevision:p.revision,commands:[{type:"generation.version.update",artifactId:artifact.id,versionId:"spoken-third-take",patch:{status:"approved",review:{reviewer:"Acceptance fixture",reviewedAt:new Date().toISOString(),note:"Local spoken take reviewed."}}},{type:"generation.version.activate",artifactId:artifact.id,versionId:"spoken-third-take"}]});
  p=await f.store.read();assertAutomation(p);expect(p.generatedArtifacts[0]!.versions).toHaveLength(3);expect(p.generatedArtifacts[0]!.approvedVersionId).toBe("spoken-third-take");expect(p.sequences[0]!.clips.every(c=>c.source.type==="media"&&c.source.mediaId===media.id)).toBe(true);
  const output=path.join(f.root,"regenerated.wav");const rendered=await f.call(legacy,"render_sequence",{projectPath:f.projectPath,sequenceId:s.id,presetId:"audio-wav",outputPath:output});await f.done(rendered.job.id);
 }finally{await f.close();}
},90000);
