import { open,stat } from "node:fs/promises";
import path from "node:path";
import { ticksToFrames,ticksPerSample,ticksToSeconds,secondsToTicks,type Sequence,type StudioProject } from "@mcp-video-studio/contracts";
import { ProjectStore, sequenceDuration, sha256File } from "@mcp-video-studio/core";
import { probeMedia, mediaPath, runChecked, type StudioConfig } from "@mcp-video-studio/media";

export interface QcCheck {
  id: string;
  status: "PASS" | "FAIL" | "WARN";
  severity: "error" | "warning";
  expected?: Record<string, unknown>;
  observed?: Record<string, unknown>;
  message: string;
  checkId?:string;
  startTick?:number;
  endTick?:number;
  clipIds?:string[];
  allowanceId?:string;
}

export async function checkFaststart(filePath: string): Promise<{ faststart: boolean; boxes: string[] }> {
  const handle = await open(filePath, "r");
  const boxes: string[] = [];
  let position = 0;
  try {
    const info = await handle.stat();
    while (position + 8 <= info.size && boxes.length < 10_000) {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, 16, position);
      if (bytesRead < 8) break;
      let size = header.readUInt32BE(0);
      const type = header.subarray(4, 8).toString("ascii");
      let headerSize = 8;
      if (size === 1 && bytesRead >= 16) { size = Number(header.readBigUInt64BE(8)); headerSize = 16; }
      else if (size === 0) size = info.size - position;
      if (size < headerSize) break;
      boxes.push(type);
      position += size;
    }
  } finally { await handle.close(); }
  const moov = boxes.indexOf("moov");
  const mdat = boxes.indexOf("mdat");
  return { faststart: moov >= 0 && (mdat < 0 || moov < mdat), boxes };
}

async function loudness(filePath: string, config: StudioConfig, signal?: AbortSignal): Promise<Record<string, number|null>> {
  const result = await runChecked(config.ffmpegPath, ["-hide_banner","-protocol_whitelist","file,pipe,data", "-i", path.resolve(filePath), "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json", "-f", "null", "-"], { signal, timeoutMs: 60 * 60_000, maxOutputChars: 200_000 });
  const match = /\{[\s\S]*?"input_i"[\s\S]*?\}/g.exec(result.stderr);
  if (!match) return {};
  const parsed = JSON.parse(match[0]) as Record<string, string>;
  const finite=(value:string|undefined)=>{const number=Number(value);return value!==undefined&&Number.isFinite(number)?number:null;};
  return { integratedLufs: finite(parsed.input_i), truePeakDbtp: finite(parsed.input_tp), lra: finite(parsed.input_lra) };
}

