import {mkdtemp,readFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";import {expect,it} from "vitest";
import {defaultClip,secondsToTicks,framesToTicks,type Transition} from "@mcp-video-studio/contracts";import {ProjectStore} from "@mcp-video-studio/core";import {loadConfig,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("centered crossfade and wipe render the actual cut without a dark dip or duration change",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-transition-"));try{
  const store=await ProjectStore.create(path.join(root,"project"),"Transition"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks[0]!;
  const first=defaultClip(track.id,{type:"color",color:"#ff0000"},"Red",secondsToTicks(1)),second=defaultClip(track.id,{type:"color",color:"#0000ff"},"Blue",secondsToTicks(1));second.startTick=secondsToTicks(1);
  const transition:Transition={id:"cut",sequenceId:sequence.id,fromClipId:first.id,toClipId:second.id,type:"crossfade",durationTick:framesToTicks(12,project.settings.fps),parameters:{}};
  await store.mutate(1,[{type:"clip.add",sequenceId:sequence.id,clip:first,mode:"overwrite"},{type:"clip.add",sequenceId:sequence.id,clip:second,mode:"overwrite"},{type:"transition.add",sequenceId:sequence.id,transition}]);
  async function frame(name:string){const output=path.join(root,name+".mkv"),result=await renderSequence(store,config,{sequenceId:sequence.id,presetId:project.exportPresets.find(p=>p.videoCodec==="ffv1")!.id,outputPath:output});expect(result.frameCount).toBe(60);const raw=path.join(root,name+".rgb");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-vf","select=eq(n\\,30)","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo",raw]);const data=await readFile(raw);return(x:number)=>[...data.subarray((45*160+x)*3,(45*160+x)*3+3)];}
  let pixel=await frame("crossfade");const middle=pixel(80);expect(middle[0]).toBeGreaterThan(110);expect(middle[0]).toBeLessThan(145);expect(middle[2]).toBeGreaterThan(110);expect(middle[2]).toBeLessThan(145);
  await store.mutate(2,[{type:"transition.update",sequenceId:sequence.id,transitionId:transition.id,patch:{type:"wipeleft"}}]);pixel=await frame("wipe");expect(pixel(10)[2]).toBeGreaterThan(240);expect(pixel(140)[0]).toBeGreaterThan(240);
  expect((await store.read()).sequences[0]!.clips.map(clip=>[clip.startTick,clip.durationTick])).toEqual([[0,secondsToTicks(1)],[secondsToTicks(1),secondsToTicks(1)]]);
  await expect(store.mutate(3,[{type:"transition.update",sequenceId:sequence.id,transitionId:transition.id,patch:{type:"toString"}}])).rejects.toThrow("Supported transitions");
  expect((await store.read()).revision).toBe(3);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
