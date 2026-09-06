import { randomUUID } from "node:crypto";
import { ticksPerSample, type Sequence, type StudioProject, type ProjectCommand } from "@mcp-video-studio/contracts";
import { parameterTarget, resolveAudioParameter, type AudioParameterRangeCommand } from "../../contracts/src/audio-parameters.js";
import { StudioException } from "./errors.js";
function invalid(message:string):never{throw new StudioException("INVALID_AUDIO_RANGE",message,"input");}
export function audioParameterRange(project:StudioProject,sequence:Sequence,command:AudioParameterRangeCommand):ProjectCommand[]{
 const quantum=ticksPerSample(project.settings.sampleRate),{startTick:start,endTick:end,value}=command;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||start%quantum||end%quantum)invalid("Choose a positive sample-aligned audio interval.");
 const clip=command.targetType==="clip"?sequence.clips.find(clip=>clip.id===command.targetId):undefined;
 const track=sequence.tracks.find(track=>track.id===(clip?.trackId??command.targetId));
 if(!track||track.locked||!["audio","video"].includes(track.type)||command.targetType==="clip"&&!clip)invalid("Choose an unlocked audio/video target.");
 if(clip&&(start<clip.startTick||end>clip.startTick+clip.durationTick))invalid("The range must stay inside the clip.");
 if(command.parameter==="pan"&&project.settings.channels!==2)invalid("Pan ranges require stereo audio.");
 const target=parameterTarget(command),{field,base}=resolveAudioParameter(sequence,target);
 if(!Number.isFinite(value)||value<field.min||value>field.max)invalid("Parameter must be between "+field.min+" and "+field.max+".");
 const existing=sequence.automation.filter(lane=>lane.target===target);
 if(existing.length>1)invalid("Consolidate duplicate absolute parameter lanes before editing.");
 const lane=existing[0],points=[...(lane?.points??[])].sort((a,b)=>a.tick-b.tick);
 if(points.some((p,i)=>!Number.isSafeInteger(p.tick)||p.tick<0||p.tick%quantum||p.curve!=="hold"||!Number.isFinite(p.value)||p.value<field.min||p.value>field.max||i>0&&points[i-1]!.tick===p.tick))invalid("Range parameters use unique sample-aligned hold points.");
 const restored=[...points].reverse().find(point=>point.tick<=end)?.value??base;
 const result=points.filter(point=>point.tick<start||point.tick>end);
 result.push({tick:start,value,curve:"hold"},{tick:end,value:restored,curve:"hold"});
 result.sort((a,b)=>a.tick-b.tick);
 if(result.length>128)invalid("Use at most 128 points per audio parameter lane.");
 return[{type:"automation.set",sequenceId:sequence.id,lane:{id:lane?.id??randomUUID(),sequenceId:sequence.id,target,enabled:lane?.enabled??true,points:result}}];
}
