import {mkdtemp,rm,readFile} from "node:fs/promises";import path from "node:path";import os from "node:os";import {expect,it} from "vitest";
import {defaultClip,secondsToTicks,type EffectInstance} from "@mcp-video-studio/contracts";import {ProjectStore} from "@mcp-video-studio/core";import {importMedia,loadConfig,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";import {StudioRuntime} from "../packages/server/src/runtime.js";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
const cases:Array<[string,Record<string,unknown>]>=[["color",{brightness:.1,contrast:1.2,saturation:.4}],["brightness",{value:.15}],["blur",{radius:4}],["sharpen",{amount:2}],["vignette",{angle:.9}],["chromaKey",{color:"#00ff00",similarity:.2,blend:0}],["grayscale",{}],["hflip",{}],["vflip",{}]];
integration("all declared video effects retain exact cached-range pixels and measured H264 program-preview/final parity",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-video-parity-")),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),runtime=new StudioRuntime(config),rows:Array<Record<string,unknown>>=[];
 try{
  await runtime.initialize();const store=await ProjectStore.create(path.join(root,"project"),"Video parity");
  await store.replace(0,p=>{p.settings.raster={width:192,height:108};p.settings.fps={numerator:12,denominator:1};p.settings.background="#ff00ff";},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const input=path.join(root,"source.mkv");await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","testsrc2=s=192x108:r=12:d=1","-c:v","ffv1",input]);const imported=await importMedia(store,input,"managed",1,config);
  let project=await store.read();const sequence=project.sequences[0]!,clip=defaultClip(sequence.tracks.find(t=>t.type==="video")!.id,{type:"media",mediaId:imported.asset.media.id},"Effect fixture",secondsToTicks(1));await store.mutate(2,[{type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"}]);
  const decode=async(file:string)=>{const raw=file+".rgb";await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",file,"-map","0:v:0","-pix_fmt","rgb24","-f","rawvideo",raw]);return readFile(raw);};
  const render=async(name:string,presetId="archive-ffv1",videoRangeFrames=0)=>{const output=path.join(root,name+(presetId==="archive-ffv1"?".mkv":".mp4"));await renderSequence(store,config,{sequenceId:sequence.id,presetId,outputPath:output,videoRangeFrames});return decode(output);};
  const plain=await render("plain");
  for(const [type,parameters] of cases){
   const effect:EffectInstance={id:"tested-effect",type,enabled:true,version:1,parameters};project=await store.read();await store.mutate(project.revision,[{type:"clip.update",sequenceId:sequence.id,clipId:clip.id,patch:{effects:[effect]}}]);
   const whole=await render(type+"-whole"),ranged=await render(type+"-ranges","archive-ffv1",4);expect(whole.length).toBe(12*192*108*3);expect(ranged.equals(whole),type+" cache boundaries").toBe(true);
   let changed=0;for(let i=0;i<whole.length;i++)if(whole[i]!==plain[i])changed++;expect(changed/whole.length,type+" visibly affects pixels").toBeGreaterThan(.01);
   const queued=await runtime.renderPreview({projectPath:store.root,sequenceId:sequence.id}) as{job:{id:string};revision:number};const deadline=Date.now()+60000;let result:Record<string,unknown>|undefined;
   while(Date.now()<deadline){const job=runtime.jobs.get(queued.job.id);if(job?.status==="completed"){result=job.result;break;}if(job?.status==="failed"||job?.status==="cancelled")throw new Error(JSON.stringify(job));await new Promise(resolve=>setTimeout(resolve,25));}
   expect(result).toBeDefined();const preview=await decode(path.join(store.root,"cache","previews",sequence.id+"-r"+queued.revision+".mp4")),final=await render(type+"-final","web-h264-1080p",4);if(preview.length!==final.length){for(const name of [path.join(store.root,"cache","previews",sequence.id+"-r"+queued.revision+".mp4"),path.join(root,type+"-final.mp4")])console.log("VIDEO_PARITY_FRAME_DIAGNOSTIC",name,(await runChecked(config.ffprobePath,["-v","error","-count_frames","-select_streams","v:0","-show_entries","stream=r_frame_rate,avg_frame_rate,time_base,duration,nb_frames,nb_read_frames","-of","json",name])).stdout);}expect(preview.length).toBe(final.length);
   let absolute=0,squared=0,maximum=0;for(let i=0;i<final.length;i++){const delta=Math.abs(final[i]!-preview[i]!);absolute+=delta;squared+=delta*delta;maximum=Math.max(maximum,delta);}
   const mae=absolute/final.length,rms=Math.sqrt(squared/final.length),psnr=rms?20*Math.log10(255/rms):Infinity;rows.push({type,mae,rms,psnr,maximum,changedFraction:changed/whole.length,frames:12,losslessRangeExact:true});
   expect(mae,type+" average codec difference").toBeLessThanOrEqual(3);expect(rms,type+" RMS codec difference").toBeLessThanOrEqual(8);
  }
  project=await store.read();await store.mutate(project.revision,[{type:"clip.update",sequenceId:sequence.id,clipId:clip.id,patch:{effects:cases.map(([type,parameters],i)=>({id:"bypass-"+i,type,parameters,enabled:false,version:1}))}}]);expect((await render("bypassed")).equals(plain)).toBe(true);
  console.log("VIDEO_EFFECT_PARITY_MATRIX",JSON.stringify(rows));
 }finally{await runtime.jobs.close();if(!process.env.VIDEO_PARITY_KEEP)await rm(root,{recursive:true,force:true});else console.log("VIDEO_PARITY_ROOT",root);}
},180000);
