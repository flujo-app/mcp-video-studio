import {createHash} from "node:crypto";
import {ticksPerSample,type StudioProject,type Sequence,type ProjectCommand,type AudioDuckingCommand,type AutomationPoint} from "@mcp-video-studio/contracts";
import {StudioException} from "./errors.js";
function invalid(message:string):never{throw new StudioException("INVALID_DUCKING",message,"input");}
/** Timeline-based ducking follows enabled voice clips; it does not claim speech/VAD detection. */
export function duckAudio(project:StudioProject,sequence:Sequence,command:AudioDuckingCommand):ProjectCommand[]{
 const q=ticksPerSample(project.settings.sampleRate),music=sequence.tracks.find(t=>t.id===command.musicTrackId);
 if(!music||music.locked||!["audio","video"].includes(music.type))invalid("Choose an unlocked music track.");
 if(!command.voiceTrackIds.length||command.voiceTrackIds.includes(music.id)||new Set(command.voiceTrackIds).size!==command.voiceTrackIds.length||command.voiceTrackIds.some(id=>!sequence.tracks.some(t=>t.id===id&&["audio","video"].includes(t.type))))invalid("Choose distinct voice tracks separate from the music track.");
 if(!Number.isFinite(command.attenuationDb)||command.attenuationDb<-60||command.attenuationDb>0)invalid("Ducking gain must be between -60 and 0 dB.");
 for(const value of [command.attackTick,command.releaseTick])if(!Number.isSafeInteger(value)||value<0||value%q||value>10*project.timebase)invalid("Ducking ramps must align to samples and last at most ten seconds.");
 const anySolo=sequence.tracks.some(track=>["audio","video"].includes(track.type)&&track.solo);
 const windows=sequence.clips.filter(c=>c.enabled&&!c.audio.muted&&command.voiceTrackIds.includes(c.trackId)&&!sequence.tracks.find(t=>t.id===c.trackId)?.muted&&(!anySolo||sequence.tracks.find(t=>t.id===c.trackId)?.solo))
  .map(c=>({start:Math.max(0,Math.floor(c.startTick/q)*q),end:Math.ceil((c.startTick+c.durationTick)/q)*q})).sort((a,b)=>a.start-b.start);
 if(!windows.length)invalid("The selected voice tracks have no audible clips.");
 const groups:typeof windows=[];
 for(const window of windows){const last=groups.at(-1);if(last&&window.start-command.attackTick<=last.end+command.releaseTick)last.end=Math.max(last.end,window.end);else groups.push({...window});}
 if(groups.length>1000)invalid("Use at most 1,000 separate voice regions for ducking.");
 const map=new Map<number,AutomationPoint>(),add=(tick:number,value:number,curve:"hold"|"linear")=>map.set(tick,{tick,value,curve});
 for(const region of groups){
  if(command.attackTick&&region.start>0)add(Math.max(0,region.start-command.attackTick),0,"linear");
  else if(region.start>0)add(region.start-q,0,"hold");
  add(region.start,command.attenuationDb,"hold");
  if(command.releaseTick){add(region.end,command.attenuationDb,"linear");add(region.end+command.releaseTick,0,"hold");}
  else add(region.end,0,"hold");
 }
 return[{type:"automation.set",sequenceId:sequence.id,lane:{id:"duck-"+createHash("sha256").update(music.id).digest("hex").slice(0,32),sequenceId:sequence.id,target:"track:"+music.id+":gainDbOffset",enabled:true,points:[...map.values()].sort((a,b)=>a.tick-b.tick)}}];
}
