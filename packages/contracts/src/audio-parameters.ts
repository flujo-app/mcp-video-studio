import type { EffectInstance, Sequence } from "./types.js";

export interface AudioField { key: string; value: number; min: number; max: number; step?: number }
export const AUDIO_FIELDS: Record<string, AudioField[]> = {
 highpass:[{key:"frequency",value:80,min:1,max:20000}],lowpass:[{key:"frequency",value:16000,min:1,max:20000}],
 compressor:[{key:"threshold",value:.125,min:.00097563,max:1,step:.01},{key:"ratio",value:4,min:1,max:20},{key:"attack",value:20,min:.01,max:2000},{key:"release",value:250,min:.01,max:9000}],
 limiter:[{key:"limit",value:.891,min:.0625,max:1,step:.01}],
 delay:[{key:"delayMs",value:250,min:1,max:2000},{key:"decay",value:.3,min:0,max:.9,step:.05}],
 gate:[{key:"threshold",value:.03,min:0,max:1,step:.01},{key:"ratio",value:4,min:1,max:9000},{key:"attack",value:20,min:.01,max:9000},{key:"release",value:250,min:.01,max:9000}],
 deesser:[{key:"intensity",value:.5,min:0,max:1,step:.05},{key:"amount",value:.5,min:0,max:1,step:.05},{key:"frequency",value:.5,min:0,max:1,step:.05}],
 reverb:[{key:"mix",value:.5,min:0,max:1,step:.05}],
 loudness:[{key:"targetLufs",value:-16,min:-70,max:-5},{key:"truePeakDb",value:-1,min:-9,max:0,step:.1},{key:"rangeLu",value:7,min:1,max:50}],
 equalizer:[]
};
export function effectFields(effect: EffectInstance): AudioField[] {
 if(effect.type !== "equalizer") return Object.hasOwn(AUDIO_FIELDS,effect.type)?AUDIO_FIELDS[effect.type]!: [];
 return (Array.isArray(effect.parameters.bands)?effect.parameters.bands:[]).flatMap((_,index)=>[
  {key:"bands."+index+".frequency",value:1000,min:20,max:20000},
  {key:"bands."+index+".q",value:1,min:.1,max:20,step:.1},
  {key:"bands."+index+".gainDb",value:0,min:-24,max:24,step:.1}
 ]);
}
export interface AudioDuckingCommand {type:"audio.duck";sequenceId:string;musicTrackId:string;voiceTrackIds:string[];attenuationDb:number;attackTick:number;releaseTick:number}
export interface AudioParameterRangeCommand {
 type: "audio.parameter.range"; sequenceId: string; targetType: "clip"|"track"; targetId: string;
 parameter: "pan"|"effect"; effectId?: string; parameterKey?: string;
 startTick: number; endTick: number; value: number;
}
export function parameterTarget(command: Pick<AudioParameterRangeCommand,"targetType"|"targetId"|"parameter"|"effectId"|"parameterKey">): string {
 if(command.targetId.includes(":")||command.effectId?.includes(":")) throw new Error("Audio range target IDs must not contain colons.");
 if(command.parameter==="effect"&&(!command.effectId||!command.parameterKey)) throw new Error("Choose an existing effect and numeric parameter.");
 return command.targetType+":"+command.targetId+":audio."+command.parameter+(command.parameter==="effect"?":"+command.effectId+":"+command.parameterKey:"");
}
export function isAudioParameterTarget(target:string):boolean { return /^(clip|track):[^:]+:audio\./.test(target); }
/** Resolve only allowlisted numeric fields. No expression, arbitrary property path or prototype access. */
export function resolveAudioParameter(sequence:Sequence,target:string):{base:number;field:AudioField;set(value:number):void} {
 const match=/^(clip|track):([^:]+):audio\.(pan|effect)(?::([^:]+):([a-zA-Z0-9.]+))?$/.exec(target);
 if(!match)throw new Error("Unknown audio parameter target.");
 const owner=match[1]==="clip"?sequence.clips.find(clip=>clip.id===match[2]):sequence.tracks.find(track=>track.id===match[2]);
 if(!owner)throw new Error("Audio parameter target no longer exists.");
 const audio="audio" in owner?owner.audio:owner;
 if(match[3]==="pan"){
  if(match[4])throw new Error("Pan has no effect parameter.");
  return {base:audio.pan,field:{key:"pan",value:0,min:-1,max:1,step:.05},set(value){audio.pan=value;}};
 }
 const effect=(audio.effects??[]).find(effect=>effect.id===match[4]);
 if(!effect)throw new Error("Audio range effect no longer exists; remove its automation before removing the effect.");
 const field=effectFields(effect).find(field=>field.key===match[5]);
 if(!field)throw new Error("Unsupported audio effect parameter.");
 let parameters=effect.parameters;
 const band=/^bands\.(\d+)\.(frequency|q|gainDb)$/.exec(field.key);
 let key=field.key;
 if(band){parameters=(effect.parameters.bands as Record<string,unknown>[])[Number(band[1])]!;key=band[2]!;}
 const base=parameters[key]??field.value;
 if(typeof base!=="number"||!Number.isFinite(base)||base<field.min||base>field.max)throw new Error("Invalid base audio parameter.");
 return{base,field,set(value){parameters[key]=value;}};
}
