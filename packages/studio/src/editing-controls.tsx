import React,{useEffect,useRef,useState} from "react";
import {framesToTicks,secondsToTicks,ticksToFrames,ticksToSeconds,type ProjectCommand,type Sequence,type StudioProject} from "@mcp-video-studio/contracts";
export function TimelineReviewControls({project,sequence,selectedId,onMutate,onSeek}:{project:StudioProject;sequence:Sequence;selectedId:string|undefined;onMutate(commands:ProjectCommand[]):Promise<void>;onSeek(tick:number):void}){
 const clip=sequence.clips.find(c=>c.id===selectedId),next=clip&&sequence.clips.find(c=>c.trackId===clip.trackId&&c.startTick===clip.startTick+clip.durationTick);
 const current=sequence.transitions.find(t=>t.fromClipId===selectedId),[frames,setFrames]=useState(12),[kind,setKind]=useState("crossfade"),[markerId,setMarkerId]=useState("");
 const marker=sequence.markers.find(m=>m.id===markerId);
 useEffect(()=>{if(current){setFrames(ticksToFrames(current.durationTick,project.settings.fps,"round"));setKind(current.type);}},[current?.id,current?.durationTick,current?.type]);
 const valid=Number.isSafeInteger(frames)&&frames>0;
 const save=()=>{if(!clip||!next||!valid)return;const durationTick=framesToTicks(frames,project.settings.fps);void onMutate([current?{type:"transition.update",sequenceId:sequence.id,transitionId:current.id,patch:{type:kind,durationTick}}:{type:"transition.add",sequenceId:sequence.id,transition:{id:crypto.randomUUID(),sequenceId:sequence.id,fromClipId:clip.id,toClipId:next.id,type:kind,durationTick,parameters:{}}}]);};
 return <details className="editing-review"><summary>Transitions and markers</summary><div>
 <fieldset><legend>Outgoing transition</legend><p>{clip?clip.name+" → "+(next?.name??"No adjacent clip"):"Select the left clip of a cut."}</p>
 <label>Transition type<select aria-label="Transition type" value={kind} onChange={e=>setKind(e.target.value)}><option value="crossfade">Crossfade</option><option value="wipeleft">Wipe left</option><option value="wiperight">Wipe right</option></select></label>
 <label>Transition duration (frames)<input type="number" min="1" step="1" value={frames} onChange={e=>setFrames(e.currentTarget.valueAsNumber)}/></label>
 <input aria-label="Visual transition duration" type="range" min="1" max="120" value={Number.isFinite(frames)?Math.min(120,frames):1} onChange={e=>setFrames(Number(e.target.value))}/>
 <button disabled={!next||!valid} onClick={save}>{current?"Update transition":"Add transition"}</button>
 <button disabled={!current} onClick={()=>current&&void onMutate([{type:"transition.remove",sequenceId:sequence.id,transitionId:current.id}])}>Remove transition</button><p>Centered transitions require source handles on both sides of the cut.</p></fieldset>
 <fieldset><legend>Timeline markers</legend><label>Selected marker<select aria-label="Selected marker" value={markerId} onChange={e=>setMarkerId(e.target.value)}><option value="">Choose marker</option>{sequence.markers.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
 {marker&&<React.Fragment key={marker.id}><label>Edit marker label<input defaultValue={marker.label} onBlur={e=>{const label=e.target.value.trim();if(label&&label!==marker.label)void onMutate([{type:"marker.update",sequenceId:sequence.id,markerId:marker.id,patch:{label}}]);}}/></label>
 <label>Marker position (seconds)<input type="number" min="0" step={ticksToSeconds(framesToTicks(1,project.settings.fps))} defaultValue={ticksToSeconds(marker.tick)} onBlur={e=>{const value=e.currentTarget.valueAsNumber;if(Number.isFinite(value)&&value>=0)void onMutate([{type:"marker.update",sequenceId:sequence.id,markerId:marker.id,patch:{tick:framesToTicks(ticksToFrames(secondsToTicks(value),project.settings.fps,"round"),project.settings.fps)}}]);}}/></label>
 <button onClick={()=>onSeek(marker.tick)}>Seek to marker</button><button onClick={()=>void onMutate([{type:"marker.remove",sequenceId:sequence.id,markerId:marker.id}])}>Delete marker</button></React.Fragment>}
 </fieldset></div></details>;
}
export function PlaybackControls({project,sequence,playhead,onSeek,video,sourceKey}:{project:StudioProject;sequence:Sequence;playhead:number;onSeek(tick:number):void;video:React.RefObject<HTMLVideoElement|null>;sourceKey:string}){
 const frame=framesToTicks(1,project.settings.fps),end=Math.max(frame,...sequence.clips.map(c=>c.startTick+c.durationTick),...sequence.captions.map(c=>c.startTick+c.durationTick));
 const [start,setStart]=useState(0),[out,setOut]=useState(0),[loop,setLoop]=useState(false),[rate,setRate]=useState(0);
 const last=useRef(playhead);last.current=playhead;
 const endTick=out>start?Math.min(out,end):end;
 const seek=(tick:number)=>{const value=Math.max(0,Math.min(secondsToTicks(86400),framesToTicks(ticksToFrames(tick,project.settings.fps,"round"),project.settings.fps)));onSeek(value);if(video.current)video.current.currentTime=ticksToSeconds(value);};
 useEffect(()=>{setStart(0);setOut(0);setRate(0);setLoop(false);},[sequence.id]);
 useEffect(()=>{
  const media=video.current;if(!media)return;
  const limit=()=>{if(loop&&media.currentTime>=ticksToSeconds(endTick)){media.currentTime=ticksToSeconds(start);onSeek(start);}};
  media.addEventListener("timeupdate",limit);return()=>media.removeEventListener("timeupdate",limit);
 },[video,sourceKey,start,endTick,loop,onSeek]);
 useEffect(()=>{
  if(!rate)return;video.current?.pause();let previous=performance.now(),carry=0;
  const timer=setInterval(()=>{const now=performance.now();carry+=(now-previous)/1000*Math.abs(rate)*project.settings.fps.numerator/project.settings.fps.denominator;previous=now;const count=Math.floor(carry);if(!count)return;carry-=count;
   let value=last.current+Math.sign(rate)*count*frame;
   if(loop){if(value>=endTick)value=start;if(value<start)value=endTick-frame;}else if(value<0||value>=end){setRate(0);value=Math.max(0,Math.min(end-frame,value));}
   last.current=value;onSeek(value);if(video.current)video.current.currentTime=ticksToSeconds(value);
  },30);return()=>clearInterval(timer);
 },[rate,frame,start,endTick,end,loop,onSeek,project.settings.fps,video]);
 useEffect(()=>{const key=(e:KeyboardEvent)=>{const target=e.target as HTMLElement;if(e.ctrlKey||e.metaKey||e.altKey||target.closest("input,textarea,select,[contenteditable=true],[role=dialog]"))return;
  if(!["j","k","l","i","o"].includes(e.key.toLowerCase()))return;e.preventDefault();
  if(e.key.toLowerCase()==="j")setRate(value=>value<0?Math.max(-4,value*2):-1);
  if(e.key.toLowerCase()==="k"){setRate(0);video.current?.pause();}
  if(e.key.toLowerCase()==="l")setRate(value=>value>0?Math.min(4,value*2):1);
  if(e.key.toLowerCase()==="i")setStart(playhead);
  if(e.key.toLowerCase()==="o")setOut(Math.min(end,playhead+frame));
 };document.addEventListener("keydown",key);return()=>document.removeEventListener("keydown",key);},[playhead,end,frame,video]);
 return <details className="playback-review"><summary>Review range and jog</summary><div>
 <label>Playhead (seconds)<input key={playhead} type="number" min="0" step={ticksToSeconds(frame)} defaultValue={ticksToSeconds(playhead)} onBlur={e=>{if(Number.isFinite(e.currentTarget.valueAsNumber)){setRate(0);seek(secondsToTicks(e.currentTarget.valueAsNumber));}}}/></label>
 <button onClick={()=>{setRate(0);seek(playhead-frame);}}>Jog previous frame</button><button onClick={()=>{setRate(0);seek(playhead+frame);}}>Jog next frame</button>
 <button aria-pressed={rate<0} onClick={()=>setRate(value=>value<0?Math.max(-4,value*2):-1)}>Reverse shuttle (J)</button><button onClick={()=>{setRate(0);video.current?.pause();}}>Stop shuttle (K)</button><button aria-pressed={rate>0} onClick={()=>setRate(value=>value>0?Math.min(4,value*2):1)}>Forward shuttle (L)</button><output aria-live="polite">{rate}× jog</output>
 <button onClick={()=>setStart(playhead)}>Mark in (I)</button><button onClick={()=>setOut(Math.min(end,playhead+frame))}>Mark out (O)</button><button onClick={()=>seek(start)}>Go to in</button><button onClick={()=>seek(endTick-frame)}>Go to out</button>
 <label><input type="checkbox" checked={loop} onChange={e=>setLoop(e.target.checked)}/>Loop review range</label><output aria-label="Review range">{ticksToSeconds(start).toFixed(3)}–{ticksToSeconds(endTick).toFixed(3)} seconds</output>
 </div></details>;
}
export function useTimelineMarquee(sequence:Sequence|undefined,selected:string[],zoom:number,onSelect:(ids:string[])=>void,onSeek:(tick:number)=>void){
 const [box,setBox]=useState<{left:number;top:number;width:number;height:number}>();
 const cleanup=useRef<()=>void>(()=>{});useEffect(()=>()=>cleanup.current(),[]);
 const begin=(event:React.PointerEvent<HTMLDivElement>)=>{
  if(event.button!==0||!(event.target instanceof HTMLElement)||!event.target.classList.contains("lane")||!sequence)return;
  event.preventDefault();const owner=event.currentTarget,rect=owner.getBoundingClientRect(),x0=event.clientX-rect.left,y0=event.clientY-rect.top,base=event.ctrlKey||event.metaKey||event.shiftKey?selected:[];
  let moved=false;
  const move=(e:PointerEvent)=>{const bounds=owner.getBoundingClientRect(),x=e.clientX-bounds.left,y=e.clientY-bounds.top;if(Math.abs(x-x0)+Math.abs(y-y0)<4&&!moved)return;moved=true;
   const area={left:Math.max(0,Math.min(x0,x)),top:Math.min(y0,y),width:Math.abs(x-x0),height:Math.abs(y-y0)};setBox(area);
   const start=secondsToTicks(area.left/zoom),end=secondsToTicks((area.left+area.width)/zoom),tracks=new Set<string>();
   for(const lane of owner.querySelectorAll<HTMLElement>(".lane")){const b=lane.getBoundingClientRect();if(b.bottom>=bounds.top+area.top&&b.top<=bounds.top+area.top+area.height)tracks.add(lane.dataset.trackId!);}
   onSelect([...new Set([...base,...sequence.clips.filter(c=>tracks.has(c.trackId)&&c.startTick<end&&c.startTick+c.durationTick>start).map(c=>c.id)])]);
  };
  const finish=()=>{cleanup.current();setBox(undefined);if(!moved)onSeek(secondsToTicks(Math.max(0,x0)/zoom));};
  cleanup.current=()=>{document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",finish);document.removeEventListener("pointercancel",finish);};
  document.addEventListener("pointermove",move);document.addEventListener("pointerup",finish,{once:true});document.addEventListener("pointercancel",finish,{once:true});
 };
 return{begin,overlay:box?<div className="timeline-marquee" style={box} aria-hidden="true"/>:null};
}
