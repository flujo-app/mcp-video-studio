import "./audio-meters.css";
import React,{useEffect,useRef,useState,type RefObject} from "react";
/** Measures the actual decoded program preview, not estimated clip gain values. */
export function ProgramAudioMeter({media,sourceKey}:{media:RefObject<HTMLVideoElement|null>;sourceKey:string}){
 const [enabled,setEnabled]=useState(false),[levels,setLevels]=useState([-90,-90]),[error,setError]=useState("");
 const context=useRef<AudioContext|null>(null);
 useEffect(()=>{
  setEnabled(false);setLevels([-90,-90]);setError("");
  return()=>{void context.current?.close().catch(()=>undefined);context.current=null;};
 },[sourceKey]);
 useEffect(()=>{
  const video=media.current;if(!enabled||!video)return;
  const ctx=new AudioContext(),source=ctx.createMediaElementSource(video),splitter=ctx.createChannelSplitter(2);
  context.current=ctx;source.connect(splitter);source.connect(ctx.destination);
  const meters=[ctx.createAnalyser(),ctx.createAnalyser()],samples=meters.map(()=>new Float32Array(2048));
  meters.forEach((meter,index)=>{meter.fftSize=2048;splitter.connect(meter,index);});
  let frame=0,previous=0,cancelled=false;
  const measure=(time:number)=>{
   if(cancelled)return;
   if(time-previous>40){previous=time;setLevels(meters.map((meter,index)=>{meter.getFloatTimeDomainData(samples[index]!);let peak=0;for(const sample of samples[index]!)peak=Math.max(peak,Math.abs(sample));return Math.max(-90,Math.min(0,20*Math.log10(peak||1e-9)));}));}
   frame=requestAnimationFrame(measure);
  };
  void ctx.resume().then(()=>{if(!cancelled)frame=requestAnimationFrame(measure);}).catch(error=>setError(String(error)));
  return()=>{cancelled=true;cancelAnimationFrame(frame);source.disconnect();splitter.disconnect();meters.forEach(meter=>meter.disconnect());void ctx.close().catch(()=>undefined);if(context.current===ctx)context.current=null;};
 },[enabled,sourceKey,media]);
 if(!sourceKey)return null;
 return <fieldset className="program-audio-meters" aria-label="Program mix playback meters"><legend>Program mix playback meters</legend>
 <button disabled={enabled} onClick={()=>setEnabled(true)}>Enable audio meters</button>
 {["Left","Right"].map((label,index)=><label key={label}>{label}<meter min="-90" max="0" low={-18} high={-1} optimum={-12} value={levels[index]}/><output data-audio-meter={label.toLowerCase()} data-db={levels[index]}>{levels[index]!.toFixed(1)} dBFS</output></label>)}
 <small>Decoded preview sample peaks; export QC measures integrated loudness and true peak.</small><p role="status">{error}</p>
 </fieldset>;
}
