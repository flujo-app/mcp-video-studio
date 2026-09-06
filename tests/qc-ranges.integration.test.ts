import {mkdtemp,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";import {expect,it} from "vitest";
import {defaultClip,secondsToTicks} from "@mcp-video-studio/contracts";import {ProjectStore} from "@mcp-video-studio/core";import {loadConfig} from "@mcp-video-studio/media";import {renderSequence,runQc,detectorRanges,type QcCheck} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
it("detector events retain exact intervals and finish open freeze/silence at EOF",()=>{
 const ranges=detectorRanges("black_start:0.5 black_end:1 black_duration:0.5\nlavfi.freezedetect.freeze_start: 1.25\nsilence_start: 2\nsilence_end: 2.75 | silence_duration: 0.75",3);
 expect(ranges).toEqual([{checkId:"video.black",start:.5,end:1},{checkId:"video.freeze",start:1.25,end:3},{checkId:"audio.silence",start:2,end:2.75}]);
});
integration("QC reports measured ranges, actual decoded frames and persisted intentional-range review",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-qc-ranges-"));try{
  const store=await ProjectStore.create(path.join(root,"project"),"QC"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const project=await store.read(),sequence=project.sequences[0]!,clip=defaultClip(sequence.tracks[0]!.id,{type:"color",color:"#000000"},"Intentional black",secondsToTicks(3));
  await store.mutate(1,[{type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"}]);
  const output=path.join(root,"black.mp4");await renderSequence(store,config,{sequenceId:sequence.id,presetId:project.exportPresets[0]!.id,outputPath:output});
  let report=await runQc(store,sequence.id,output,config),checks=report.checks as QcCheck[];
  expect(checks.find(check=>check.id==="video.frames")).toMatchObject({status:"PASS",observed:{frames:90}});
  for(const id of ["video.black","video.freeze","audio.silence"])expect(checks.find(check=>check.checkId===id)).toMatchObject({status:"WARN",startTick:0,clipIds:[clip.id]});
  const found=checks.filter(check=>check.checkId&&check.startTick!==undefined&&check.endTick!==undefined);
  await store.mutate(2,found.map(check=>({type:"qc.allowance.set",sequenceId:sequence.id,allowance:{id:crypto.randomUUID(),checkId:check.checkId as "video.black"|"video.freeze"|"audio.silence",startTick:check.startTick!,endTick:check.endTick!,reason:"Intentional pause in this production"}})));
  report=await runQc(new ProjectStore(store.root),sequence.id,output,config);checks=report.checks as QcCheck[];
  expect(checks.filter(check=>check.checkId).every(check=>check.status==="PASS"&&check.allowanceId)).toBe(true);
  expect(report.passed).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
