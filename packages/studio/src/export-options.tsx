import React,{useEffect,useState} from "react";
import {ticksPerFrame,ticksPerSample,type ExportPreset,type Sequence,type StudioProject} from "@mcp-video-studio/contracts";
import type {StudioRequest} from "./project-files.js";
export interface ExportSelection {range?:{startTick:number;endTick:number};encoder?:{name:string;allowSoftwareFallback?:boolean}}
type Capability={name:string;codec:string;hardware:boolean;compiled:boolean;usable:boolean;reason?:string};
export function ExportOptions({project,sequence,preset,request,onChange,onError}:{project:StudioProject;sequence:Sequence;preset:ExportPreset;request:StudioRequest;onChange(value:ExportSelection):void;onError(message:string):void}){
 const audioOnly=preset.container==="wav",quantum=audioOnly?ticksPerSample(project.settings.sampleRate):ticksPerFrame(project.settings.fps);
 const duration=Math.max(0,...sequence.clips.filter(clip=>clip.enabled).map(clip=>clip.startTick+clip.durationTick),...sequence.captions.map(cue=>cue.startTick+cue.durationTick)),end=Math.ceil(duration/quantum);
 const [limited,setLimited]=useState(false),[first,setFirst]=useState(0),[last,setLast]=useState(end),[name,setName]=useState(""),[fallback,setFallback]=useState(false),[capabilities,setCapabilities]=useState<Capability[]>([]),[checking,setChecking]=useState(false);
 useEffect(()=>{setFirst(0);setLast(end);setName("");setFallback(false);},[sequence.id,preset.id,quantum,end]);
 useEffect(()=>{onChange({...limited?{range:{startTick:first*quantum,endTick:last*quantum}}:{},...name&&!audioOnly?{encoder:{name,allowSoftwareFallback:fallback}}:{}});},[limited,first,last,quantum,name,fallback,audioOnly,onChange]);
 const codec=preset.videoCodec==="libx264"?"h264":preset.videoCodec==="libx265"?"hevc":preset.videoCodec==="libvpx-vp9"?"vp9":preset.videoCodec;
 const choices=capabilities.filter(entry=>entry.codec===codec),chosen=choices.find(entry=>entry.name===(name||preset.videoCodec));
 async function check(){setChecking(true);try{const result=await request<{encoders:Capability[]}>("/api/export-capabilities");setCapabilities(result.encoders);}catch(error){onError(error instanceof Error?error.message:String(error));}finally{setChecking(false);}}
 return <fieldset aria-label="Export options"><legend>Range and encoder</legend>
  <label><input type="checkbox" checked={limited} onChange={event=>setLimited(event.currentTarget.checked)}/>Export selected range</label>
  {limited&&<><label>Start {audioOnly?"sample":"frame"} (inclusive)<input aria-label="Export range start" type="number" min="0" max={end-1} step="1" value={first} onChange={event=>setFirst(event.currentTarget.valueAsNumber)}/></label><label>End {audioOnly?"sample":"frame"} (exclusive)<input aria-label="Export range end" type="number" min={first+1} max={end} step="1" value={last} onChange={event=>setLast(event.currentTarget.valueAsNumber)}/></label><small>The completed program is trimmed after all effects. Frames and samples outside this range are omitted.</small></>}
  {!audioOnly&&<><button disabled={checking} onClick={()=>void check()}>{checking?"Checking encoder test frames…":"Check available encoders"}</button><label>Video encoder<select aria-label="Export video encoder" value={name} onChange={event=>{setName(event.currentTarget.value);setFallback(false);}}><option value="">Software default ({preset.videoCodec})</option>{choices.filter(entry=>entry.name!==preset.videoCodec).map(entry=><option key={entry.name} value={entry.name}>{entry.name} — {entry.usable?"available":"unavailable"}</option>)}</select></label>{chosen&&<p role="status">{chosen.name}: {chosen.usable?"test frame encoded successfully":chosen.reason??"unavailable"}</p>}{name&&<label><input type="checkbox" checked={fallback} onChange={event=>setFallback(event.currentTarget.checked)}/>Allow software fallback if the selected hardware is unavailable</label>}<small>Export history records the encoder actually used. A hardware failure during a render fails that job; it never silently changes the encoder.</small></>}
  {preset.container==="gif"&&<p className="hint">GIF has no audio and stores frame timing in hundredths of a second. Palette conversion can change colors.</p>}
  {preset.container==="zip"&&<p className="hint">ZIP contains numbered PNG frames and a timing/checksum manifest. No audio; maximum 100,000 frames per export.</p>}
 </fieldset>;
}