export interface DetectorRange{checkId:"video.black"|"video.freeze"|"audio.silence";start:number;end:number}
export function detectorRanges(log:string,duration:number):DetectorRange[]{
 const result:DetectorRange[]=[];
 const add=(checkId:DetectorRange["checkId"],start:number,end:number)=>{if(Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&start<duration&&end>start)result.push({checkId,start,end:Math.min(duration,end)});};
 for(const match of log.matchAll(/black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)/g))add("video.black",Number(match[1]),Number(match[2]));
 for(const [checkId,prefix] of [["video.freeze","freeze"],["audio.silence","silence"]] as const){
  let start:number|undefined;
  const pattern=new RegExp(prefix+"_(start|end):\\s*([\\d.]+)","g");
  for(const match of log.matchAll(pattern)){if(match[1]==="start")start=Number(match[2]);else if(start!==undefined){add(checkId,start,Number(match[2]));start=undefined;}}
  if(start!==undefined)add(checkId,start,duration);
 }
 return result.slice(0,5000);
}
async function analyze(filePath:string,config:StudioConfig,video:boolean,audio:boolean,signal?:AbortSignal){
 return runChecked(config.ffmpegPath,["-hide_banner","-nostats","-protocol_whitelist","file,pipe,data","-i",path.resolve(filePath),
  "-map","0:v:0?","-map","0:a:0?",
  ...(video?["-vf","blackdetect=d=0.2:pic_th=0.98:pix_th=0.1,freezedetect=n=-60dB:d=2"]:[]),
  ...(audio?["-af","silencedetect=n=-50dB:d=0.5"]:[]),"-progress","pipe:1","-f","null","-"],{signal,timeoutMs:60*60_000,maxOutputChars:500000});
}
function finding(sequence:Sequence,range:DetectorRange,index:number):QcCheck{
 const startTick=secondsToTicks(range.start),endTick=secondsToTicks(range.end);
 const allowance=sequence.qcAllowances?.find(item=>item.checkId===range.checkId&&item.startTick<=startTick&&item.endTick>=endTick);
 return{id:range.checkId+":"+index,checkId:range.checkId,status:allowance?"PASS":"WARN",severity:"warning",startTick,endTick,
  clipIds:sequence.clips.filter(clip=>clip.startTick<endTick&&clip.startTick+clip.durationTick>startTick).map(clip=>clip.id),
  observed:{startSeconds:range.start,endSeconds:range.end,durationSeconds:range.end-range.start},
  message:allowance?"Intentional range: "+allowance.reason:range.checkId==="video.black"?"Review detected black video.":range.checkId==="video.freeze"?"Review detected frozen video.":"Review detected silence.",
  ...(allowance?{allowanceId:allowance.id}:{})};
}
export async function runQc(store:ProjectStore,sequenceId:string,filePath:string,config:StudioConfig,signal?:AbortSignal):Promise<Record<string,unknown>>{
 const project=await store.read(),sequence=project.sequences.find(item=>item.id===sequenceId);
 if(!sequence)throw new Error("Sequence not found: "+sequenceId);
 const probe=await probeMedia(filePath,config,signal);
 const [decoded,faststart,levels,hash]=await Promise.all([
  analyze(filePath,config,probe.hasVideo,probe.hasAudio,signal),checkFaststart(filePath),
  probe.hasAudio?loudness(filePath,config,signal):Promise.resolve({} as Record<string,number>),sha256File(filePath)]);
 const expectedFrames=ticksToFrames(sequenceDuration(sequence),project.settings.fps,"ceil");
 const frames=[...decoded.stdout.matchAll(/(?:^|\n)frame=\s*(\d+)/g)];
 const actualFrames=frames.length?Number(frames.at(-1)![1]):undefined;
 const checks:QcCheck[]=[{id:"decode",status:"PASS",severity:"error",message:"Full decode completed.",observed:{durationMs:decoded.durationMs}}];
 if(probe.hasVideo)checks.push(
  {id:"video.raster",status:probe.width===project.settings.raster.width&&probe.height===project.settings.raster.height?"PASS":"FAIL",severity:"error",expected:{...project.settings.raster},observed:{width:probe.width,height:probe.height},message:"Output raster matches the project."},
  {id:"video.frames",status:actualFrames===expectedFrames?"PASS":"FAIL",severity:"error",expected:{frames:expectedFrames},observed:{frames:actualFrames??null},message:"Decoded frame count matches the timeline."});
 else checks.push({id:"audio.duration",status:Math.abs(probe.durationTick-sequenceDuration(sequence))<=ticksPerSample(project.settings.sampleRate)?"PASS":"FAIL",severity:"error",message:"Audio-only duration matches the sample timeline.",expected:{durationTick:sequenceDuration(sequence)},observed:{durationTick:probe.durationTick}});
 if(path.extname(filePath).toLowerCase()===".mp4")checks.push({id:"container.faststart",status:faststart.faststart?"PASS":"FAIL",severity:"warning",observed:faststart,message:"MP4 metadata precedes media data."});
 if(probe.hasAudio)checks.push(
  {id:"audio.loudness",status:Number.isFinite(levels["integratedLufs"])&&levels["integratedLufs"]!>=-18&&levels["integratedLufs"]!<=-14?"PASS":"WARN",severity:"warning",expected:{integratedLufs:"-18 to -14"},observed:levels,message:"Integrated loudness is in the review range."},
  {id:"audio.true_peak",status:Number.isFinite(levels["truePeakDbtp"])&&levels["truePeakDbtp"]!<=-1?"PASS":"WARN",severity:"warning",expected:{maxDbtp:-1},observed:levels,message:"True peak is below the review ceiling."});
 const ranges=detectorRanges(decoded.stderr,ticksToSeconds(probe.durationTick));
 checks.push(...ranges.map((range,index)=>finding(sequence,range,index)));
 if(decoded.truncated||ranges.length>=5000)checks.push({id:"analysis.complete",status:"WARN",severity:"warning",message:"Analysis reached its bounded output limit. Review smaller export ranges for complete findings."});
 const used=new Set(sequence.clips.flatMap(clip=>clip.source.type==="media"?[clip.source.mediaId]:[]));
 for(const media of project.media.filter(item=>used.has(item.id))){
  let available=false;try{available=(await stat(mediaPath(store,media))).isFile()&&!media.offline;}catch{}
  if(!available){const clips=sequence.clips.filter(clip=>clip.source.type==="media"&&clip.source.mediaId===media.id);checks.push({id:"media.offline:"+media.id,status:"FAIL",severity:"error",message:"Project media is offline: "+media.name,startTick:Math.min(...clips.map(clip=>clip.startTick)),endTick:Math.max(...clips.map(clip=>clip.startTick+clip.durationTick)),clipIds:clips.map(clip=>clip.id)});}
 }
 return{success:true,passed:checks.every(check=>check.status!=="FAIL"),projectId:project.projectId,revision:project.revision,sequenceId,path:path.resolve(filePath),sha256:hash.sha256,bytes:hash.bytes,checks};
}
