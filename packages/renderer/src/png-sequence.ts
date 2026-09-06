import {createHash} from "node:crypto";
import {createReadStream,createWriteStream} from "node:fs";
import {lstat,open,readdir,rm,stat,statfs} from "node:fs/promises";
import path from "node:path";
import {Transform,type Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {ZipFile} from "yazl";
import {StudioException,sha256File} from "@mcp-video-studio/core";
import type {ProjectSettings} from "@mcp-video-studio/contracts";
import type {ResolvedExportRange} from "./export-range.js";

export const MAX_PNG_SEQUENCE_FRAMES=100000;
const MAX_PNG_BYTES=512*1024*1024;
const ZIP_TIMESTAMP=new Date("2000-01-01T00:00:00Z");
export function pngFrameName(index:number):string {
 if(!Number.isSafeInteger(index)||index<1||index>MAX_PNG_SEQUENCE_FRAMES)throw new StudioException("PNG_SEQUENCE_LIMIT","A PNG ZIP export supports 1–100,000 frames; choose a shorter export range.","input");
 return `frame-${String(index).padStart(8,"0")}.png`;
}
export interface PngFrame {file:string;bytes:number;sha256:string;sequenceFrame:number}
export interface PngSequenceManifest {
 version:1;type:"png-sequence";fps:ProjectSettings["fps"];raster:ProjectSettings["raster"];range:ResolvedExportRange;audioIncluded:false;frameCount:number;frames:PngFrame[];
}
/** Packages only engine-generated numbered regular PNGs; paths from external manifests are never consumed. */
export async function writePngSequenceZip(directory:string,outputPath:string,settings:ProjectSettings,range:ResolvedExportRange,signal?:AbortSignal,options:{forceZip64Format?:boolean}={}):Promise<{manifest:PngSequenceManifest;bytes:number}> {
 const count=range.frameCount;
 pngFrameName(count);
 const entries=await readdir(directory,{withFileTypes:true});
 if(entries.length!==count)throw new StudioException("PNG_SEQUENCE_INCOMPLETE","Rendered PNG frame count differs from the requested range.","runtime",{expected:count,actual:entries.length});
 const frames:PngFrame[]=[];
 for(let index=1;index<=count;index++){
  signal?.throwIfAborted();
  const file=pngFrameName(index),filePath=path.join(directory,file),info=await lstat(filePath);
  if(!info.isFile()||info.isSymbolicLink()||info.size<33||info.size>MAX_PNG_BYTES)throw new StudioException("INVALID_PNG_FRAME","Frame must be a bounded regular PNG file.","runtime",{file});
  const handle=await open(filePath,"r");
  try{
   const header=Buffer.alloc(24);await handle.read(header,0,24,0);
   if(!header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||header.toString("ascii",12,16)!=="IHDR"||header.readUInt32BE(16)!==settings.raster.width||header.readUInt32BE(20)!==settings.raster.height)
    throw new StudioException("INVALID_PNG_FRAME","Frame signature or dimensions do not match the export.","runtime",{file});
  }finally{await handle.close();}
  frames.push({file,bytes:info.size,sha256:(await sha256File(filePath,signal)).sha256,sequenceFrame:range.startFrame+index-1});
 }
 const manifest:PngSequenceManifest={version:1,type:"png-sequence",fps:settings.fps,raster:settings.raster,range,audioIncluded:false,frameCount:count,frames};
 const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+"\n");
 const estimated=frames.reduce((sum,frame)=>sum+frame.bytes+256,manifestBytes.length+1024);
 const disk=await statfs(path.dirname(outputPath));
 if(disk.bavail*disk.bsize<estimated+64*1024*1024)throw new StudioException("INSUFFICIENT_DISK","PNG archive requires additional scratch space while retaining its generated frames.","runtime",{requiredBytes:estimated+64*1024*1024});
 const zip=new ZipFile(),output=createWriteStream(outputPath,{flags:"wx",mode:0o600});
 const outputStream=zip.outputStream as Readable;
 let active:ReturnType<typeof createReadStream>|undefined;
 const abort=()=>{active?.destroy(new Error("PNG sequence cancelled."));outputStream.destroy(new Error("PNG sequence cancelled."));};
 const failed=(error:Error)=>{active?.destroy(error);outputStream.destroy(error);};
 zip.on("error",failed);signal?.addEventListener("abort",abort,{once:true});
 const completed=pipeline(zip.outputStream,output,...(signal?[{signal}]:[]));
 // Install a rejection observer immediately; the awaited promise still propagates the original failure.
 completed.catch(()=>undefined);
 try{
  for(const frame of frames){
   zip.addReadStreamLazy(frame.file,{size:frame.bytes,compress:false,mtime:ZIP_TIMESTAMP,mode:0o100644},callback=>{
    if(signal?.aborted||outputStream.destroyed){callback(new Error("PNG sequence cancelled."),undefined!);return;}
    const input=createReadStream(path.join(directory,frame.file));active=input;
    const hash=createHash("sha256");
    const verified=new Transform({
     transform(chunk:Buffer,_encoding,next){hash.update(chunk);next(null,chunk);},
     flush(next){next(hash.digest("hex")===frame.sha256?null:new Error("PNG frame changed while packaging."));}
    });
    input.once("error",error=>verified.destroy(error));verified.once("error",error=>failed(error));input.pipe(verified);callback(null,verified);
   });
  }
  zip.addBuffer(manifestBytes,"manifest.json",{compress:false,mtime:ZIP_TIMESTAMP,mode:0o100644});
  zip.end({comment:"",forceZip64Format:options.forceZip64Format??false});
  await completed;
  return {manifest,bytes:(await stat(outputPath)).size};
 }catch(error){abort();await completed.catch(()=>undefined);await rm(outputPath,{force:true});throw error;}
 finally{signal?.removeEventListener("abort",abort);zip.removeListener("error",failed);}
}
