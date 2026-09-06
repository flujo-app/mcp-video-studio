import React,{useState} from "react";
import {effectFields,ticksPerSample,ticksToSeconds,secondsToTicks,type Sequence,type StudioProject,type ProjectCommand} from "@mcp-video-studio/contracts";
export function AudioRangeControls({project,sequence,targetType,targetId,onMutate}:{project:StudioProject;sequence:Sequence;targetType:"clip"|"track";targetId:string;onMutate(commands:ProjectCommand[]):Promise<void>}){
 const clip=targetType==="clip"?sequence.clips.find(c=>c.id===targetId):undefined,track=sequence.tracks.find(t=>t.id===(clip?.trackId??targetId));
 const effects=clip?clip.audio.effects:track?.effects??[],[choice,setChoice]=useState("pan"),[start,setStart]=useState(ticksToSeconds(clip?.startTick??0)),[end,setEnd]=useState(ticksToSeconds(clip?clip.startTick+clip.durationTick:project.timebase)),[value,setValue]=useState(0),[error,setError]=useState("");
 const options=[...(project.settings.channels===2?[{id:"pan",label:"Pan",min:-1,max:1,value:0,step:.05}]:[]),...effects.flatMap(effect=>effectFields(effect).map(field=>({id:effect.id+":"+field.key,label:effect.type+" "+field.key,...field})))];
 const selected=options.find(o=>o.id===choice)??options[0];
 const align=(seconds:number)=>Math.round(secondsToTicks(seconds)/ticksPerSample(project.settings.sampleRate))*ticksPerSample(project.settings.sampleRate);
 const apply=async()=>{try{setError("");if(!selected)throw new Error("Add an audio effect first.");const [effectId,parameterKey]=selected.id.split(":");await onMutate([{type:"audio.parameter.range",sequenceId:sequence.id,targetType,targetId,startTick:align(start),endTick:align(end),value,parameter:selected.id==="pan"?"pan":"effect",...(selected.id==="pan"?{}:{effectId:effectId!,parameterKey:parameterKey!})}]);}catch(error){setError(error instanceof Error?error.message:String(error));}};
 return <fieldset aria-label={"Exact audio range "+targetId}><legend>Exact audio parameter range</legend><p>Times snap to {project.settings.sampleRate} Hz samples. A hold change preserves the surrounding final mix, including effect tails.</p>
 <label>Range parameter<select value={selected?.id??""} onChange={e=>{setChoice(e.target.value);setValue(options.find(o=>o.id===e.target.value)?.value??0);}}>{options.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
 <label>Parameter range start seconds<input type="number" min="0" step="any" value={start} onChange={e=>setStart(e.target.valueAsNumber)}/></label>
 <label>Parameter range end seconds<input type="number" min="0" step="any" value={end} onChange={e=>setEnd(e.target.valueAsNumber)}/></label>
 <label>Range parameter value<input type="number" min={selected?.min} max={selected?.max} step="any" value={value} onChange={e=>setValue(e.target.valueAsNumber)}/></label>
 <button disabled={!selected||track?.locked||!Number.isFinite(value)||value<selected.min||value>selected.max||!Number.isFinite(start)||!Number.isFinite(end)||end<=start} onClick={()=>void apply()}>Set parameter range</button><p role="status">{error}</p>{sequence.automation.filter(lane=>lane.target.startsWith(targetType+":"+targetId+":audio.")).map(lane=><div key={lane.id}><label><input type="checkbox" checked={lane.enabled} onChange={e=>void onMutate([{type:"automation.set",sequenceId:sequence.id,lane:{...lane,enabled:e.target.checked}}])}/>Enable range {lane.target.split(":audio.")[1]}</label><button onClick={()=>void onMutate([{type:"automation.remove",sequenceId:sequence.id,laneId:lane.id}])}>Remove range {lane.target.split(":audio.")[1]}</button></div>)}
 </fieldset>;
}
export function DuckingControls({project,sequence,onMutate}:{project:StudioProject;sequence:Sequence;onMutate(commands:ProjectCommand[]):Promise<void>}){
 const tracks=sequence.tracks.filter(t=>["audio","video"].includes(t.type)),[music,setMusic]=useState(tracks.find(t=>/music/i.test(t.name))?.id??tracks[1]?.id??tracks[0]?.id??""),[voice,setVoice]=useState(tracks.find(t=>/voice|narration/i.test(t.name))?.id??tracks[0]?.id??""),[gain,setGain]=useState(-12),[attack,setAttack]=useState(.1),[release,setRelease]=useState(.3);
 const align=(seconds:number)=>Math.round(secondsToTicks(seconds)/ticksPerSample(project.settings.sampleRate))*ticksPerSample(project.settings.sampleRate);
 return <fieldset><legend>Voiceover ducking</legend><p>Music follows enabled voice clip regions, with sample-aligned ramps. Reapply after changing voice timing.</p>
 <label>Ducking music track<select value={music} onChange={e=>setMusic(e.target.value)}>{tracks.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
 <label>Ducking voice track<select value={voice} onChange={e=>setVoice(e.target.value)}>{tracks.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
 <label>Ducking attenuation dB<input type="number" min="-60" max="0" value={gain} onChange={e=>setGain(e.target.valueAsNumber)}/></label>
 <label>Ducking attack seconds<input type="number" min="0" max="10" step=".01" value={attack} onChange={e=>setAttack(e.target.valueAsNumber)}/></label>
 <label>Ducking release seconds<input type="number" min="0" max="10" step=".01" value={release} onChange={e=>setRelease(e.target.valueAsNumber)}/></label>
 <button disabled={music===voice||![gain,attack,release].every(Number.isFinite)||gain>0||gain<-60||attack<0||release<0||attack>10||release>10} onClick={()=>void onMutate([{type:"audio.duck",sequenceId:sequence.id,musicTrackId:music,voiceTrackIds:[voice],attenuationDb:gain,attackTick:align(attack),releaseTick:align(release)}])}>Duck music under voice</button>
 </fieldset>;
}
