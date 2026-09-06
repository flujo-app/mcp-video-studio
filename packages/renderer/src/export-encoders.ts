import { runProcess } from "@mcp-video-studio/media";
import { StudioException } from "@mcp-video-studio/core";

export const ENCODERS=[
 {name:"libx264",codec:"h264",hardware:false},
 {name:"libx265",codec:"hevc",hardware:false},
 {name:"libvpx-vp9",codec:"vp9",hardware:false},
 {name:"ffv1",codec:"ffv1",hardware:false},
 {name:"gif",codec:"gif",hardware:false},
 {name:"png",codec:"png",hardware:false},
 ...["nvenc","qsv","amf","videotoolbox"].flatMap(driver=>[
   {name:"h264_"+driver,codec:"h264",hardware:true},
   {name:"hevc_"+driver,codec:"hevc",hardware:true}
 ])
] as const;
export interface EncoderChoice { name:string;allowSoftwareFallback?:boolean }
export interface EncoderCapability { name:string;codec:string;hardware:boolean;compiled:boolean;usable:boolean;checkedAt:string;reason?:string }
export interface EncoderSelection { requested:string;selected:string;hardware:boolean;fallback:boolean;reason?:string }
const capabilityCache=new Map<string,{until:number;pending:Promise<EncoderCapability>}>();
const encoderLists=new Map<string,{until:number;pending:Promise<Set<string>>}>();
function definition(name:string) {
 const entry=ENCODERS.find(item=>item.name===name);
 if(!entry)throw new StudioException("INVALID_ENCODER","Choose one of the reported export encoders.","input",{name});
 return entry;
}
async function compiledEncoders(ffmpegPath:string):Promise<Set<string>> {
 let cached=encoderLists.get(ffmpegPath);
 if(!cached||cached.until<Date.now()){
  const pending=runProcess(ffmpegPath,["-hide_banner","-encoders"],{timeoutMs:10000,maxOutputChars:500000}).then(result=>{
   if(result.exitCode!==0)throw new StudioException("ENCODER_DISCOVERY_FAILED","Could not list FFmpeg encoders.","dependency",{stderr:result.stderr});
   return new Set((result.stdout+"\n"+result.stderr).split(/\r?\n/).map(line=>/^\s*[A-Z.]{6}\s+(\S+)\s/.exec(line)?.[1]??""));
  }).catch(error=>{encoderLists.delete(ffmpegPath);throw error;});
  cached={until:Date.now()+60000,pending};encoderLists.set(ffmpegPath,cached);
 }
 return cached.pending;
}
export function encoderArguments(name:string,options:{crf?:number;preset?:string;videoBitrate?:string}={}):string[] {
 const entry=definition(name);
 if(options.crf!==undefined&&(!Number.isInteger(options.crf)||options.crf<0||options.crf>51))throw new StudioException("INVALID_CRF","CRF must be an integer from 0 through 51.","input");
 if(options.videoBitrate!==undefined&&!/^[1-9][0-9]{0,8}(?:[kKmM])?$/.test(options.videoBitrate))throw new StudioException("INVALID_BITRATE","Video bitrate must be a positive integer, optionally followed by k or M.","input");
 const args=["-c:v",name];
 if(name==="libx264"||name==="libx265"){
  args.push("-preset",options.preset??"veryfast","-crf",String(options.crf??18));
  if(name==="libx265")args.push("-x265-params","pools=1:frame-threads=1","-tag:v","hvc1");
 }else if(name==="libvpx-vp9")args.push("-crf",String(options.crf??30),"-b:v",options.videoBitrate??"0");
 else if(entry.hardware){
  args.push("-b:v",options.videoBitrate??"6M");
  if(name.endsWith("_videotoolbox"))args.push("-allow_sw","0");
  if(name.startsWith("hevc_"))args.push("-tag:v","hvc1");
 }
 if(options.videoBitrate&&(name==="libx264"||name==="libx265"))args.push("-b:v",options.videoBitrate);
 return args;
}
/** A compile-time encoder listing is not proof that its driver or physical device works. */
export async function probeExportEncoder(ffmpegPath:string,name:string,refresh=false):Promise<EncoderCapability> {
 const entry=definition(name),key=ffmpegPath+"\0"+name,cached=capabilityCache.get(key);
 if(!refresh&&cached&&cached.until>Date.now())return cached.pending;
 const pending=(async()=>{
  const base={...entry,compiled:false,usable:false,checkedAt:new Date().toISOString()};
  try{
   if(!(await compiledEncoders(ffmpegPath)).has(name))return {...base,reason:"Encoder is not compiled into this FFmpeg build."};
   const pixel=name==="gif"?"rgb8":name==="png"?"rgb24":"yuv420p";
   const result=await runProcess(ffmpegPath,["-hide_banner","-loglevel","error","-nostdin","-f","lavfi","-i",`color=c=black:s=128x128:r=30:d=0.1,format=${pixel}`,"-frames:v","1",...encoderArguments(name),"-f","null","-"],{timeoutMs:10000,maxOutputChars:4096});
   return {...base,compiled:true,usable:result.exitCode===0,...(result.exitCode!==0?{reason:result.stderr.trim()||"Encoder probe failed or exceeded its ten second deadline."}:{})};
  }catch(error){return {...base,reason:error instanceof Error?error.message:String(error)};}
 })();
 capabilityCache.set(key,{until:Date.now()+30000,pending});return pending;
}
export async function exportEncoderCapabilities(ffmpegPath:string):Promise<EncoderCapability[]> {
 const result:EncoderCapability[]=[];
 // Bound simultaneous driver probes; callers get explicit unavailable entries.
 for(let offset=0;offset<ENCODERS.length;offset+=2)result.push(...await Promise.all(ENCODERS.slice(offset,offset+2).map(entry=>probeExportEncoder(ffmpegPath,entry.name))));
 return result;
}
export async function selectExportEncoder(ffmpegPath:string,softwareName:string,choice?:EncoderChoice):Promise<EncoderSelection> {
 const software=definition(softwareName),requested=definition(choice?.name??softwareName);
 if(software.hardware||requested.codec!==software.codec)throw new StudioException("ENCODER_CODEC_MISMATCH","Requested encoder must match the export preset codec.","input",{preset:softwareName,requested:requested.name});
 const capability=await probeExportEncoder(ffmpegPath,requested.name);
 if(capability.usable)return {requested:requested.name,selected:requested.name,hardware:requested.hardware,fallback:false};
 if(requested.hardware&&choice?.allowSoftwareFallback){
  const fallback=await probeExportEncoder(ffmpegPath,softwareName);
  if(fallback.usable)return {requested:requested.name,selected:softwareName,hardware:false,fallback:true,reason:capability.reason??"Requested hardware encoder is unavailable."};
 }
 throw new StudioException("ENCODER_UNAVAILABLE","The selected encoder could not encode a test frame. Choose an available encoder or explicitly allow software fallback.","dependency",{...capability,softwareFallback:softwareName});
}
