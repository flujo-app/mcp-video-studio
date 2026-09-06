import {mkdtemp,readFile,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";import {expect,it} from "vitest";
import {defaultClip,defaultTrack,secondsToTicks,type Sequence} from "@mcp-video-studio/contracts";import {ProjectStore,sequenceDependencies} from "@mcp-video-studio/core";import {importMedia,loadConfig,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("nested sequences render real AV, invalidate parent caches and preserve atomic cycle/source boundaries",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-nested-sequence-"));try{
  const store=await ProjectStore.create(path.join(root,"project"),"Nested sequences"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};p.settings.fps={numerator:10,denominator:1};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const source=path.join(root,"source.wav");await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","1","-c:a","pcm_s24le",source]);const imported=await importMedia(store,source,"managed",1,config);
  const project=await store.read(),parent=project.sequences[0]!,id="child",videoTrack=defaultTrack(id,"video",0),audioTrack=defaultTrack(id,"audio",1);
  const color=defaultClip(videoTrack.id,{type:"color",color:"#ff0000"},"Child red",secondsToTicks(1)),audio=defaultClip(audioTrack.id,{type:"media",mediaId:imported.asset.media.id},"Child tone",secondsToTicks(1));
  const child:Sequence={id,name:"Child",tracks:[videoTrack,audioTrack],clips:[color,audio],transitions:[],automation:[],markers:[],captions:[]};
  const slow=defaultClip(parent.tracks[0]!.id,{type:"sequence",sequenceId:id},"Slowed child",secondsToTicks(2));slow.playbackRate={numerator:1,denominator:2};slow.transform.scale=[.5,.5];
  const normal=defaultClip(parent.tracks[0]!.id,{type:"sequence",sequenceId:id},"Child again",secondsToTicks(1));normal.startTick=secondsToTicks(2);
  await store.mutate(2,[{type:"sequence.add",sequence:child},{type:"clip.add",sequenceId:parent.id,clip:slow,mode:"overwrite"},{type:"clip.add",sequenceId:parent.id,clip:normal,mode:"overwrite"},{type:"sequence.activate",sequenceId:id},{type:"sequence.rename",sequenceId:id,name:"Reusable child"}]);
  expect((await store.read()).activeSequenceId).toBe(id);expect(sequenceDependencies(await store.read(),parent.id).media.has(imported.asset.media.id)).toBe(true);
  const first=path.join(root,"first.mkv"),options={sequenceId:parent.id,presetId:"archive-ffv1",videoRangeFrames:10};
  const rendered=await renderSequence(store,config,{...options,outputPath:first});expect(rendered.frameCount).toBe(30);
  const pixels=path.join(root,"first.rgba"),pcm=path.join(root,"first.f32");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",first,"-map","0:v:0","-pix_fmt","rgba","-f","rawvideo",pixels]);await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",first,"-map","0:a:0","-f","f32le",pcm]);const bytes=await readFile(pixels),samples=await readFile(pcm);expect(bytes.length).toBe(30*160*90*4);expect(bytes[(45*160+80)*4]).toBeGreaterThan(240);expect(bytes[0]).toBeLessThan(10);let signal=0;for(let i=samples.length-48000*8;i<samples.length;i+=4)signal+=samples.readFloatLE(i)**2;expect(signal).toBeGreaterThan(10);
  await store.mutate(3,[{type:"clip.update",sequenceId:id,clipId:color.id,patch:{transform:{...color.transform,opacity:.5}}}]);
  const updated=await renderSequence(store,config,{...options,outputPath:path.join(root,"updated.mkv")});expect(updated.renderKey).not.toBe(rendered.renderKey);expect((updated.videoRanges as Array<{cacheHit:boolean}>).every(range=>!range.cacheHit)).toBe(true);
  const updatePixels=path.join(root,"updated.rgba");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",path.join(root,"updated.mkv"),"-map","0:v:0","-pix_fmt","rgba","-f","rawvideo",updatePixels]);const updatedBytes=await readFile(updatePixels);expect(updatedBytes[(45*160+80)*4]).toBeGreaterThan(100);expect(updatedBytes[(45*160+80)*4]).toBeLessThan(160);
  const wav=await renderSequence(store,config,{sequenceId:parent.id,presetId:"audio-wav",outputPath:path.join(root,"nested.wav")});expect(wav.durationTick).toBe(secondsToTicks(3));expect((wav.probe as{hasAudio:boolean;hasVideo:boolean})).toMatchObject({hasAudio:true,hasVideo:false});
  const cycle=defaultClip(videoTrack.id,{type:"sequence",sequenceId:parent.id},"Cycle",secondsToTicks(1));await expect(store.mutate(4,[{type:"clip.add",sequenceId:id,clip:cycle,mode:"overwrite"}])).rejects.toThrow(/Nested sequences cannot/);expect((await store.read()).revision).toBe(4);
  await expect(store.mutate(4,[{type:"clip.update",sequenceId:parent.id,clipId:slow.id,patch:{sourceInTick:secondsToTicks(1)}}])).rejects.toThrow(/source media/);
  await expect(store.mutate(4,[{type:"sequence.remove",sequenceId:id}])).rejects.toThrow(/references/);
  await store.undo(4);const undone=await store.read();expect(undone.sequences.find(sequence=>sequence.id===id)!.clips.find(clip=>clip.id===color.id)!.transform.opacity).toBe(1);await store.redo(undone.revision);
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
