import {createHash} from 'node:crypto';import {constants} from 'node:fs';

import {open} from 'node:fs/promises';
import {StudioException} from '@mcp-video-studio/core';
import type {MediaProbe} from '@mcp-video-studio/contracts';
export const MAX_CUBE_BYTES=16*1024*1024;
function invalid(message:string):never{throw new StudioException('INVALID_LUT',message,'input');}
/** A deliberately bounded subset of the IRIDAS .cube format, with no external references. */
export function parseCubeLut(bytes:Buffer):{size:number;canonical:Buffer}{
 if(bytes.length===0||bytes.length>MAX_CUBE_BYTES)invalid('A 3D .cube LUT must be nonempty and at most 16 MiB.');
 const text=bytes.toString('utf8');if(text.includes('\uFFFD')||/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text))invalid('LUT must contain valid UTF-8 text.');
 let size:number|undefined,title=false,rows=0,started=false;const directives=new Map<string,number[]>(),data:string[]=[];
 const numeric=(value:string)=>{if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))invalid('LUT entries must be decimal numbers.');const n=Number(value);if(!Number.isFinite(n)||Math.abs(n)>64)invalid('LUT components must be finite values between -64 and 64.');return n;};
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  if(raw.length>4096)invalid('LUT lines must contain at most 4096 characters.');
  const line=raw.split('#',1)[0]!.trim();if(!line)continue;
  if(line.startsWith('TITLE')){if(started||title||!/^TITLE\s+"[^"\r\n]{0,200}"$/.test(line))invalid('LUT title is invalid or repeated.');title=true;continue;}
  const parts=line.split(/\s+/),name=parts[0]!;
  if(name==='LUT_3D_SIZE'){if(started||size!==undefined||parts.length!==2||!/^\d+$/.test(parts[1]!))invalid('LUT requires one integer 3D size before its samples.');size=Number(parts[1]);if(size<2||size>65)invalid('Supported 3D LUT sizes are 2 through 65.');continue;}
  if(name==='DOMAIN_MIN'||name==='DOMAIN_MAX'){if(started||directives.has(name)||parts.length!==4)invalid('LUT domains must be unique RGB triples before samples.');directives.set(name,parts.slice(1).map(numeric));continue;}
  if(size===undefined||parts.length!==3)invalid('Only a 3D size, optional title/domains, and RGB triples are supported.');
  started=true;if(++rows>size**3)invalid('LUT contains more samples than its declared cube size.');data.push(parts.map(numeric).join(' '));
 }
 if(size===undefined||rows!==size**3)invalid('LUT sample count must equal the cube of its declared size.');
 const min=directives.get('DOMAIN_MIN')??[0,0,0],max=directives.get('DOMAIN_MAX')??[1,1,1];if(min.some((v,i)=>v>=max[i]!))invalid('Every LUT domain maximum must exceed its minimum.');
 return{size,canonical:Buffer.from(['LUT_3D_SIZE '+size,'DOMAIN_MIN '+min.join(' '),'DOMAIN_MAX '+max.join(' '),...data,''].join('\n'))};
}
export async function readCubeLut(filePath:string,signal?:AbortSignal){
 signal?.throwIfAborted();const handle=await open(filePath,constants.O_RDONLY|(constants.O_NONBLOCK??0));
 try{const before=await handle.stat();if(!before.isFile()||before.size===0||before.size>MAX_CUBE_BYTES)invalid('Import a regular 3D .cube file no larger than 16 MiB.');
  const bytes=Buffer.alloc(before.size+1);let count=0;while(count<bytes.length){signal?.throwIfAborted();const part=await handle.read(bytes,count,bytes.length-count,count);if(!part.bytesRead)break;count+=part.bytesRead;}
  const after=await handle.stat();if(count!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new StudioException('LUT_CHANGED','LUT changed during validation; retry with a stable file.','conflict');
  const data=bytes.subarray(0,count),parsed=parseCubeLut(data);return{...parsed,sha256:createHash('sha256').update(data).digest('hex'),bytes:count};
 }finally{await handle.close();}
}
export async function probeLut(filePath:string,signal?:AbortSignal):Promise<MediaProbe>{const lut=await readCubeLut(filePath,signal);return{durationTick:0,formatName:'cube-3d-'+lut.size,hasAudio:false,hasVideo:false};}
