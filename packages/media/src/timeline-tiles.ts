import {createHash} from "node:crypto";
import {mkdir,readdir,rm,stat,utimes} from "node:fs/promises";
import path from "node:path";
import {ticksToSeconds,type MediaAsset} from "@mcp-video-studio/contracts";
import {confinedPath,ProjectStore,StudioException} from "@mcp-video-studio/core";
import {ffmpegArtifact} from "./artifacts.js";
import {mediaPath} from "./assets.js";
import type {StudioConfig} from "./config.js";
export type TimelineTileKind="timeline-thumbnail"|"timeline-waveform";
export interface TimelineTileRequest{kind:TimelineTileKind;spanSeconds:number;index:number}
interface Pending {controller:AbortController;promise:Promise<string>;users:number;run():void;reject(error:unknown):void}
/** Two decoders, at most 32 unique requests, 30s total deadlines and 256 cached PNGs per project. */
export class TimelineTiles{
 private closed=false;private active=0;private entries=new Map<string,Pending>();private queue:Pending[]=[];
 constructor(private readonly config:StudioConfig){}
 async get(store:ProjectStore,media:MediaAsset,request:TimelineTileRequest,signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();
  const {kind,spanSeconds,index}=request;
  if(this.closed)throw new StudioException("CANCELLED","Timeline tile service is closed.","runtime");
  if(!["timeline-thumbnail","timeline-waveform"].includes(kind)||![.5,1,2,4,8,16,32].includes(spanSeconds)||!Number.isSafeInteger(index)||index<0||index*spanSeconds>86400)throw new StudioException("INVALID_TILE","Invalid tile kind, scale or source range.","input");
  if(kind==="timeline-waveform"?!media.probe.hasAudio:!media.probe.hasVideo)throw new StudioException("INVALID_TILE","This media has no matching stream.","input");
  const start=media.kind==="image"?0:index*spanSeconds,duration=ticksToSeconds(media.probe.durationTick);
  if(media.kind!=="image"&&start>=duration)throw new StudioException("INVALID_TILE","Tile starts beyond the media duration.","input");
  const source=mediaPath(store,media),info=await stat(source);
  if(!info.isFile()||info.size!==media.storage.bytes||(media.storage.mode==="linked"&&Math.abs(info.mtimeMs-media.storage.mtimeMs)>1))throw new StudioException("MEDIA_CHANGED","Media changed; inspect and relink it before rebuilding tiles.","conflict");
  const key=createHash("sha256").update(JSON.stringify([3,media.storage.sha256,info.size,info.mtimeMs,kind,spanSeconds,start])).digest("hex");
  const directory=confinedPath(store.root,path.join(store.root,"cache","timeline-tiles")),output=confinedPath(store.root,path.join(directory,key+".png"));
  signal?.throwIfAborted();if(this.closed)throw new StudioException("CANCELLED","Timeline tile service is closed.","runtime");
  if(await stat(output).then(s=>s.isFile()).catch(()=>false)){await utimes(output,new Date(),new Date()).catch(()=>undefined);return output;}
  let entry=this.entries.get(output);
  if(!entry){
   if(this.entries.size>=32)throw new StudioException("TILE_QUEUE_FULL","Timeline tile queue is full; retry after scrolling settles.","runtime");
   const controller=new AbortController();let resolve!:(file:string)=>void,reject!:(error:unknown)=>void;
   const promise=new Promise<string>((yes,no)=>{resolve=yes;reject=no;});
   const pending:Pending={controller,promise,users:0,reject,run:()=>{void(async()=>{
    const timer=setTimeout(()=>controller.abort(),30000);timer.unref();
    try{
     controller.signal.throwIfAborted();await mkdir(directory,{recursive:true});
     const input=media.kind==="image"?["-loop","1","-i",source]:["-ss",String(start),"-t",String(Math.min(spanSeconds,duration-start)),"-i",source];
     const filter=kind==="timeline-waveform"?
      ["-filter_complex",`aformat=channel_layouts=mono,apad=whole_dur=${spanSeconds},atrim=duration=${spanSeconds},showwavespic=s=320x45:colors=4cc9f0`]:
      ["-vf",`fps=${4/spanSeconds}:start_time=0,scale=80:45:force_original_aspect_ratio=decrease,pad=80:45:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop_duration=${spanSeconds},tile=4x1`];
     await ffmpegArtifact(this.config,["-threads","1",...input,...filter,"-frames:v","1","-an","-threads","1"],output,{signal:controller.signal,timeoutMs:15000,maxOutputChars:4000});
     controller.signal.throwIfAborted();
     // Files in this dedicated derived-data directory have no authored content.
     const cached=await Promise.all((await readdir(directory)).filter(n=>/^[a-f0-9]{64}\.png$/.test(n)).map(async name=>({name,time:(await stat(path.join(directory,name)).catch(()=>undefined))?.mtimeMs??0})));
     cached.sort((a,b)=>b.time-a.time);await Promise.all(cached.slice(256).filter(f=>path.join(directory,f.name)!==output&&!this.entries.has(path.join(directory,f.name))).map(f=>rm(path.join(directory,f.name),{force:true})));
     resolve(output);
    }catch(error){reject(controller.signal.aborted?new StudioException("CANCELLED","Timeline tile request was cancelled.","runtime"):error);}
    finally{clearTimeout(timer);this.entries.delete(output);this.active--;this.pump();}
   })();}};
   entry=pending;this.entries.set(output,pending);this.queue.push(pending);
   // Include queue time in the bound; cleanup is awaited by close().
   const deadline=setTimeout(()=>controller.abort(),30000);deadline.unref();void promise.then(()=>clearTimeout(deadline),()=>clearTimeout(deadline));
   this.pump();
  }
  entry.users++;
  const current=entry;let abort:(()=>void)|undefined;
  try{return await(signal?Promise.race([current.promise,new Promise<never>((_,reject)=>{abort=()=>reject(new StudioException("CANCELLED","Timeline tile request was cancelled.","runtime"));signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]):current.promise);}
  finally{if(abort)signal?.removeEventListener("abort",abort);current.users--;if(current.users===0&&this.entries.get(output)===current)current.controller.abort();}
 }
 private pump(){while(this.active<2&&this.queue.length){const next=this.queue.shift()!;this.active++;next.run();}}
 async close(){this.closed=true;const pending=[...this.entries.values()];for(const entry of pending)entry.controller.abort();await Promise.allSettled(pending.map(entry=>entry.promise));}
}
