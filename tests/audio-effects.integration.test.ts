import {mkdtemp,readFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {expect,it} from "vitest";
import {defaultClip,secondsToTicks,type EffectInstance} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";import {importMedia,loadConfig,runChecked} from "@mcp-video-studio/media";
import {renderSequence,audioEffectFilters} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("track limiter processes the mixed clips, bypass changes samples and duplicate normalization is rejected",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-mixer-"));
 try{
  const store=await ProjectStore.create(path.join(root,"project"),"Mix"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};p.settings.channels=1;},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const source=path.join(root,"constant.wav");await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","aevalsrc=0.25:s=48000:d=1","-c:a","pcm_f32le",source]);
  const imported=await importMedia(store,source,"managed",1,config),project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks.find(t=>t.type==="audio")!;
  const first=defaultClip(track.id,{type:"media",mediaId:imported.asset.media.id},"First",secondsToTicks(1)),second={...structuredClone(first),id:crypto.randomUUID(),name:"Second",startTick:secondsToTicks(1)};
  const limiter:EffectInstance={id:"limiter",type:"limiter",enabled:true,parameters:{limit:.2},version:1};
  await store.mutate(2,[{type:"clip.add",sequenceId:sequence.id,clip:first,mode:"overwrite"},{type:"clip.add",sequenceId:sequence.id,clip:second,mode:"overwrite"},{type:"clip.move",sequenceId:sequence.id,clipIds:[second.id],targetTrackId:track.id,startTick:0,ripple:false},{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{effects:[limiter]}}]);
  async function sample(name:string){const output=path.join(root,name+".wav");await renderSequence(store,config,{sequenceId:sequence.id,presetId:"audio-wav",outputPath:output});const raw=path.join(root,name+".f32");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-ac","1","-f","f32le",raw]);return(await readFile(raw)).readFloatLE(12000*4);}
  expect(await sample("limited")).toBeCloseTo(.2,3);
  await store.mutate(3,[{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{effects:[{...limiter,enabled:false}]}}]);
  expect(await sample("bypass")).toBeCloseTo(.5,3);
  const loudness={...limiter,id:"normalize",type:"loudness",parameters:{targetLufs:-16}};
  await store.mutate(4,[{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{effects:[loudness]}},{type:"clip.update",sequenceId:sequence.id,clipId:first.id,patch:{audio:{...first.audio,effects:[{...loudness,id:"clip-normalize"}]}}}]);
  await expect(sample("duplicate")).rejects.toThrow("clip or its track");
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
integration("all declared audio processors execute with bounded parameters in real FFmpeg",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-audio-stack-"));try{
  const effects=["highpass","equalizer","compressor","gate","deesser","reverb","delay","loudness","limiter"].map(type=>({id:type,type,version:1,enabled:true,parameters:type==="equalizer"?{bands:[{frequency:1000,q:1,gainDb:2}]}:{}}));
  const config=loadConfig(process.env),output=path.join(root,"processed.wav");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=1","-af",audioEffectFilters(effects,48000).join(","),"-t","1","-c:a","pcm_f32le",output]);
  expect((await readFile(output)).byteLength).toBeGreaterThan(48000*4);
 }finally{await rm(root,{recursive:true,force:true});}
},30000);
