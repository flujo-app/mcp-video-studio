import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";import {defaultClip,secondsToTicks} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";import {importMedia,loadConfig,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration.each([false,true])("video ranges preserve exact frames and continuous audio (captions: %s)",async(withCaptions)=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-ranges-"));try{
  const store=await ProjectStore.create(path.join(root,"project"),"Ranges"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const source=path.join(root,"source.mkv");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","testsrc2=s=160x90:r=30","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","4","-c:v","ffv1","-c:a","pcm_s24le",source]);
  const imported=await importMedia(store,source,"managed",1,config),project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks[0]!,captionTrack=sequence.tracks.find(t=>t.type==="caption")!;
  const first=defaultClip(track.id,{type:"media",mediaId:imported.asset.media.id},"First",secondsToTicks(2));first.sourceInTick=secondsToTicks(1);
  const second={...structuredClone(first),id:crypto.randomUUID(),name:"Second",startTick:secondsToTicks(2)};second.transform.rotation=10;second.transform.scale=[.8,.8];
  await store.mutate(2,[{type:"clip.add",sequenceId:sequence.id,clip:first,mode:"overwrite"},{type:"clip.add",sequenceId:sequence.id,clip:second,mode:"overwrite"},
   {type:"transition.add",sequenceId:sequence.id,transition:{id:"cut",sequenceId:sequence.id,fromClipId:first.id,toClipId:second.id,type:"crossfade",durationTick:secondsToTicks(.4),parameters:{}}},
   ...(withCaptions?[{type:"caption.add" as const,sequenceId:sequence.id,caption:{id:"caption",trackId:captionTrack.id,startTick:secondsToTicks(.5),durationTick:secondsToTicks(2.5),text:"Range boundary",style:{fontFamily:"Arial",fontSize:12,color:"#ffffff",background:"#000000aa",align:"center" as const,position:"bottom" as const}}}]:[]),
   {type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{effects:[{id:"compressor",type:"compressor",version:1,enabled:true,parameters:{threshold:.05,ratio:4,attack:20,release:500}}]}}
  ]);
  const whole=path.join(root,"whole.mkv"),ranged=path.join(root,"ranged.mkv");
  await renderSequence(store,config,{sequenceId:sequence.id,presetId:"archive-ffv1",outputPath:whole,videoRangeFrames:0});
  const result=await renderSequence(store,config,{sequenceId:sequence.id,presetId:"archive-ffv1",outputPath:ranged,videoRangeFrames:30});
  expect((result.videoRanges as unknown[]).length).toBe(4);
  for(const [name,flags] of [["video",["-map","0:v:0","-pix_fmt","yuv420p","-f","rawvideo"]],["audio",["-map","0:a:0","-f","f32le"]]] as const){
   const decoded:Buffer[]=[];
   for(const file of [whole,ranged]){const raw=file+"."+name;await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",file,...flags,raw]);decoded.push(await readFile(raw));}
   expect(decoded[0]!.length).toBe(name==="audio"?192000*2*4:120*160*90*3/2);
   expect(decoded[1]!.length).toBe(decoded[0]!.length);
   if(name==="audio"){
    let maximum=0;
    for(let index=0;index<decoded[0]!.length;index+=4)maximum=Math.max(maximum,Math.abs(decoded[0]!.readFloatLE(index)-decoded[1]!.readFloatLE(index)));
    // One 24-bit PCM least-significant bit accommodates final integer rounding.
    expect(maximum).toBeLessThanOrEqual(1/8388608);
   }else expect(decoded[1]!.equals(decoded[0]!)).toBe(true);
  }
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
integration("one-clip edit invalidates only its video ranges with unchanged earlier frames",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-range-invalidation-"));try{
  const store=await ProjectStore.create(path.join(root,"project"),"Cache"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks[0]!;
  const clips=["#ff0000","#00ff00","#0000ff"].map((color,index)=>({...defaultClip(track.id,{type:"color" as const,color},"Clip "+index,secondsToTicks(2)),startTick:secondsToTicks(index*2)}));
  await store.mutate(1,clips.map(clip=>({type:"clip.add" as const,sequenceId:sequence.id,clip,mode:"overwrite" as const})));
  const options={sequenceId:sequence.id,presetId:"archive-ffv1",videoRangeFrames:30};
  const first=await renderSequence(store,config,{...options,outputPath:path.join(root,"first.mkv")});
  await store.mutate(2,[{type:"clip.update",sequenceId:sequence.id,clipId:clips[2]!.id,patch:{transform:{...clips[2]!.transform,opacity:.5}}}]);
  const second=await renderSequence(store,config,{...options,outputPath:path.join(root,"second.mkv")});
  const a=first.videoRanges as Array<{renderKey:string}>,b=second.videoRanges as Array<{cacheHit:boolean;renderKey:string}>;
  expect(second.audioCache).toMatchObject({cacheHit:true});
  expect(b.map(range=>range.cacheHit)).toEqual([true,true,true,true,false,false]);expect(b.slice(0,4).map(r=>r.renderKey)).toEqual(a.slice(0,4).map(r=>r.renderKey));
  await writeFile(path.join(store.root,"cache","renders","video-"+b[0]!.renderKey+".mkv"),"corrupt range");
  await store.mutate(3,[{type:"track.update",sequenceId:sequence.id,trackId:sequence.tracks.find(t=>t.type==="audio")!.id,patch:{gainDb:-6}}]);
  const repaired=await renderSequence(store,config,{...options,outputPath:path.join(root,"repaired.mkv")});
  expect((repaired.videoRanges as Array<{cacheHit:boolean}>).map(range=>range.cacheHit)).toEqual([false,true,true,true,true,true]);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);

integration("corrupt final cache never overwrites an existing export when regeneration fails",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-cache-publication-"));try{
  const store=await ProjectStore.create(path.join(root,"project"),"Publication"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const project=await store.read(),sequence=project.sequences[0]!;
  await store.mutate(1,[{type:"clip.add",sequenceId:sequence.id,clip:defaultClip(sequence.tracks[0]!.id,{type:"color",color:"#ff0000"},"Red",secondsToTicks(1)),mode:"overwrite"}]);
  const output=path.join(root,"existing.mp4"),options={sequenceId:sequence.id,presetId:"web-h264-1080p",outputPath:output};
  const result=await renderSequence(store,config,options),before=await readFile(output);
  await writeFile(String(result.cachePath),"corrupt final render");
  await expect(renderSequence(store,{...config,ffmpegPath:path.join(root,"missing-ffmpeg")},options)).rejects.toThrow();
  expect((await readFile(output)).equals(before)).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
},30000);
