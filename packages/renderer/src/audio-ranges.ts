import { ticksPerSample, type Sequence, type StudioProject } from "@mcp-video-studio/contracts";
import { isAudioParameterTarget, resolveAudioParameter } from "../../contracts/src/audio-parameters.js";
import { StudioException } from "@mcp-video-studio/core";

export const AUDIO_RANGE_LIMITS={lanes:32,pointsPerLane:128,intervals:256,variants:16};
function invalid(message:string):never{throw new StudioException("INVALID_AUDIO_RANGE",message,"input");}
export interface AudioVariant {sequence:Sequence; windows:Array<{startSample:number;endSample:number}>}
/** Process each distinct setting with full history, then select its final PCM samples.
 * This deliberately does not reset stateful DSP or rely on frame-granular FFmpeg commands. */
export function audioParameterVariants(project:StudioProject,sequence:Sequence,totalSamples:number):AudioVariant[]|undefined{
 const lanes=sequence.automation.filter(lane=>lane.enabled&&isAudioParameterTarget(lane.target));
 if(!lanes.length)return;
 if(lanes.length>AUDIO_RANGE_LIMITS.lanes)invalid("Use at most 32 audio parameter lanes per sequence.");
 const quantum=ticksPerSample(project.settings.sampleRate),targets=new Set<string>(),boundaries=new Set([0,totalSamples]);
 const definitions=lanes.map(lane=>{
  if(targets.has(lane.target))invalid("Only one active lane may control each absolute audio parameter.");
  targets.add(lane.target);
  const resolved=resolveAudioParameter(sequence,lane.target),points=[...lane.points].sort((a,b)=>a.tick-b.tick);
  if(lane.target.endsWith(":audio.pan")&&project.settings.channels!==2)invalid("Pan ranges require a stereo project.");
  if(points.length>AUDIO_RANGE_LIMITS.pointsPerLane)invalid("Use at most 128 points per audio parameter lane.");
  for(let i=0;i<points.length;i++){
   const point=points[i]!;
   if(!Number.isSafeInteger(point.tick)||point.tick<0||point.tick%quantum||point.curve!=="hold"||!Number.isFinite(point.value)||point.value<resolved.field.min||point.value>resolved.field.max||i>0&&points[i-1]!.tick===point.tick)invalid("Effect and pan ranges require unique, sample-aligned hold points within the documented parameter bounds.");
   if(point.tick/quantum<totalSamples)boundaries.add(point.tick/quantum);
  }
  return{lane,points,base:resolved.base};
 });
 const times=[...boundaries].sort((a,b)=>a-b);
 if(times.length-1>AUDIO_RANGE_LIMITS.intervals)invalid("Audio ranges exceed the 256-interval processing limit.");
 const variants=new Map<string,AudioVariant>();
 for(let i=0;i<times.length-1;i++){
  const startSample=times[i]!,endSample=times[i+1]!;
  const values=definitions.map(({points,base})=>[...points].reverse().find(point=>point.tick<=startSample*quantum)?.value??base);
  const key=JSON.stringify(values);
  let variant=variants.get(key);
  if(!variant){
   if(variants.size>=AUDIO_RANGE_LIMITS.variants)invalid("Audio ranges exceed 16 distinct full-history mixes; split the sequence or simplify overlapping ranges.");
   const copy=structuredClone(sequence);copy.automation=copy.automation.filter(lane=>!isAudioParameterTarget(lane.target));
   definitions.forEach(({lane},index)=>resolveAudioParameter(copy,lane.target).set(values[index]!));
   variant={sequence:copy,windows:[]};variants.set(key,variant);
  }
  const previous=variant.windows.at(-1);
  if(previous?.endSample===startSample)previous.endSample=endSample;else variant.windows.push({startSample,endSample});
 }
 return [...variants.values()];
}
export function maskedVariantGraph(graph:string,index:number,windows:AudioVariant["windows"]):{graph:string;label:string}{
 const prefix="range"+index+"_",renamed=graph.replace(/\[([^\]]+)\]/g,(all,label:string)=>/^\d+:[av]$/.test(label)?all:"["+prefix+label+"]");
 const mask=windows.map(window=>"gte(n,"+window.startSample+")*lt(n,"+window.endSample+")").join("+");
 const label=prefix+"mask";
 return{graph:renamed+";\n["+prefix+"aout]aeval=exprs='val(ch)*("+mask+")':c=same["+label+"]",label};
}
