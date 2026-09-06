import {mkdtemp,rm,readFile} from "node:fs/promises";
import os from "node:os";import path from "node:path";import {expect,it} from "vitest";
import {TICKS_PER_SECOND,defaultClip,framesToTicks,type Rational} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";
import {importMedia,loadConfig,runChecked} from "@mcp-video-studio/media";
import {renderSequence} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration.each([{numerator:12,denominator:1},{numerator:24,denominator:1},{numerator:30000,denominator:1001}] satisfies Rational[])("preserves encoded packet counts and rational timestamps through cached H264 ranges at $numerator/$denominator fps",async fps=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-video-timing-"));
 try{
  const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),store=await ProjectStore.create(path.join(root,"project"),"Timing"),frameCount=31,rate=fps.numerator+"/"+fps.denominator;
  await store.replace(0,p=>{p.settings.raster={width:96,height:64};p.settings.fps=fps;},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const input=path.join(root,"source.mkv");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","testsrc2=s=96x64:r="+rate,"-frames:v",String(frameCount+4),"-c:v","ffv1",input]);
  const imported=await importMedia(store,input,"managed",1,config),project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks.find(t=>t.type==="video")!;
  await store.mutate(2,[{type:"clip.add",sequenceId:sequence.id,clip:defaultClip(track.id,{type:"media",mediaId:imported.asset.media.id},"Frames",framesToTicks(frameCount,fps)),mode:"overwrite"}]);
  for(const videoRangeFrames of [0,7]){
   const output=path.join(root,"range-"+videoRangeFrames+".mp4");
   await renderSequence(store,config,{sequenceId:sequence.id,presetId:"web-h264-1080p",outputPath:output,videoRangeFrames});
   const data=JSON.parse((await runChecked(config.ffprobePath,["-v","error","-count_frames","-count_packets","-select_streams","v:0","-show_entries","stream=avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,nb_read_packets,duration,time_base","-of","json",output])).stdout) as {streams:Array<Record<string,string>>},stream=data.streams[0]!;
   expect(Number(stream.nb_frames)).toBe(frameCount);expect(Number(stream.nb_read_frames)).toBe(frameCount);expect(Number(stream.nb_read_packets)).toBe(frameCount);
   for(const key of ["avg_frame_rate","r_frame_rate"]){const [numerator,denominator]=stream[key]!.split("/").map(Number);expect(numerator!*fps.denominator).toBe(fps.numerator*denominator!);}
   const packets=(JSON.parse((await runChecked(config.ffprobePath,["-v","error","-select_streams","v:0","-show_packets","-show_entries","packet=pts,duration","-of","json",output])).stdout) as {packets:Array<{pts:number;duration:number}>}).packets.sort((a,b)=>a.pts-b.pts);
   const [clockNumerator,clockDenominator]=stream.time_base!.split("/").map(Number);expect(packets).toHaveLength(frameCount);
   for(let index=0;index<packets.length;index++){const packet=packets[index]!;expect(packet.pts*clockNumerator!*fps.numerator).toBe(index*fps.denominator*clockDenominator!);expect(packet.duration*clockNumerator!*fps.numerator).toBe(fps.denominator*clockDenominator!);}
   // Assert the muxed movie clock itself can represent every requested frame duration exactly.
   const container=await readFile(output),mvhd=container.indexOf(Buffer.from("mvhd"));expect(mvhd).toBeGreaterThan(0);
   const version=container[mvhd+4]!,movieTimescale=container.readUInt32BE(mvhd+(version===1?24:16));expect(movieTimescale).toBe(TICKS_PER_SECOND);
   expect(Math.abs(Number(stream.duration)-frameCount*fps.denominator/fps.numerator)).toBeLessThan(.00001);
   const raw=output+".rgb";await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-map","0:v:0","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo",raw]);expect((await readFile(raw)).length).toBe(frameCount*96*64*3);
   console.log("VIDEO_OUTPUT_TIMING",JSON.stringify({fps,videoRangeFrames,expectedFrames:frameCount,...stream}));
  }
  const lossless:Buffer[]=[];
  for(const videoRangeFrames of [0,7]){const output=path.join(root,"lossless-"+videoRangeFrames+".mkv"),raw=output+".rgb";await renderSequence(store,config,{sequenceId:sequence.id,presetId:"archive-ffv1",outputPath:output,videoRangeFrames});await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-map","0:v:0","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo",raw]);lossless.push(await readFile(raw));}
  expect(lossless[0]!.length).toBe(frameCount*96*64*3);expect(lossless[1]!.equals(lossless[0]!)).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
},90000);
