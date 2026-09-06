import {mkdtemp,rm,readFile} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";import {createDefaultProject,defaultClip,secondsToTicks} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";import {loadConfig,importMedia,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("a nested final mix bus survives rendering and invalidates its parent's continuous audio cache",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-nested-audio-master-"));
 try{
  const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),store=await ProjectStore.create(path.join(root,"project"),"Nested audio bus");
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const source=path.join(root,"tone.wav");await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=2",source]);
  const imported=await importMedia(store,source,"managed",1,config),p=await store.read(),parent=p.sequences[0]!,child=createDefaultProject("child").sequences[0]!,audio=child.tracks.find(t=>t.type==="audio")!;
  child.clips.push(defaultClip(audio.id,{type:"media",mediaId:imported.asset.media.id},"Tone",secondsToTicks(2)));child.audioMaster={gainDb:0,pan:0,effects:[]};
  await store.mutate(2,[{type:"sequence.add",sequence:child},{type:"clip.add",sequenceId:parent.id,clip:defaultClip(parent.tracks[0]!.id,{type:"sequence",sequenceId:child.id},"Nested tone",secondsToTicks(2)),mode:"overwrite"}]);
  async function amplitude(name:string){const file=path.join(root,name+".mkv");await renderSequence(store,config,{sequenceId:parent.id,presetId:"archive-ffv1",outputPath:file,videoRangeFrames:15});const pcm=path.join(root,name+".f32");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",file,"-map","0:a","-f","f32le","-c:a","pcm_f32le",pcm]);const b=await readFile(pcm);let sum=0;for(let i=0;i<b.length;i+=4)sum+=b.readFloatLE(i)**2;return Math.sqrt(sum/(b.length/4));}
  const before=await amplitude("before");await store.mutate(3,[{type:"audio.master.set",sequenceId:child.id,master:{gainDb:-12,pan:0,effects:[]}}]);const after=await amplitude("after");
  expect(after/before).toBeCloseTo(10**(-12/20),5);
  await store.mutate(4,[{type:"audio.master.set",sequenceId:child.id,master:{gainDb:0,pan:0,effects:[{id:"norm",type:"loudness",parameters:{},enabled:true,version:1}]}},{type:"track.update",sequenceId:child.id,trackId:audio.id,patch:{effects:[{id:"norm2",type:"loudness",parameters:{},enabled:true,version:1}]}}]);
  await expect(renderSequence(store,config,{sequenceId:child.id,presetId:"audio-wav",outputPath:path.join(root,"duplicate.wav")})).rejects.toThrow(/final mix/);
 }finally{await rm(root,{recursive:true,force:true});}
},90000);
