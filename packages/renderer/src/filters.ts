import type { Clip, EffectInstance } from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";
function bounded(value:unknown,fallback:number,min:number,max:number):number{
 const result=value===undefined?fallback:value;
 if(typeof result!=="number"||!Number.isFinite(result)||result<min||result>max)throw new StudioException("INVALID_EFFECT_PARAMETER","Effect parameter must be a finite number in ["+min+", "+max+"].","input");
 return result;
}
function effectsOf(effects:EffectInstance[]):EffectInstance[]{if(effects.length>64)throw new StudioException("EFFECT_LIMIT","Use at most 64 effects per stack.","input");return effects.filter(effect=>effect.enabled);}
function unsupported(type:string):never{throw new StudioException("UNSUPPORTED_EFFECT","Effect is not supported by the shared preview/export renderer: "+type,"input");}
function color(value:unknown):string{
 if(typeof value!=="string"||!/^(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|0x[0-9a-f]{6}(?:[0-9a-f]{2})?|[a-z]{1,24})$/i.test(value))throw new StudioException("INVALID_EFFECT_COLOR","Use a hexadecimal or named color; filter expressions are not accepted.","input");
 return value.replace(/^#/,"0x");
}
export function atempoChain(rate:number):string[]{
 if(!Number.isFinite(rate)||rate<=0)throw new RangeError("Audio tempo rate must be positive.");
 const filters:string[]=[];let value=rate;
 while(value>2){filters.push("atempo=2");value/=2;}while(value<.5){filters.push("atempo=0.5");value/=.5;}
 if(Math.abs(value-.5)<1e-9)filters.push("atempo=0.5");else if(Math.abs(value-2)<1e-9)filters.push("atempo=2");else if(Math.abs(value-1)>1e-9)filters.push("atempo="+value.toFixed(8));return filters;
}
export function videoEffectFilters(effects:EffectInstance[]):string[]{
 const result:string[]=[];
 for(const effect of effectsOf(effects)){
  const p=effect.parameters;
  switch(effect.type){
   case "color":result.push("eq=brightness="+bounded(p.brightness,0,-1,1)+":contrast="+bounded(p.contrast,1,0,10)+":saturation="+bounded(p.saturation,1,0,3));break;
   case "brightness":result.push("eq=brightness="+bounded(p.value,0,-1,1));break;
   case "blur":result.push("gblur=sigma="+bounded(p.radius,4,0,100));break;
   case "sharpen":result.push("unsharp=5:5:"+bounded(p.amount,1,-2,5));break;
   case "vignette":result.push("vignette=angle="+bounded(p.angle,Math.PI/5,0,Math.PI/2));break;
   case "chromaKey":result.push("chromakey="+color(p.color??"#00ff00")+":"+bounded(p.similarity,.15,.01,1)+":"+bounded(p.blend,.05,0,1));break;
   case "grayscale":result.push("hue=s=0");break;
   case "hflip":result.push("hflip");break;
   case "vflip":result.push("vflip");break;
   default:unsupported(effect.type);
  }
 }return result;
}
export function audioEffectFilters(effects:EffectInstance[],sampleRate=48000):string[]{
 const result:string[]=[],enabled=effectsOf(effects);
 if(enabled.filter(effect=>effect.type==="loudness").length>1)throw new StudioException("DUPLICATE_NORMALIZATION","Keep one loudness normalization stage per stack.","input");
 for(const effect of enabled){
  const p=effect.parameters;
  switch(effect.type){
   case "equalizer":{
    if(p.bands!==undefined&&!Array.isArray(p.bands))throw new StudioException("INVALID_EQ","EQ bands must be an array.","input");
    const bands=Array.isArray(p.bands)?p.bands:[];
    if(bands.length>32)throw new StudioException("EQ_LIMIT","Use at most 32 EQ bands.","input");
    for(const band of bands){if(!band||typeof band!=="object")throw new StudioException("INVALID_EQ","Each EQ band must contain frequency, q and gainDb.","input");const item=band as Record<string,unknown>;result.push("equalizer=f="+bounded(item.frequency,1000,20,20000)+":width_type=q:width="+bounded(item.q,1,.1,20)+":g="+bounded(item.gainDb,0,-24,24));}break;
   }
   case "highpass":result.push("highpass=f="+bounded(p.frequency,80,1,20000));break;
   case "lowpass":result.push("lowpass=f="+bounded(p.frequency,16000,1,20000));break;
   case "compressor":result.push("acompressor=threshold="+bounded(p.threshold,.125,.00097563,1)+":ratio="+bounded(p.ratio,4,1,20)+":attack="+bounded(p.attack,20,.01,2000)+":release="+bounded(p.release,250,.01,9000));break;
   case "limiter":result.push("alimiter=limit="+bounded(p.limit,.891,.0625,1)+":level=false");break;
   case "delay":result.push("aecho=0.8:0.88:"+bounded(p.delayMs,250,1,2000)+":"+bounded(p.decay,.3,0,.9));break;
   case "gate":result.push("agate=threshold="+bounded(p.threshold,.03,0,1)+":ratio="+bounded(p.ratio,4,1,9000)+":attack="+bounded(p.attack,20,.01,9000)+":release="+bounded(p.release,250,.01,9000));break;
   case "deesser":result.push("deesser=i="+bounded(p.intensity,.5,0,1)+":m="+bounded(p.amount,.5,0,1)+":f="+bounded(p.frequency,.5,0,1)+":s=o");break;
   case "reverb":result.push("aecho=0.8:0.88:31|43|59|79:"+[.35,.28,.22,.15].map(value=>value*bounded(p.mix,.5,0,1)).join("|"));break;
   case "loudness":result.push("loudnorm=I="+bounded(p.targetLufs,-16,-70,-5)+":TP="+bounded(p.truePeakDb,-1,-9,0)+":LRA="+bounded(p.rangeLu,7,1,50)+":linear=false","aresample="+sampleRate);break;
   default:unsupported(effect.type);
  }
 }return result;
}
export function clipTransformFilters(clip:Clip,canvas:{width:number;height:number}):{filters:string[];x:number;y:number}{
 const width=Math.max(2,Math.round(canvas.width*Math.abs(clip.transform.scale[0]))),height=Math.max(2,Math.round(canvas.height*Math.abs(clip.transform.scale[1])));
 if(width>8192||height>8192||width*height>16777216)throw new StudioException("TRANSFORM_LIMIT","Scaled clips must fit within 8192 per side and 16 megapixels.","input");
 const radians=(clip.transform.rotation%360)*Math.PI/180,cos=Math.cos(radians),sin=Math.sin(radians);
 const rotatedWidth=Math.trunc(Math.abs(cos)*width+Math.abs(sin)*height),rotatedHeight=Math.trunc(Math.abs(sin)*width+Math.abs(cos)*height);
 const anchorX=(clip.transform.anchor[0]-.5)*width,anchorY=(clip.transform.anchor[1]-.5)*height;
 const x=Math.round(clip.transform.position[0]*canvas.width-rotatedWidth/2-(cos*anchorX-sin*anchorY)),y=Math.round(clip.transform.position[1]*canvas.height-rotatedHeight/2-(sin*anchorX+cos*anchorY));
 const crop=clip.crop,filters:string[]=[];
 if(crop.left||crop.right||crop.top||crop.bottom)filters.push("crop=iw*"+(1-crop.left-crop.right)+":ih*"+(1-crop.top-crop.bottom)+":iw*"+crop.left+":ih*"+crop.top);
 if(clip.transform.scale[0]<0)filters.push("hflip");if(clip.transform.scale[1]<0)filters.push("vflip");
 filters.push("scale="+width+":"+height+":force_original_aspect_ratio=decrease","pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2:color=black@0","format=rgba");
 if(clip.transform.rotation!==0)filters.push("rotate="+radians+":ow=rotw("+radians+"):oh=roth("+radians+"):c=none");
 if(clip.transform.scale[0]===0||clip.transform.scale[1]===0)filters.push("colorchannelmixer=aa=0");
 if(clip.transform.opacity<1)filters.push("colorchannelmixer=aa="+clip.transform.opacity);
 return{filters,x,y};
}
