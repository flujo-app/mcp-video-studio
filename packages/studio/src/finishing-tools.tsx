import React,{useState} from "react";
import {framesToTicks,ticksToFrames,ticksToSeconds,secondsToTicks,ticksPerSample,type Clip,type ProjectCommand,type Sequence,type StudioProject} from "@mcp-video-studio/contracts";
export function ClipFinishing({project,sequence,clip,onMutate}:{project:StudioProject;sequence:Sequence;clip:Clip;onMutate(commands:ProjectCommand[]):Promise<void>}){
 const [duration,setDuration]=useState(.4),[style,setStyle]=useState("crossfade");
 const patch=(value:Partial<Clip>)=>void onMutate([{type:"clip.update",sequenceId:sequence.id,clipId:clip.id,patch:value}]);
 const outgoing=sequence.transitions.find(transition=>transition.fromClipId===clip.id);
 const next=sequence.clips.find(item=>item.trackId===clip.trackId&&item.startTick===clip.startTick+clip.durationTick);
 const speed=(rate:number)=>{
  if(!Number.isFinite(rate)||rate<.01||rate>16)return;
  const ids=new Set([clip.id]);let grew=true;while(grew){grew=false;for(const item of sequence.clips)if(!ids.has(item.id)&&sequence.clips.filter(c=>ids.has(c.id)).some(c=>(c.groupId&&c.groupId===item.groupId)||(c.linkedGroupId&&c.linkedGroupId===item.linkedGroupId))){ids.add(item.id);grew=true;}}
  const factor=rate/(clip.playbackRate.numerator/clip.playbackRate.denominator);
  void onMutate(sequence.clips.filter(item=>ids.has(item.id)).map(item=>{
   const oldRate=item.playbackRate.numerator/item.playbackRate.denominator,newRate=oldRate*factor,raw=item.durationTick/factor,track=sequence.tracks.find(track=>track.id===item.trackId),sample=ticksPerSample(project.settings.sampleRate);
   const durationTick=track?.type==="audio"?Math.max(sample,Math.floor(raw/sample)*sample):framesToTicks(Math.max(1,ticksToFrames(Math.floor(raw),project.settings.fps,"floor")),project.settings.fps);
   return{type:"clip.update",sequenceId:sequence.id,clipId:item.id,patch:{playbackRate:{numerator:Math.round(newRate*1000000),denominator:1000000},durationTick,audio:{...item.audio,fadeInTick:Math.min(item.audio.fadeInTick,durationTick),fadeOutTick:Math.min(item.audio.fadeOutTick,Math.max(0,durationTick-item.audio.fadeInTick))}}};
  }));
 };
 return <>
  <fieldset><legend>Scale, crop and compositing</legend>
   {([0,1] as const).map(axis=><label key={axis}>Scale {axis?"Y":"X"}<input type="number" min="-8" max="8" step=".05" defaultValue={clip.transform.scale[axis]} onBlur={event=>{if(event.currentTarget.checkValidity()){const scale=[...clip.transform.scale] as [number,number];scale[axis]=event.currentTarget.valueAsNumber;patch({transform:{...clip.transform,scale}});}}}/></label>)}
   {(["left","right","top","bottom"] as const).map(edge=><label key={edge}>Crop {edge}<input type="number" min="0" max=".95" step=".01" defaultValue={clip.crop[edge]} onBlur={event=>{if(event.currentTarget.checkValidity())patch({crop:{...clip.crop,[edge]:event.currentTarget.valueAsNumber}});}}/></label>)}
   <label>Blend mode<select value={clip.blendMode} onChange={event=>patch({blendMode:event.target.value as Clip["blendMode"]})}>{["normal","multiply","screen","overlay","darken","lighten","difference"].map(mode=><option key={mode}>{mode}</option>)}</select></label>
   <label>Playback speed<input type="number" min=".01" max="16" step=".05" defaultValue={clip.playbackRate.numerator/clip.playbackRate.denominator} key={clip.playbackRate.numerator+"/"+clip.playbackRate.denominator} onBlur={event=>{if(event.currentTarget.checkValidity())speed(event.currentTarget.valueAsNumber);}}/></label>
   <p className="hint">Speed retains the source interval and changes clip duration. Linked clips change together; audio keeps its pitch.</p>
  </fieldset>
  <fieldset><legend>Transition at outgoing cut</legend>
   <label>Transition style<select value={outgoing?.type??style} onChange={event=>{setStyle(event.target.value);if(outgoing)void onMutate([{type:"transition.update",sequenceId:sequence.id,transitionId:outgoing.id,patch:{type:event.target.value}}]);}}>{["crossfade","wipeleft","wiperight","cut"].map(type=><option key={type}>{type}</option>)}</select></label>
   <label>Transition seconds<input type="number" min=".001" step="any" key={outgoing?.durationTick??clip.id} defaultValue={outgoing?ticksToSeconds(outgoing.durationTick):duration} onChange={event=>setDuration(event.target.valueAsNumber)} onBlur={event=>{if(outgoing&&event.currentTarget.checkValidity())void onMutate([{type:"transition.update",sequenceId:sequence.id,transitionId:outgoing.id,patch:{durationTick:framesToTicks(Math.max(1,ticksToFrames(secondsToTicks(event.currentTarget.valueAsNumber),project.settings.fps,"round")),project.settings.fps)}}]);}}/></label>
   {!outgoing&&<button disabled={!next||!Number.isFinite(duration)||duration<=0} onClick={()=>{if(next)void onMutate([{type:"transition.add",sequenceId:sequence.id,transition:{id:crypto.randomUUID(),sequenceId:sequence.id,fromClipId:clip.id,toClipId:next.id,type:style,durationTick:framesToTicks(Math.max(1,ticksToFrames(secondsToTicks(duration),project.settings.fps,"round")),project.settings.fps),parameters:{}}}]);}}>Add transition to next clip</button>}
   {outgoing&&<button onClick={()=>void onMutate([{type:"transition.remove",sequenceId:sequence.id,transitionId:outgoing.id}])}>Remove outgoing transition</button>}
   <p className="hint">Transitions are centered on an adjacent cut. Trim finite media first to leave source handles on both sides.</p>
  </fieldset>
 </>;
}
