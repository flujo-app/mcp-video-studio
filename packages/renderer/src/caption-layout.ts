import {drawtextMetricValues} from "./caption-metrics.js";
import {mkdir,writeFile,rm} from "node:fs/promises";import path from "node:path";import {randomUUID,createHash} from "node:crypto";
import type {CaptionCue,StudioProject,Sequence} from "@mcp-video-studio/contracts";import {ProjectStore,StudioException} from "@mcp-video-studio/core";import {mediaPath,runChecked,filterScriptOption,requireFfmpegFilters,type StudioConfig} from "@mcp-video-studio/media";import {captionFontFile,escapeFilterPath} from "./render.js";
export interface CaptionMeasurement {captionId:string;startTick:number;endTick:number;textWidth:number;textHeight:number;bounds:{left:number;top:number;right:number;bottom:number};safeBounds:{left:number;top:number;right:number;bottom:number};overflow:boolean;outsideSafeArea:boolean}
function box(caption:CaptionCue,width:number,height:number,raster:StudioProject["settings"]["raster"]):CaptionMeasurement{
 const s=caption.style,x=Math.trunc(s.align==="left"?(s.marginLeft??raster.width*.05):s.align==="right"?raster.width-width-(s.marginRight??raster.width*.05):(raster.width-width)/2),y=Math.trunc(s.position==="top"?(s.marginVertical??raster.height*.07):s.position==="center"?(raster.height-height)/2:raster.height-height-(s.marginVertical??raster.height*.08));
 const background=s.background!=="transparent"&&!/^#[0-9a-f]{6}00$/i.test(s.background),border=Math.max(background?18:0,Math.trunc(s.outlineWidth??0)),shadow=Math.trunc(s.shadowOffset??0);
 const bounds={left:x-border,top:y-border,right:x+width+Math.max(border,shadow),bottom:y+height+Math.max(border,shadow)},safeBounds={left:raster.width*.05,top:raster.height*.05,right:raster.width*.95,bottom:raster.height*.95};
 return{captionId:caption.id,startTick:caption.startTick,endTick:caption.startTick+caption.durationTick,textWidth:width,textHeight:height,bounds,safeBounds,overflow:bounds.left<0||bounds.top<0||bounds.right>raster.width||bounds.bottom>raster.height,outsideSafeArea:bounds.left<safeBounds.left||bounds.top<safeBounds.top||bounds.right>safeBounds.right||bounds.bottom>safeBounds.bottom};
}
/** Measure the actual drawtext engine, rather than estimating browser font metrics. */
export async function measureCaptionLayout(store:ProjectStore,project:StudioProject,sequence:Sequence,config:StudioConfig,signal?:AbortSignal):Promise<{measurements:CaptionMeasurement[];complete:boolean}>{
 const captions=sequence.captions.filter(caption=>sequence.tracks.some(track=>track.id===caption.trackId&&!track.hidden&&!track.muted));if(!captions.length)return{measurements:[],complete:true};
 await requireFfmpegFilters(config.ffmpegPath,["drawtext"]);
 const selected=captions.slice(0,5000),scratch=path.join(config.scratchDir,"caption-layout-"+randomUUID());await mkdir(scratch,{recursive:true});
 const groups=new Map<string,{font:string;caption:CaptionCue;ids:string[]}>(),measured=new Map<string,{width:number;height:number}>(),owner=new Map<string,string>();
 try{
  for(const caption of selected){const media=caption.style.fontMediaId?project.media.find(media=>media.id===caption.style.fontMediaId&&media.kind==="font"):undefined;if(caption.style.fontMediaId&&!media)throw new StudioException("MISSING_CAPTION_FONT","Caption font is missing.","input");const font=media?mediaPath(store,media):captionFontFile(caption.style.fontFamily,config.defaultFontFile),key=createHash("sha256").update(JSON.stringify({font,size:caption.style.fontSize,text:caption.text})).digest("hex");owner.set(caption.id,key);const group=groups.get(key);if(group)group.ids.push(caption.id);else groups.set(key,{font,caption,ids:[caption.id]});}
  const items=[...groups.entries()];
  for(let base=0;base<items.length;base+=25){
   signal?.throwIfAborted();const batch=items.slice(base,base+25),filters:string[]=[];
   for(let i=0;i<batch.length;i++){const [,item]=batch[i]!,file=path.join(scratch,String(base+i)+".txt");await writeFile(file,item.caption.text,"utf8");filters.push("drawtext=fontfile='"+escapeFilterPath(item.font)+"':textfile='"+escapeFilterPath(file)+"':reload=0:expansion=none:fontsize="+item.caption.style.fontSize+":fontcolor=black:x='print("+(900000000+i*2)+",24);print(text_w,24);0':y='print("+(900000001+i*2)+",24);print(text_h,24);0'");}
   const graph=path.join(scratch,"measure.txt");await writeFile(graph,"[0:v]"+filters.join(",")+"[measured]","utf8");
   const result=await runChecked(config.ffmpegPath,["-hide_banner","-loglevel","repeat+warning","-f","lavfi","-i","color=c=black:s=16x16:r=1:d=1",await filterScriptOption(config.ffmpegPath),graph,"-map","[measured]","-frames:v","1","-f","null","-"],{...(signal?{signal}:{}),timeoutMs:60000,maxOutputChars:500000});
   if(result.truncated)throw new StudioException("CAPTION_METRICS_LIMIT","Caption measurement output exceeded its bound.","runtime");
   const values=drawtextMetricValues(result.stderr,batch.length);
   for(let i=0;i<batch.length;i++){const width=values.get(900000000+i*2),height=values.get(900000001+i*2);if(width===undefined||height===undefined||width<0||height<0||width>10000000||height>10000000)throw new StudioException("CAPTION_METRICS_MISSING","The installed drawtext engine did not report bounded text dimensions.","dependency");measured.set(batch[i]![0],{width,height});}
  }
  return{measurements:selected.map(caption=>{const size=measured.get(owner.get(caption.id)!)!;return box(caption,size.width,size.height,project.settings.raster);}),complete:selected.length===captions.length};
 }finally{await rm(scratch,{recursive:true,force:true});}
}
