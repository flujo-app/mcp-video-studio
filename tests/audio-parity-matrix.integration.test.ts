import {mkdtemp,readFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {expect,it} from "vitest";import {defaultClip,secondsToTicks,type EffectInstance} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";import {importMedia,loadConfig,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
export const cases:Array<{type:string;parameters:Record<string,unknown>;parameter:string;value:number}>= [
 {type:"equalizer",parameters:{bands:[{frequency:1200,q:.8,gainDb:3}]},parameter:"bands.0.gainDb",value:-9},
 {type:"highpass",parameters:{frequency:120},parameter:"frequency",value:1000},
 {type:"lowpass",parameters:{frequency:9000},parameter:"frequency",value:2000},
 {type:"compressor",parameters:{threshold:.08,ratio:4},parameter:"ratio",value:12},
 {type:"limiter",parameters:{limit:.2},parameter:"limit",value:.1},
 {type:"delay",parameters:{delayMs:200,decay:.45},parameter:"decay",value:.7},
 {type:"gate",parameters:{threshold:.025,ratio:4},parameter:"ratio",value:20},
 {type:"deesser",parameters:{intensity:.5,amount:.5,frequency:.5},parameter:"intensity",value:.8},
 {type:"reverb",parameters:{mix:.6},parameter:"mix",value:.9},
 {type:"loudness",parameters:{targetLufs:-16,truePeakDb:-1.5,rangeLu:7},parameter:"targetLufs",value:-20}
];
integration.each(cases)("$type: actual preview/final AAC PCM parity with resampling, range edits and processor tails",async({type,parameters,parameter,value})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-parity-"+type+"-"));
 try{
  const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),store=await ProjectStore.create(path.join(root,"project"),type);
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const source=path.join(root,"voice.wav");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","aevalsrc=(0.25*sin(2*PI*440*t)+0.12*sin(2*PI*6000*t))*lt(t\\,2.7):s=44100:d=3","-c:a","pcm_f32le",source]);
  const imported=await importMedia(store,source,"managed",1,config),p=await store.read(),s=p.sequences[0]!,track=s.tracks.find(t=>t.type==="audio")!,clip=defaultClip(track.id,{type:"media",mediaId:imported.asset.media.id},"Voice and tail",secondsToTicks(3));
  clip.audio.effects=[{id:"fx",type,parameters,enabled:true,version:1} as EffectInstance];
  await store.mutate(2,[{type:"clip.add",sequenceId:s.id,clip,mode:"overwrite"},{type:"audio.parameter.range",sequenceId:s.id,targetType:"clip",targetId:clip.id,parameter:"effect",effectId:"fx",parameterKey:parameter,startTick:secondsToTicks(.5),endTick:secondsToTicks(1.5),value}]);
  async function render(name:string,preview:boolean){
   const file=path.join(root,name+".mp4");await renderSequence(store,config,{sequenceId:s.id,presetId:"web-h264-1080p",outputPath:file,...(preview?{maxWidth:80,crf:25,encoderPreset:"superfast" as const}:{videoRangeFrames:0})});
   const pcm=path.join(root,name+".f32");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",file,"-map","0:a","-f","f32le","-c:a","pcm_f32le",pcm]);
   const b=await readFile(pcm);return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
  }
  const preview=await render("preview",true),final=await render("final",false);expect(final.length).toBe(preview.length);expect(final.length).toBeGreaterThanOrEqual(144000*2);
  let maximum=0;for(let i=0;i<final.length;i++)maximum=Math.max(maximum,Math.abs(final[i]!-preview[i]!));
  expect(maximum,type+" decoded preview/final AAC PCM").toBeLessThanOrEqual(1/8388608);
  if(type==="delay"||type==="reverb"){let tail=0;for(let i=Math.round(2.71*48000)*2;i<Math.round(2.74*48000)*2;i++)tail+=final[i]!**2;expect(Math.sqrt(tail/(.03*48000*2))).toBeGreaterThan(.001);}
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
