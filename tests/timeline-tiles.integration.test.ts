import {mkdtemp,readFile,rm,stat,utimes,readdir} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";
import {ProjectStore} from "@mcp-video-studio/core";
import {TimelineTiles,loadConfig,runChecked,importMedia} from "@mcp-video-studio/media";
import {StudioRuntime} from "../packages/server/src/runtime.js";import {startGateway} from "../packages/server/src/gateway.js";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("actual multi-scale timeline tiles contain source-time pixels/waveforms, reuse cache, enforce boundaries and await cancellation",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-tiles-")),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"}),store=await ProjectStore.create(path.join(root,"project"),"Tiles"),service=new TimelineTiles(config);
 const runtime=new StudioRuntime(config);await runtime.initialize();const token="tile-fixture-0123456789-0123456789",gateway=await startGateway(runtime,token);
 try{
  const video=path.join(root,"colors.mkv"),audio=path.join(root,"levels.wav");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","color=red:s=160x90:r=30:d=4","-f","lavfi","-i","color=blue:s=160x90:r=30:d=4","-filter_complex","[0:v][1:v]concat=n=2:v=1:a=0","-c:v","ffv1",video],{timeoutMs:10000});
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","sine=frequency=220:sample_rate=48000:duration=4","-f","lavfi","-i","anullsrc=r=48000:cl=mono:d=4","-filter_complex","[0:a][1:a]concat=n=2:v=0:a=1","-c:a","pcm_s16le",audio],{timeoutMs:10000});
  const videoAsset=(await importMedia(store,video,"linked",0,config)).asset.media,audioAsset=(await importMedia(store,audio,"managed",1,config)).asset.media;
  const image=async(kind:"timeline-thumbnail"|"timeline-waveform",spanSeconds:number,index:number)=>service.get(store,kind==="timeline-thumbnail"?videoAsset:audioAsset,{kind,spanSeconds,index});
  const [red,same]=await Promise.all([image("timeline-thumbnail",4,0),image("timeline-thumbnail",4,0)]);expect(red).toBe(same);
  const bytes=await readFile(red);const again=await image("timeline-thumbnail",4,0);expect(await readFile(again)).toEqual(bytes);
  const pixel=async(file:string,x:number)=>{const raw=path.join(root,"sample.rgb");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",file,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo",raw],{timeoutMs:10000});const data=await readFile(raw);expect(data.length).toBe(320*45*3);return [...data.subarray((22*320+x)*3,(22*320+x)*3+3)];};
  expect((await pixel(red,20))[0]).toBeGreaterThan(240);
  expect((await pixel(await image("timeline-thumbnail",4,1),20))[2]).toBeGreaterThan(240);
  const overview=await image("timeline-thumbnail",8,0);expect((await pixel(overview,20))[0]).toBeGreaterThan(240);expect((await pixel(overview,260))[2]).toBeGreaterThan(240);
  const loud=await image("timeline-waveform",4,0),silent=await image("timeline-waveform",4,1);expect(await readFile(loud)).not.toEqual(await readFile(silent));
  await expect(image("timeline-thumbnail",3,0)).rejects.toThrow("Invalid tile");await expect(image("timeline-thumbnail",4,2)).rejects.toThrow("beyond");
  const url=new URL("/media",gateway.origin);url.search=new URLSearchParams({projectPath:store.root,mediaId:videoAsset.id,kind:"timeline-thumbnail",spanSeconds:"4",index:"0"}).toString();
  expect((await fetch(url)).status).toBe(401);url.searchParams.set("token",token);expect((await fetch(url,{headers:{Origin:"https://evil.example"}})).status).toBe(403);
  const response=await fetch(url);expect(response.status).toBe(200);expect(response.headers.get("content-type")).toBe("image/png");expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  url.searchParams.set("index","-1");expect((await fetch(url)).status).toBe(400);
  const controller=new AbortController(),cancelled=service.get(store,videoAsset,{kind:"timeline-thumbnail",spanSeconds:.5,index:2},controller.signal);controller.abort();await expect(cancelled).rejects.toThrow();await service.close();
  const entries=await readdir(path.join(store.root,"cache","timeline-tiles"));expect(entries.every(file=>!file.endsWith(".tmp.png"))).toBe(true);
  await expect(image("timeline-thumbnail",4,0)).rejects.toThrow("closed");
  const modified=new TimelineTiles(config);try{const info=await stat(video);await utimes(video,new Date(),new Date(info.mtimeMs+10000));await expect(modified.get(store,videoAsset,{kind:"timeline-thumbnail",spanSeconds:4,index:0})).rejects.toThrow("Media changed");}finally{await modified.close();}
 }finally{await service.close();await gateway.close();await runtime.jobs.close();await rm(root,{recursive:true,force:true});}
},60000);
