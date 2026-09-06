import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";import path from "node:path";
import { expect,it } from "vitest";
import { defaultClip, ticksPerSample } from "@mcp-video-studio/contracts";
import { ProjectStore } from "@mcp-video-studio/core";
import { importMedia,loadConfig,runChecked } from "@mcp-video-studio/media";
import { renderSequence } from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("renders gain range at exact samples, preserves surrounding audio and outputs actual WAV/VP9",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-gain-"));
 try{
  const store=await ProjectStore.create(path.join(root,"project"),"Sample boundary"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const source=path.join(root,"constant.wav");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","aevalsrc=0.25:s=48000:d=1","-c:a","pcm_f32le",source]);
  const imported=await importMedia(store,source,"managed",1,config),project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks.find(t=>t.type==="audio")!,q=ticksPerSample(48000);
  const clip=defaultClip(track.id,{type:"media",mediaId:imported.asset.media.id},"Constant",48000*q);clip.startTick=100*q;
  await store.mutate(2,[{type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"},{type:"audio.gain.range",sequenceId:sequence.id,targetType:"clip",targetId:clip.id,startTick:1334*q,endTick:2545*q,gainDb:-20}]);
  const out=path.join(root,"mix.wav");await renderSequence(store,config,{sequenceId:sequence.id,presetId:"audio-wav",outputPath:out});
  const pcm=path.join(root,"mix.f32");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",out,"-f","f32le","-acodec","pcm_f32le",pcm]);const data=await readFile(pcm),sample=(n:number)=>data.readFloatLE(n*8);
  expect(data.length/8).toBe(48100);
  expect(sample(99)).toBeCloseTo(0,6);
  expect(sample(1333)).toBeGreaterThan(.1);
  expect(sample(1334)/sample(1333)).toBeCloseTo(.1,5);
  expect(sample(2544)/sample(2545)).toBeCloseTo(.1,5);
  expect(sample(2545)).toBeCloseTo(sample(1333),5);
  const vp9=await renderSequence(store,config,{sequenceId:sequence.id,presetId:"web-vp9",outputPath:path.join(root,"mix.webm")});
  expect(vp9.success).toBe(true);expect(vp9.probe).toMatchObject({videoCodec:"vp9",audioCodec:"opus"});
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
