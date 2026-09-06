import {open} from "node:fs/promises";import {StudioException} from "@mcp-video-studio/core";import type {MediaProbe} from "@mcp-video-studio/contracts";
/** Bounds-check the OpenType table directory before an installed font decoder sees it. */
export async function probeFont(filePath:string):Promise<MediaProbe>{
 const handle=await open(filePath,"r"),limit=16*1024*1024;
 try{
  const info=await handle.stat();if(!info.isFile()||info.size<12||info.size>limit)throw new StudioException("INVALID_FONT","Import a TrueType/OpenType font smaller than 16 MiB.","input");
  const bytes=Buffer.alloc(info.size+1);let count=0;while(count<bytes.length){const read=await handle.read(bytes,count,bytes.length-count,count);if(!read.bytesRead)break;count+=read.bytesRead;}
  if(count!==info.size)throw new StudioException("FONT_CHANGED","Font changed during validation; retry the import.","conflict");
  const magic=bytes.readUInt32BE(0);if(magic!==0x00010000&&magic!==0x4f54544f)throw new StudioException("INVALID_FONT","Only standalone .ttf/.otf fonts are supported; convert WOFF or font collections first.","input");
  const tables=bytes.readUInt16BE(4);if(tables<1||tables>256||12+tables*16>count)throw new StudioException("INVALID_FONT","Font table directory is invalid.","input");
  const tags=new Set<string>();for(let i=0;i<tables;i++){const pos=12+i*16,tag=bytes.toString("ascii",pos,pos+4),offset=bytes.readUInt32BE(pos+8),length=bytes.readUInt32BE(pos+12);if(tags.has(tag)||offset<12+tables*16||offset+length>count)throw new StudioException("INVALID_FONT","Font tables overlap the directory or exceed the file.","input");tags.add(tag);}
  if(!["head","hhea","maxp","hmtx","cmap","name"].every(tag=>tags.has(tag))||!(tags.has("CFF ")||tags.has("CFF2")||(tags.has("glyf")&&tags.has("loca"))))throw new StudioException("INVALID_FONT","Font is missing required OpenType tables.","input");
  return{durationTick:0,formatName:"opentype",hasVideo:false,hasAudio:false};
 }finally{await handle.close();}
}
