import {isAudioAutomation,shiftAutomationPoints} from "./automation-timing.js";
import type {AutomationLane,AutomationPoint,Clip,ProjectCommand,Sequence,Transition} from "./types.js";
export interface ClipClipboard {clips:Clip[];automation:AutomationLane[];transitions:Transition[]}
export function copyClipSelection(sequence:Sequence,selected:string[]):ClipClipboard{
 if(!selected.length||selected.some(id=>!sequence.clips.some(clip=>clip.id===id)))throw new Error("Select existing clips to copy.");
 const ids=new Set(selected);let grew=true;
 while(grew){grew=false;const chosen=sequence.clips.filter(clip=>ids.has(clip.id));for(const clip of sequence.clips)if(!ids.has(clip.id)&&chosen.some(item=>(item.groupId&&clip.groupId===item.groupId)||(item.linkedGroupId&&clip.linkedGroupId===item.linkedGroupId))){ids.add(clip.id);grew=true;}}
 return structuredClone({clips:sequence.clips.filter(clip=>ids.has(clip.id)),automation:sequence.automation.filter(lane=>lane.target.startsWith("clip:")&&ids.has(lane.target.split(":")[1]!)),transitions:sequence.transitions.filter(t=>ids.has(t.fromClipId)&&ids.has(t.toClipId))});
}
export function pasteClipSelection(sequenceId:string,data:ClipClipboard,atTick:number,sampleTick=1):{commands:ProjectCommand[];clipIds:string[]}{
 if(!data.clips.length||!Number.isSafeInteger(atTick)||atTick<0)throw new Error("Paste requires clips and a nonnegative integer time.");
 const offset=atTick-Math.min(...data.clips.map(clip=>clip.startTick)),ids=new Map(data.clips.map(clip=>[clip.id,crypto.randomUUID()])),groups=new Map<string,string>();
 const relation=(kind:string,id:string)=>{const key=kind+id;let value=groups.get(key);if(!value){value=crypto.randomUUID();groups.set(key,value);}return value;};
 const commands:ProjectCommand[]=data.clips.map(original=>{const clip=structuredClone(original);clip.id=ids.get(original.id)!;clip.startTick+=offset;clip.name+=" copy";if(clip.groupId)clip.groupId=relation("group",clip.groupId);if(clip.linkedGroupId)clip.linkedGroupId=relation("link",clip.linkedGroupId);return{type:"clip.add",sequenceId,clip,mode:"overwrite"};});
 for(const lane of data.automation){const target=lane.target.split(":"),id=ids.get(target[1]!);if(id)commands.push({type:"automation.set",sequenceId,lane:{...structuredClone(lane),id:crypto.randomUUID(),sequenceId,target:"clip:"+id+":"+target.slice(2).join(":"),points:shiftAutomationPoints(lane.points,offset,isAudioAutomation(lane.target)?sampleTick:1)}});}
 for(const transition of data.transitions)commands.push({type:"transition.add",sequenceId,transition:{...structuredClone(transition),id:crypto.randomUUID(),sequenceId,fromClipId:ids.get(transition.fromClipId)!,toClipId:ids.get(transition.toClipId)!}});
 return{commands,clipIds:[...ids.values()]};
}
