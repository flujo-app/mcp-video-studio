import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {it,expect} from "vitest";
import {defaultClip,secondsToTicks} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";
import {loadConfig,importMedia,runChecked,probeMedia} from "@mcp-video-studio/media";
import {renderSequence} from "@mcp-video-studio/renderer";
import {storedZipEntries} from "./export-fixture.js";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-export-formats-")),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),store=await ProjectStore.create(path.join(root,"project"),"Export acceptance");
 await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
 const source=path.join(root,"source.wav");await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","aevalsrc=0.3*sin(2*PI*330*t)*lt(mod(t\\,0.6)\\,0.45):s=44100:d=2","-c:a","pcm_f32le",source]);
 const imported=await importMedia(store,source,"managed",1,config),project=await store.read(),sequence=project.sequences[0]!,audio=sequence.tracks.find(track=>track.type==="audio")!,video=sequence.tracks.find(track=>track.type==="video")!;
 const voice=defaultClip(audio.id,{type:"media",mediaId:imported.asset.media.id},"Voice",secondsToTicks(2));voice.audio.effects=[{id:"delay",type:"delay",enabled:true,version:1,parameters:{delayMs:180,decay:.4}}];
 const first=defaultClip(video.id,{type:"color",color:"#ff0000"},"Red",secondsToTicks(1)),second=defaultClip(video.id,{type:"color",color:"#0000ff"},"Blue",secondsToTicks(1));second.startTick=secondsToTicks(1);
 await store.mutate(2,[...[voice,first,second].map(clip=>({type:"clip.add" as const,sequenceId:sequence.id,clip,mode:"overwrite" as const})),{type:"track.update",sequenceId:sequence.id,trackId:audio.id,patch:{effects:[{id:"compress",type:"compressor",enabled:true,version:1,parameters:{threshold:.1,ratio:3,attack:2,release:900}}]}}]);
 return {root,config,store,sequenceId:sequence.id};
}
integration("exports actual HEVC, GIF, numbered PNG ZIP and existing video codecs for a nonzero range",async()=>{
 const {root,config,store,sequenceId}=await fixture();
 try{
  const range={startTick:secondsToTicks(.5),endTick:secondsToTicks(1.5)};
  for(const [presetId,extension,codec] of [["web-hevc","mp4","hevc"],["animated-gif","gif","gif"],["web-h264-1080p","mp4","h264"],["web-vp9","webm","vp9"],["archive-ffv1","mkv","ffv1"]] as const){
   const output=path.join(root,presetId+"."+extension),result=await renderSequence(store,config,{sequenceId,presetId,outputPath:output,range,videoRangeFrames:15});
   const probe=await probeMedia(output,config);expect(probe.videoCodec).toBe(codec);expect(probe.hasAudio).toBe(extension!=="gif");expect(result.frameCount).toBe(30);
   const packets=JSON.parse((await runChecked(config.ffprobePath,["-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames,r_frame_rate","-of","json",output])).stdout);
   expect(Number(packets.streams[0].nb_read_frames),presetId).toBe(30);
   const cached=await renderSequence(store,config,{sequenceId,presetId,outputPath:output,range,videoRangeFrames:15});expect(cached.cacheHit).toBe(true);expect(cached.range).toEqual(result.range);
  }
  const zip=path.join(root,"frames.zip"),result=await renderSequence(store,config,{sequenceId,presetId:"png-sequence",outputPath:zip,range,videoRangeFrames:15}),entries=storedZipEntries(await readFile(zip));
  expect(entries.size).toBe(31);const manifest=JSON.parse(entries.get("manifest.json")!.toString());expect(manifest.frameCount).toBe(30);expect(manifest.frames[0].sequenceFrame).toBe(15);expect(manifest.frames[29].sequenceFrame).toBe(44);expect(result.artifact).toMatchObject({type:"png-sequence-zip",audioIncluded:false});
  for(const [name,channel] of [["frame-00000001.png",0],["frame-00000030.png",2]] as const){
   const frame=path.join(root,name),rgb=frame+".rgb";await writeFile(frame,entries.get(name)!);await runChecked(config.ffmpegPath,["-v","error","-y","-i",frame,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24",rgb]);const pixels=await readFile(rgb);expect(pixels[channel]!).toBeGreaterThan(240);expect(pixels[(channel+1)%3]!).toBeLessThan(10);
  }
  expect((await renderSequence(store,config,{sequenceId,presetId:"png-sequence",outputPath:zip,range,videoRangeFrames:15})).cacheHit).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
integration("range WAV preserves exact full-program stateful DSP samples and validates boundaries before publication",async()=>{
 const {root,config,store,sequenceId}=await fixture();
 try{
  const full=path.join(root,"full.wav"),part=path.join(root,"range.wav"),range={startTick:secondsToTicks(.5),endTick:secondsToTicks(1.5)};
  await renderSequence(store,config,{sequenceId,presetId:"audio-wav",outputPath:full});await renderSequence(store,config,{sequenceId,presetId:"audio-wav",outputPath:part,range});
  async function pcm(file:string){const target=file+".pcm";await runChecked(config.ffmpegPath,["-v","error","-y","-i",file,"-f","f32le","-c:a","pcm_f32le",target]);return readFile(target);}
  const baseline=await pcm(full),ranged=await pcm(part);expect(ranged.length).toBe(48000*2*4);expect(ranged).toEqual(baseline.subarray(24000*2*4,72000*2*4));
  const prior=await readFile(part);await expect(renderSequence(store,config,{sequenceId,presetId:"audio-wav",outputPath:part,range:{startTick:1,endTick:secondsToTicks(1)}})).rejects.toThrow(/align/);expect(await readFile(part)).toEqual(prior);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
