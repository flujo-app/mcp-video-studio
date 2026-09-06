import React,{useState} from "react";
import {secondsToTicks,ticksToSeconds,type Clip,type EffectInstance,type ProjectCommand,type Sequence} from "@mcp-video-studio/contracts";
type Field={key:string;value:number;min:number;max:number;step?:number};
const audio:Record<string,Field[]>={
 highpass:[{key:"frequency",value:80,min:20,max:20000}],lowpass:[{key:"frequency",value:16000,min:20,max:20000}],
 compressor:[{key:"threshold",value:.125,min:.001,max:1,step:.01},{key:"ratio",value:4,min:1,max:20},{key:"attack",value:20,min:.01,max:2000},{key:"release",value:250,min:.01,max:9000}],
 limiter:[{key:"limit",value:.891,min:.0625,max:1,step:.01}],
 delay:[{key:"delayMs",value:250,min:1,max:2000},{key:"decay",value:.3,min:0,max:.9,step:.05}],
 gate:[{key:"threshold",value:.03,min:0,max:1,step:.01},{key:"ratio",value:4,min:1,max:9000},{key:"attack",value:20,min:.01,max:9000},{key:"release",value:250,min:.01,max:9000}],
 deesser:[{key:"intensity",value:.5,min:0,max:1,step:.05},{key:"amount",value:.5,min:0,max:1,step:.05},{key:"frequency",value:.5,min:0,max:1,step:.05}],
 reverb:[{key:"mix",value:.5,min:0,max:1,step:.05}],
 loudness:[{key:"targetLufs",value:-16,min:-70,max:-5},{key:"truePeakDb",value:-1,min:-9,max:0,step:.1},{key:"rangeLu",value:7,min:1,max:50}],
 equalizer:[]
};
const video:Record<string,Field[]>={
 color:[{key:"brightness",value:0,min:-1,max:1,step:.05},{key:"contrast",value:1,min:0,max:10,step:.1},{key:"saturation",value:1,min:0,max:3,step:.1}],
 blur:[{key:"radius",value:4,min:0,max:100}],brightness:[{key:"value",value:0,min:-1,max:1,step:.05}],
 sharpen:[{key:"amount",value:1,min:-2,max:5,step:.1}],vignette:[{key:"angle",value:.63,min:0,max:1.57,step:.05}],
 chromaKey:[{key:"similarity",value:.15,min:.01,max:1,step:.01},{key:"blend",value:.05,min:0,max:1,step:.01}],grayscale:[],hflip:[],vflip:[]
};
function makeEffect(type:string):EffectInstance{
 const fields=(Object.hasOwn(audio,type)?audio[type]:Object.hasOwn(video,type)?video[type]:undefined)??[];
 return{id:crypto.randomUUID(),type,enabled:true,version:1,parameters:type==="equalizer"?{bands:[{frequency:100,q:1,gainDb:0},{frequency:1000,q:1,gainDb:0},{frequency:8000,q:1,gainDb:0}]}:{...Object.fromEntries(fields.map(field=>[field.key,field.value])),...(type==="chromaKey"?{color:"#00ff00"}:{})}};
}
export function EffectStack({effects,kind,label,onChange}:{effects:EffectInstance[];kind:"audio"|"video";label:string;onChange(effects:EffectInstance[]):void}){
 const catalog=kind==="audio"?audio:video,[choice,setChoice]=useState(kind==="audio"?"equalizer":"color");
 const update=(id:string,patch:Partial<EffectInstance>)=>onChange(effects.map(effect=>effect.id===id?{...effect,...patch}:effect));
 const reorder=(index:number,delta:number)=>{const next=[...effects],target=index+delta;if(target<0||target>=next.length)return;[next[index],next[target]]=[next[target]!,next[index]!];onChange(next);};
 return <fieldset><legend>{label}</legend>
  <label>New {label} effect<select value={choice} onChange={event=>setChoice(event.target.value)}>{Object.keys(catalog).map(type=><option key={type}>{type}</option>)}</select></label>
  <button disabled={effects.length>=64||(choice==="loudness"&&effects.some(effect=>effect.type==="loudness"))} onClick={()=>onChange([...effects,makeEffect(choice)])}>Add {label} effect</button>
  {effects.map((effect,index)=><fieldset key={effect.id}><legend>{index+1}. {effect.type}</legend>
   <label className="check"><input type="checkbox" checked={effect.enabled} onChange={event=>update(effect.id,{enabled:event.target.checked})}/>Enable {label} {effect.type} {index+1}</label>
   <button aria-label={"Move "+label+" effect "+(index+1)+" up"} disabled={index===0} onClick={()=>reorder(index,-1)}>↑</button>
   <button aria-label={"Move "+label+" effect "+(index+1)+" down"} disabled={index===effects.length-1} onClick={()=>reorder(index,1)}>↓</button>
   <button onClick={()=>onChange(effects.filter(item=>item.id!==effect.id))}>Remove {label} {effect.type} {index+1}</button>
   {(Object.hasOwn(catalog,effect.type)?catalog[effect.type]!:[]).map(field=><label key={field.key}>{label} {effect.type} {field.key}<input key={String(effect.parameters[field.key])} type="number" min={field.min} max={field.max} step={field.step??1} defaultValue={Number(effect.parameters[field.key]??field.value)} onBlur={event=>{if(event.currentTarget.checkValidity())update(effect.id,{parameters:{...effect.parameters,[field.key]:event.currentTarget.valueAsNumber}});}}/></label>)}
   {effect.type==="chromaKey"&&<label>Key color<input defaultValue={String(effect.parameters.color??"#00ff00")} onBlur={event=>update(effect.id,{parameters:{...effect.parameters,color:event.target.value}})}/></label>}
   {effect.type==="equalizer"&&(Array.isArray(effect.parameters.bands)?effect.parameters.bands:[]).map((band:Record<string,number>,bandIndex)=><div key={bandIndex}>{(["frequency","q","gainDb"] as const).map(key=><label key={key}>{label} EQ band {bandIndex+1} {key}<input type="number" min={key==="frequency"?20:key==="q"?.1:-24} max={key==="frequency"?20000:key==="q"?20:24} step={key==="frequency"?1:.1} defaultValue={band[key]} onBlur={event=>{if(!event.currentTarget.checkValidity())return;const bands=structuredClone(effect.parameters.bands as Record<string,number>[]);bands[bandIndex]![key]=event.currentTarget.valueAsNumber;update(effect.id,{parameters:{...effect.parameters,bands}});}}/></label>)}</div>)}
  </fieldset>)}
 </fieldset>;
}
export function ClipAudioTools({clip,sequence,onMutate}:{clip:Clip;sequence:Sequence;onMutate(commands:ProjectCommand[]):Promise<void>}){
 const patch=(audio:Clip["audio"])=>void onMutate([{type:"clip.update",sequenceId:sequence.id,clipId:clip.id,patch:{audio}}]);
 return <><fieldset><legend>Pan and fades</legend><label>Clip pan<input type="number" min="-1" max="1" step=".05" defaultValue={clip.audio.pan} key={clip.id+"pan"+clip.audio.pan} onBlur={event=>{if(event.currentTarget.checkValidity())patch({...clip.audio,pan:event.currentTarget.valueAsNumber});}}/></label>
 {(["fadeInTick","fadeOutTick"] as const).map(key=><label key={key}>{key==="fadeInTick"?"Fade in":"Fade out"} seconds<input type="number" min="0" max={ticksToSeconds(clip.durationTick)} step=".01" defaultValue={ticksToSeconds(clip.audio[key])} onBlur={event=>{if(event.currentTarget.checkValidity())patch({...clip.audio,[key]:secondsToTicks(event.currentTarget.valueAsNumber)});}}/></label>)}
 <button onClick={()=>patch({...clip.audio,effects:[makeEffect("highpass"),makeEffect("compressor"),makeEffect("deesser"),makeEffect("limiter")]})}>Apply dialogue chain</button></fieldset>
 <EffectStack effects={clip.audio.effects} kind="audio" label="Clip audio" onChange={effects=>patch({...clip.audio,effects})}/>
 <EffectStack effects={clip.effects} kind="video" label="Clip video" onChange={effects=>void onMutate([{type:"clip.update",sequenceId:sequence.id,clipId:clip.id,patch:{effects}}])}/>
 </>;
}
export function AudioMixer({sequence,onMutate}:{sequence:Sequence|undefined;onMutate(commands:ProjectCommand[]):Promise<void>}){
 if(!sequence)return null;
 return <details className="audio-mixer"><summary>Audio mixer and track processing</summary><p>Track effects run after the clips are mixed. Build the program preview to audition the same processing used by export.</p><div>
 {sequence.tracks.filter(track=>track.type==="audio"||track.type==="video").map(track=><fieldset key={track.id}><legend>{track.name}</legend>
 <label>Track gain {track.name}<input type="number" min="-120" max="24" step=".5" defaultValue={track.gainDb} key={track.gainDb} onBlur={event=>{if(event.currentTarget.checkValidity())void onMutate([{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{gainDb:event.currentTarget.valueAsNumber}}]);}}/></label>
 <label>Track pan {track.name}<input type="number" min="-1" max="1" step=".05" defaultValue={track.pan} key={track.pan} onBlur={event=>{if(event.currentTarget.checkValidity())void onMutate([{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{pan:event.currentTarget.valueAsNumber}}]);}}/></label>
 <EffectStack effects={track.effects??[]} kind="audio" label={track.name} onChange={effects=>void onMutate([{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{effects}}])}/>
 </fieldset>)}</div></details>;
}
