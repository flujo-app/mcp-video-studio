import React,{useEffect,useRef} from "react";
import {ticksToSeconds,type Clip,type MediaAsset} from "@mcp-video-studio/contracts";
export function TimelineTileStrip({clip,media,projectPath,token,zoom,visibleStart,visibleEnd}:{clip:Clip;media:MediaAsset;projectPath:string;token:string;zoom:number;visibleStart:number;visibleEnd:number}){
 const start=ticksToSeconds(clip.startTick),duration=ticksToSeconds(clip.durationTick),source=ticksToSeconds(clip.sourceInTick),rate=clip.playbackRate.numerator/clip.playbackRate.denominator;
 const span=2**Math.max(-1,Math.min(5,Math.round(Math.log2(320*rate/zoom)))),from=Math.max(0,visibleStart-start),to=Math.min(duration,visibleEnd-start);
 const first=Math.max(0,Math.floor((source+from*rate)/span)),last=Math.min(first+31,Math.ceil((source+to*rate)/span));
 const tiles=Array.from({length:Math.max(0,last-first)},(_,offset)=>first+offset);
 return <span className="timeline-tiles" aria-hidden="true">{tiles.map(index=>{
  const query=new URLSearchParams({token,projectPath,mediaId:media.id,kind:media.kind==="audio"?"timeline-waveform":"timeline-thumbnail",spanSeconds:String(span),index:String(media.kind==="image"?0:index),v:media.storage.sha256});
  return <img draggable={false} key={index+":"+span+":"+media.storage.sha256} alt="" loading="lazy" data-tile-index={index} data-tile-span={span} src={"/media?"+query} style={{left:(index*span-source)/rate*zoom,width:span/rate*zoom}} onError={event=>{event.currentTarget.style.visibility="hidden";}}/>;
 })}</span>;
}
/** Source comparison follows the selected clip's in-point and playback rate. */
export function SourceFrame({url,clip,playhead}:{url:string;clip:Clip|undefined;playhead:number}){
 const ref=useRef<HTMLVideoElement>(null),rate=clip?clip.playbackRate.numerator/clip.playbackRate.denominator:1;
 const tick=clip?Math.round(clip.sourceInTick+Math.max(0,Math.min(clip.durationTick,playhead-clip.startTick))*rate):playhead;
 const seek=()=>{const video=ref.current;if(video&&Number.isFinite(video.duration)){video.pause();video.currentTime=Math.max(0,Math.min(video.duration,ticksToSeconds(tick)));}};
 useEffect(seek,[tick,url]);
 return <video ref={ref} aria-label="Source preview" key={url} src={url} preload="metadata" onLoadedMetadata={seek}/>;
}
