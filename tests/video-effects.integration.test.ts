import {mkdtemp,readFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {expect,it} from "vitest";import {defaultClip,secondsToTicks} from "@mcp-video-studio/contracts";import {ProjectStore} from "@mcp-video-studio/core";import {loadConfig,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("RGB blend modes preserve the background outside cropped/transformed alpha coverage",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-blend-"));try{
  const store=await ProjectStore.create(path.join(root,"project"),"Blend"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};p.settings.background="#00ff00";},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks[0]!,clip=defaultClip(track.id,{type:"color",color:"#ff0000"},"Red",secondsToTicks(1));
  clip.transform.scale=[.5,.5];clip.blendMode="multiply";clip.crop.left=.2;
  await store.mutate(1,[{type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"}]);
  async function pixels(name:string){const output=path.join(root,name+".mkv");await renderSequence(store,config,{sequenceId:sequence.id,presetId:project.exportPresets.find(p=>p.videoCodec==="ffv1")!.id,outputPath:output});const raw=path.join(root,name+".rgb");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo",raw]);const data=await readFile(raw);return(x:number,y:number)=>[...data.subarray((y*160+x)*3,(y*160+x)*3+3)];}
  let pixel=await pixels("multiply");
  expect(pixel(5,5)[1]).toBeGreaterThan(240);expect(Math.max(...pixel(80,45))).toBeLessThan(10);
  await store.mutate(2,[{type:"clip.update",sequenceId:sequence.id,clipId:clip.id,patch:{blendMode:"screen",transform:{...clip.transform,rotation:90}}}]);
  pixel=await pixels("screen");expect(pixel(5,5)[1]).toBeGreaterThan(240);expect(pixel(80,45)[0]).toBeGreaterThan(240);expect(pixel(80,45)[1]).toBeGreaterThan(240);expect(pixel(80,15)[0]).toBeGreaterThan(240);expect(pixel(40,45)[0]).toBeLessThan(10);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
