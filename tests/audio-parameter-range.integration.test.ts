import {mkdtemp,readFile,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";
import {defaultClip,ticksPerSample,secondsToTicks,resolveAudioParameter,type AudioParameterRangeCommand} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";
import {importMedia,loadConfig,runChecked} from "@mcp-video-studio/media";
import {renderSequence} from "@mcp-video-studio/renderer";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("pan and stateful effect ranges preserve every outside program sample, including downstream compressor history",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-parameter-range-"));
 try{
  const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  const store=await ProjectStore.create(path.join(root,"project"),"Precise audio");
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const source=path.join(root,"source.wav");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","aevalsrc=0.3*sin(2*PI*330*t)*lt(mod(t\\,0.6)\\,0.45):s=44100:d=3","-c:a","pcm_f32le",source]);
  const imported=await importMedia(store,source,"managed",1,config),p=await store.read(),s=p.sequences[0]!,track=s.tracks.find(t=>t.type==="audio")!,q=ticksPerSample(48000);
  const clip=defaultClip(track.id,{type:"media",mediaId:imported.asset.media.id},"Voice",secondsToTicks(3));
  clip.audio.effects=[{id:"echo",type:"delay",enabled:true,version:1,parameters:{delayMs:180,decay:.2}}];
  await store.mutate(2,[{type:"clip.add",sequenceId:s.id,clip,mode:"overwrite"},{type:"track.update",sequenceId:s.id,trackId:track.id,patch:{effects:[{id:"compress",type:"compressor",enabled:true,version:1,parameters:{threshold:.1,ratio:3,attack:2,release:900}}]}}]);
  const original=(await store.read()).sequences[0]!;
  async function render(name:string){
   const out=path.join(root,name+".wav");await renderSequence(store,config,{sequenceId:s.id,presetId:"audio-wav",outputPath:out});
   const pcm=path.join(root,name+".f32");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",out,"-f","f32le","-c:a","pcm_f32le",pcm]);
   const b=await readFile(pcm);return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
  }
  const baseline=await render("baseline"),start=1337,end=71111;
  for(const spec of [
   {targetType:"clip",targetId:clip.id,parameter:"pan",value:.8},
   {targetType:"clip",targetId:clip.id,parameter:"effect",effectId:"echo",parameterKey:"decay",value:.7},
   {targetType:"track",targetId:track.id,parameter:"effect",effectId:"compress",parameterKey:"ratio",value:12}
  ] as const){
   let current=await store.read();await store.replace(current.revision,p=>{p.sequences[0]=structuredClone(original);},{sequences:[s.id],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
   current=await store.read();const command:AudioParameterRangeCommand={type:"audio.parameter.range",sequenceId:s.id,...spec,startTick:start*q,endTick:end*q};
   await store.mutate(current.revision,[command]);const ranged=await render(spec.parameter+(spec.effectId??"pan")+"range");
   current=await store.read();await store.replace(current.revision,p=>{
    const sequence=p.sequences[0]!,target=sequence.automation[0]!.target;resolveAudioParameter(sequence,target).set(spec.value);sequence.automation=[];
   },{sequences:[s.id],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
   const variant=await render(spec.parameter+(spec.effectId??"pan")+"full");
   expect(ranged.length).toBe(baseline.length);expect(variant.length).toBe(baseline.length);
   let outside=0,inside=0,changed=0;
   for(let i=0;i<ranged.length;i++){
    const active=Math.floor(i/2)>=start&&Math.floor(i/2)<end;
    if(active){inside=Math.max(inside,Math.abs(ranged[i]!-variant[i]!));if(Math.abs(ranged[i]!-baseline[i]!)>.00001)changed++;}
    else outside=Math.max(outside,Math.abs(ranged[i]!-baseline[i]!));
   }
   expect(outside,spec.parameter+" outside").toBeLessThanOrEqual(1/8388608);
   expect(inside,spec.parameter+" full-history inside").toBeLessThanOrEqual(1/8388608);
   expect(changed).toBeGreaterThan(1000);
  }
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
