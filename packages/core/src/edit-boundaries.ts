import type { Clip, ProjectCommand, Sequence, StudioProject } from "@mcp-video-studio/contracts";
import { StudioException } from "./errors.js";
const end=(clip:Clip)=>clip.startTick+clip.durationTick;
const fail=(message:string):never=>{throw new StudioException("INVALID_EDIT",message,"input");};
function source(project:StudioProject,clip:Clip,sourceInTick:number,durationTick:number):void{
 if(!Number.isSafeInteger(sourceInTick)||!Number.isSafeInteger(durationTick)||sourceInTick<0||durationTick<=0)fail("The edit exceeds the clip's source handles.");
 let available:number|undefined;
 if(clip.source.type==="media"){const id=clip.source.mediaId,asset=project.media.find(item=>item.id===id);if(asset?.kind!=="image")available=asset?.probe.durationTick;}
 else if(clip.source.type==="animation"){const id=clip.source.animationId;available=project.animations.find(item=>item.id===id)?.durationTick;}
 else if(clip.source.type==="sequence"){const id=clip.source.sequenceId;const nested=project.sequences.find(item=>item.id===id);available=nested?[...nested.clips,...nested.captions].reduce((n,c)=>Math.max(n,c.startTick+c.durationTick),0):undefined;}
 if(available!==undefined&&sourceInTick+Math.round(durationTick*clip.playbackRate.numerator/clip.playbackRate.denominator)>available)fail("The edit exceeds the clip's source handles.");
}
export function linkedBoundaryEdit(project:StudioProject,sequence:Sequence,anchor:Clip,selected:string[],kind:"clip.roll"|"clip.slide",delta:number,related:(ids:string[])=>string[]):ProjectCommand[]{
 if(!Number.isSafeInteger(delta))fail("Edit times must be safe integer ticks.");
 const patches=new Map<string,Partial<Clip>>(),moving=new Set<string>();
 const add=(clip:Clip,patch:Partial<Clip>)=>{
  if(sequence.tracks.find(track=>track.id===clip.trackId)?.locked)fail("Unlock every affected track before editing.");
  const old=patches.get(clip.id);if(old&&JSON.stringify(old)!==JSON.stringify(patch))fail("The selected cuts overlap. Select one aligned cut or slide group.");
  source(project,clip,patch.sourceInTick??clip.sourceInTick,patch.durationTick??clip.durationTick);
  patches.set(clip.id,patch);
 };
 for(const id of selected){
  const clip=sequence.clips.find(item=>item.id===id)!;
  const before=sequence.clips.filter(item=>item.trackId===clip.trackId&&end(item)===clip.startTick);
  const after=sequence.clips.filter(item=>item.trackId===clip.trackId&&item.startTick===end(clip));
  if(after.length!==1||(kind==="clip.slide"&&before.length!==1))fail("Each linked or grouped clip needs an unambiguous adjacent clip at the edited cut.");
  const next=after[0]!,advance=Math.round(delta*next.playbackRate.numerator/next.playbackRate.denominator);
  add(next,{startTick:next.startTick+delta,sourceInTick:next.sourceInTick+advance,durationTick:next.durationTick-delta});
  if(kind==="clip.roll")add(clip,{durationTick:clip.durationTick+delta});
  else{const previous=before[0]!;add(previous,{durationTick:previous.durationTick+delta});add(clip,{startTick:clip.startTick+delta});moving.add(clip.id);}
 }
 if(related([...patches.keys()]).some(id=>!patches.has(id)))fail("This cut would separate linked or grouped neighbors. Select their corresponding cuts together.");
 const moved=[...patches].filter(([,patch])=>patch.startTick!==undefined).map(([id])=>id);
 if(related(moved).some(id=>!moved.includes(id)))fail("This edit would move only part of a linked or grouped neighbor.");
 const commands:ProjectCommand[]=[...patches].map(([clipId,patch])=>{const {startTick,...timing}=patch;return{type:"clip.update",sequenceId:sequence.id,clipId,patch:timing};});
 if(moved.length){
  const first=sequence.clips.filter(clip=>moved.includes(clip.id)).reduce((a,b)=>a.startTick<=b.startTick?a:b);
  commands.push({type:"clip.move",sequenceId:sequence.id,clipIds:moved,targetTrackId:first.trackId,startTick:first.startTick+delta,ripple:false});
 }
 // A neighbor's trim removes its head; its existing timeline envelope stays put.
 // Only slid content carries its automation with it.
 for(const lane of sequence.automation)if(moved.includes(lane.target.split(":")[1]!)&&!moving.has(lane.target.split(":")[1]!))commands.push({type:"automation.set",sequenceId:sequence.id,lane:structuredClone(lane)});
 return commands;
}
