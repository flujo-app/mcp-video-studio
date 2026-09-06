import React,{useEffect,useState} from "react";
import {MaskParametersSchema,type Clip,type EffectInstance,type MaskParameters,type ProjectCommand,type Sequence} from "@mcp-video-studio/contracts";
function MaskEditor({effect,index,onChange,onRemove}:{effect:EffectInstance;index:number;onChange(effect:EffectInstance):void;onRemove():void}){
 const [draft,setDraft]=useState(MaskParametersSchema.parse(effect.parameters)),[error,setError]=useState("");
 useEffect(()=>{const parsed=MaskParametersSchema.safeParse(effect.parameters);if(parsed.success)setDraft(parsed.data);},[effect.parameters]);
 const set=(key:keyof MaskParameters,value:number|string|boolean)=>setDraft(current=>({...current,[key]:value}));
 const save=()=>{const parsed=MaskParametersSchema.safeParse(draft);if(!parsed.success){setError(parsed.error.issues[0]?.message??"Invalid mask geometry.");return;}setError("");onChange({...effect,parameters:parsed.data});};
 return <fieldset><legend>Mask {index}</legend>
 <label><input type="checkbox" checked={effect.enabled} onChange={event=>onChange({...effect,enabled:event.target.checked})}/>Enable mask {index}</label>
 <label>Mask {index} shape<select aria-label={"Mask "+index+" shape"} value={draft.shape} onChange={event=>set("shape",event.target.value)}><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option></select></label>
 {(["x","y","width","height","feather","opacity"] as const).map(key=><label key={key}>Mask {index} {key}<input type="number" min={key==="width"||key==="height"?.001:0} max={key==="feather"?.5:1} step=".01" value={Number.isFinite(draft[key])?draft[key]:""} onChange={event=>set(key,event.target.valueAsNumber)}/></label>)}
 <label><input type="checkbox" checked={draft.invert} onChange={event=>set("invert",event.target.checked)}/>Mask {index} invert</label>
 {error&&<p role="alert">{error}</p>}<button onClick={save}>Apply mask {index}</button><button onClick={onRemove}>Remove mask {index}</button>
 </fieldset>;
}
export function ClipMaskControls({clip,sequence,onMutate}:{clip:Clip;sequence:Sequence;onMutate(commands:ProjectCommand[]):Promise<void>}){
 const masks=clip.effects.filter(effect=>effect.type==="mask");
 const update=(effects:EffectInstance[])=>void onMutate([{type:"clip.update",sequenceId:sequence.id,clipId:clip.id,patch:{effects}}]);
 const add=(shape:"rectangle"|"ellipse")=>update([...clip.effects,{id:crypto.randomUUID(),type:"mask",enabled:true,version:1,parameters:MaskParametersSchema.parse({shape})}]);
 return <fieldset><legend>Geometric clip masks</legend><p>Bounds are fractions of the transformed clip rectangle. Masks multiply its alpha after color effects; overlapping masks intersect. Build preview to review.</p>
 <button disabled={clip.effects.length>=64} onClick={()=>add("rectangle")}>Add rectangle mask</button><button disabled={clip.effects.length>=64} onClick={()=>add("ellipse")}>Add ellipse mask</button>
 {masks.map((effect,index)=><MaskEditor key={effect.id} effect={effect} index={index+1} onChange={changed=>update(clip.effects.map(item=>item.id===changed.id?changed:item))} onRemove={()=>update(clip.effects.filter(item=>item.id!==effect.id))}/>)}
 </fieldset>;
}
