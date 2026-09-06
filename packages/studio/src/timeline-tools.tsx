import React,{useEffect,useRef,useState} from "react";
import {framesToTicks,ticksToFrames,secondsToTicks,type Clip,type ProjectCommand,type Sequence,type StudioProject,type AutomationLane} from "@mcp-video-studio/contracts";
export function useModalFocus(active:boolean):void {
 useEffect(()=>{
  if(!active)return;
  const backdrop=document.querySelector<HTMLElement>(".modal-backdrop"),dialog=backdrop?.firstElementChild as HTMLElement|null;
  if(!backdrop||!dialog)return;
  const previous=document.activeElement as HTMLElement|null,restore:Array<[HTMLElement,boolean]>=[];
  for(let child:HTMLElement|null=backdrop;child?.parentElement&&child.parentElement!==document.body;child=child.parentElement){
   for(const sibling of Array.from(child.parentElement.children))if(sibling!==child&&sibling instanceof HTMLElement){restore.push([sibling,sibling.inert]);sibling.inert=true;}
  }
  dialog.setAttribute("role","dialog");dialog.setAttribute("aria-modal","true");
  const title=dialog.querySelector("h1,h2,h3");if(title){if(!title.id)title.id="dialog-"+crypto.randomUUID();dialog.setAttribute("aria-labelledby",title.id);}
  const focusable=()=>Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')).filter(item=>item.getClientRects().length>0);
  const items=focusable();(items[0]??dialog).focus();
  const key=(event:KeyboardEvent)=>{
   if(event.key==="Escape"){const close=dialog.querySelector<HTMLButtonElement>("button.close,button[aria-label^='Close']");if(close){event.preventDefault();event.stopPropagation();close.click();}return;}
   if(event.key!=="Tab")return;
   const current=focusable(),first=current[0],last=current.at(-1);
   if(!first){event.preventDefault();return;}
   if(event.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){event.preventDefault();last?.focus();}
   else if(!event.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){event.preventDefault();first.focus();}
  };
  document.addEventListener("keydown",key,true);
  return()=>{document.removeEventListener("keydown",key,true);for(const [item,inert] of restore)item.inert=inert;if(previous?.isConnected)previous.focus();};
 },[active]);
}
type Clipboard={projectId:string;clips:Clip[];automation:AutomationLane[]};
export function SelectionTools({project,sequence,selectedIds,playhead,onSelect,onMutate,ripple}:{project:StudioProject|undefined;sequence:Sequence|undefined;selectedIds:string[];playhead:number;onSelect(ids:string[]):void;onMutate(commands:ProjectCommand[]):Promise<void>;ripple:boolean}){
 const clipboard=useRef<Clipboard|undefined>(undefined),[copied,setCopied]=useState(false),[rangeStart,setRangeStart]=useState(0),[rangeEnd,setRangeEnd]=useState(5),[markerLabel,setMarkerLabel]=useState("Review");
 const selection=()=> {
  if(!sequence)return[];
  const ids=new Set(selectedIds);let grew=true;
  while(grew){grew=false;const selected=sequence.clips.filter(clip=>ids.has(clip.id));for(const clip of sequence.clips)if(!ids.has(clip.id)&&selected.some(item=>(item.groupId&&item.groupId===clip.groupId)||(item.linkedGroupId&&item.linkedGroupId===clip.linkedGroupId))){ids.add(clip.id);grew=true;}}
  return sequence.clips.filter(clip=>ids.has(clip.id));
 };
 const copy=()=>{
  if(!project||!sequence)return;
  const clips=selection();if(!clips.length)return;
  clipboard.current={projectId:project.projectId,clips:structuredClone(clips),automation:structuredClone(sequence.automation.filter(lane=>clips.some(clip=>lane.target.startsWith("clip:"+clip.id+":"))))};setCopied(true);
 };
 const paste=async(at=playhead)=>{
  const data=clipboard.current;if(!project||!sequence||!data||data.projectId!==project.projectId)return;
  const aligned=framesToTicks(ticksToFrames(at,project.settings.fps,"round"),project.settings.fps),offset=aligned-Math.min(...data.clips.map(clip=>clip.startTick));
  const ids=new Map(data.clips.map(clip=>[clip.id,crypto.randomUUID()])),groups=new Map<string,string>();
  const relation=(kind:string,id:string)=>{const key=kind+id;let value=groups.get(key);if(!value){value=crypto.randomUUID();groups.set(key,value);}return value;};
  const commands:ProjectCommand[]=data.clips.map(original=>{
   const clip=structuredClone(original);clip.id=ids.get(original.id)!;clip.startTick+=offset;clip.name+=" copy";
   if(clip.groupId)clip.groupId=relation("group",clip.groupId);if(clip.linkedGroupId)clip.linkedGroupId=relation("link",clip.linkedGroupId);
   return{type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"};
  });
  for(const lane of data.automation){const target=lane.target.split(":"),replacement=ids.get(target[1]!);if(replacement)commands.push({type:"automation.set",sequenceId:sequence.id,lane:{...structuredClone(lane),id:crypto.randomUUID(),target:"clip:"+replacement+":"+target.slice(2).join(":"),points:lane.points.map(point=>({...point,tick:Math.max(0,point.tick+offset)}))}});}
  await onMutate(commands);onSelect([...ids.values()]);
 };
 const duplicate=async()=>{const clips=selection();if(!clips.length)return;copy();await paste(Math.max(...clips.map(clip=>clip.startTick+clip.durationTick)));};
 const relate=(relation:"group"|"link",clear=false)=>{if(sequence&&selectedIds.length)void onMutate([{type:"clip.relate",sequenceId:sequence.id,clipIds:selection().map(clip=>clip.id),relation,relationshipId:clear?null:crypto.randomUUID()}]);};
 const remove=async()=>{if(sequence&&selectedIds.length){await onMutate([{type:"clip.remove",sequenceId:sequence.id,clipIds:selectedIds,ripple}]);onSelect([]);}};
 useEffect(()=>{
  const key=(event:KeyboardEvent)=>{
   const target=event.target as HTMLElement;
   if(target.closest("input,textarea,select,[contenteditable=true],[role=dialog]"))return;
   const mod=event.ctrlKey||event.metaKey;
   if(mod&&["a","c","v","d"].includes(event.key.toLowerCase())){event.preventDefault();const key=event.key.toLowerCase();if(key==="a")onSelect(sequence?.clips.map(clip=>clip.id)??[]);if(key==="c")copy();if(key==="v")void paste();if(key==="d")void duplicate();}
   if(event.key==="Delete"||event.key==="Backspace"){event.preventDefault();void remove();}
  };document.addEventListener("keydown",key);return()=>document.removeEventListener("keydown",key);
 });
 return <div className="selection-tools" role="group" aria-label="Timeline selection tools">
  <output aria-live="polite">{selectedIds.length} selected</output>
  <button disabled={!sequence} onClick={()=>onSelect(sequence?.clips.map(clip=>clip.id)??[])}>Select all</button>
  <button disabled={!selectedIds.length} onClick={()=>onSelect([])}>Clear selection</button>
  <button disabled={!selectedIds.length} onClick={copy}>Copy</button><button disabled={!copied||clipboard.current?.projectId!==project?.projectId} onClick={()=>void paste()}>Paste at playhead</button>
  <button disabled={!selectedIds.length} onClick={()=>void duplicate()}>Duplicate</button>
  <button disabled={!selectedIds.length} onClick={()=>relate("group")}>Group</button><button disabled={!selectedIds.length} onClick={()=>relate("group",true)}>Ungroup</button>
  <button disabled={!selectedIds.length} onClick={()=>relate("link")}>Link</button><button disabled={!selectedIds.length} onClick={()=>relate("link",true)}>Unlink</button>
  <button disabled={!selectedIds.length} onClick={()=>void remove()}>{ripple?"Ripple delete":"Delete selection"}</button>
  <label>Range start (s)<input type="number" min="0" step=".1" value={rangeStart} onChange={event=>setRangeStart(Number(event.target.value))}/></label>
  <label>Range end (s)<input type="number" min="0" step=".1" value={rangeEnd} onChange={event=>setRangeEnd(Number(event.target.value))}/></label>
  <button onClick={()=>onSelect(sequence?.clips.filter(clip=>clip.startTick<secondsToTicks(rangeEnd)&&clip.startTick+clip.durationTick>secondsToTicks(rangeStart)).map(clip=>clip.id)??[])}>Select range</button>
  <label>Marker label<input value={markerLabel} onChange={event=>setMarkerLabel(event.target.value)}/></label>
  <button disabled={!project||!sequence} onClick={()=>{if(project&&sequence)void onMutate([{type:"marker.add",sequenceId:sequence.id,marker:{id:crypto.randomUUID(),tick:framesToTicks(ticksToFrames(playhead,project.settings.fps,"round"),project.settings.fps),durationTick:0,label:markerLabel,color:"#ffb547"}}]);}}>Add marker</button>
 </div>;
}
