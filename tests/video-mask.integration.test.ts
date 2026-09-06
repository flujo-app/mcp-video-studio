import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";import {expect,it} from "vitest";
import {defaultClip,defaultTrack,secondsToTicks,MaskParametersSchema,type Sequence} from "@mcp-video-studio/contracts";import {ProjectStore} from "@mcp-video-studio/core";
import {loadConfig,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";
import {maskFilters} from "../packages/renderer/src/masks.js";import {StudioRuntime} from "../packages/server/src/runtime.js";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("rectangle/ellipse masks multiply actual alpha, support inverse/feather, and retain RGB bytes",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-mask-alpha-")),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root});try{
  const input=path.join(root,"source.rgba"),source=Buffer.alloc(160*90*4);
  for(let i=0;i<source.length;i+=4){source[i]=255;source[i+3]=128;}source[(45*160+80)*4+3]=0;for(let x=0;x<160;x++)source[x*4+3]=Math.round(x*255/159);await writeFile(input,source);
  const render=async(name:string,parameters:Record<string,unknown>)=>{const output=path.join(root,name+".rgba");await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","rawvideo","-pixel_format","rgba","-video_size","160x90","-i",input,"-vf",maskFilters(parameters).join(","),"-frames:v","1","-pix_fmt","rgba","-f","rawvideo",output],{timeoutMs:15000});return readFile(output);};
  const alpha=(bytes:Buffer,x:number,y:number)=>bytes[(y*160+x)*4+3]!;
  const rectangle=await render("rectangle",{shape:"rectangle"}),ellipse=await render("ellipse",{shape:"ellipse"}),inverse=await render("inverse",{shape:"ellipse",invert:true}),soft=await render("soft",{shape:"rectangle",feather:.1});
  expect(alpha(rectangle,45,25)).toBe(128);expect(alpha(ellipse,45,25)).toBe(0);expect(alpha(ellipse,81,45)).toBe(128);expect(alpha(ellipse,80,45)).toBe(0);
  for(let x=0;x<160;x++)expect(alpha(inverse,x,0)).toBe(source[x*4+3]);
   expect(alpha(inverse,45,25)).toBe(128);expect(alpha(inverse,81,45)).toBe(0);expect(alpha(inverse,80,45)).toBe(0);expect(alpha(soft,44,45)).toBeGreaterThanOrEqual(60);expect(alpha(soft,44,45)).toBeLessThanOrEqual(68);
  for(const bytes of [rectangle,ellipse,inverse,soft]){expect(bytes.length).toBe(source.length);for(let i=0;i<bytes.length;i+=4)expect(bytes.subarray(i,i+3)).toEqual(source.subarray(i,i+3));}
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
integration("masked nested clips keep outside pixels, exact range frames, preview parity and durable cache invalidation",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-mask-render-")),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root}),runtime=new StudioRuntime(config);try{
  await runtime.initialize();const store=await ProjectStore.create(path.join(root,"project"),"Nested mask");
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};p.settings.fps={numerator:10,denominator:1};p.settings.background="#0000ff";},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const project=await store.read(),parent=project.sequences[0]!,childId="masked-child",track=defaultTrack(childId,"video",0),red=defaultClip(track.id,{type:"color",color:"#ff0000"},"Red",secondsToTicks(1));
  red.transform.opacity=.5;red.effects=[{id:"mask",type:"mask",version:1,enabled:true,parameters:MaskParametersSchema.parse({shape:"rectangle"})}];
  const child:Sequence={id:childId,name:"Masked child",tracks:[track],clips:[red],transitions:[],automation:[],markers:[],captions:[]};
  const nested=defaultClip(parent.tracks[0]!.id,{type:"sequence",sequenceId:childId},"Nested",secondsToTicks(1)),tail=defaultClip(parent.tracks[0]!.id,{type:"color",color:"#0000ff"},"Unchanged tail",secondsToTicks(1));tail.startTick=secondsToTicks(1);for(const clip of [nested,tail])clip.effects=[{id:"full-mask-"+clip.id,type:"mask",version:1,enabled:true,parameters:MaskParametersSchema.parse({x:0,y:0,width:1,height:1})}];
  await store.mutate(1,[{type:"sequence.add",sequence:child},{type:"clip.add",sequenceId:parent.id,clip:nested,mode:"overwrite"},{type:"clip.add",sequenceId:parent.id,clip:tail,mode:"overwrite"}]);
  const decode=async(file:string)=>{const output=file+".rgb";await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",file,"-map","0:v:0","-pix_fmt","rgb24","-f","rawvideo",output],{timeoutMs:15000});return readFile(output);};
  const render=async(name:string,videoRangeFrames=0,presetId="archive-ffv1")=>{const output=path.join(root,name+(presetId==="archive-ffv1"?".mkv":".mp4"));const result=await renderSequence(store,config,{sequenceId:parent.id,presetId,outputPath:output,videoRangeFrames});return{result,bytes:await decode(output)};};
  const full=await render("full"),ranges=await render("ranges",5);expect(full.bytes.length).toBe(20*160*90*3);expect(ranges.bytes).toEqual(full.bytes);
  const pixel=(bytes:Buffer,x:number,y:number)=>[...bytes.subarray((y*160+x)*3,(y*160+x)*3+3)];
  expect(pixel(full.bytes,5,5)[2]).toBeGreaterThan(240);expect(pixel(full.bytes,81,45)[0]).toBeGreaterThan(110);expect(pixel(full.bytes,81,45)[0]).toBeLessThan(145);
  const changed={...red.effects[0]!,parameters:MaskParametersSchema.parse({shape:"ellipse",width:.25,x:.375})};await store.mutate(2,[{type:"clip.update",sequenceId:childId,clipId:red.id,patch:{effects:[changed]}}]);
  const next=await render("next",5);expect(next.result.renderKey).not.toBe(full.result.renderKey);expect(next.bytes.subarray(10*160*90*3)).toEqual(full.bytes.subarray(10*160*90*3));expect(pixel(next.bytes,45,25)[2]).toBeGreaterThan(240);expect(pixel(full.bytes,45,25)[0]).toBeGreaterThan(110);
  const queued=await runtime.renderPreview({projectPath:store.root,sequenceId:parent.id}) as{job:{id:string};revision:number};const deadline=Date.now()+60000;
  while(Date.now()<deadline){const job=runtime.jobs.get(queued.job.id);if(job?.status==="completed")break;if(job?.status==="failed")throw new Error(JSON.stringify(job.error));await new Promise(resolve=>setTimeout(resolve,25));}
  expect(runtime.jobs.get(queued.job.id)?.status).toBe("completed");
  const preview=await decode(path.join(store.root,"cache","previews",parent.id+"-r"+queued.revision+".mp4")),final=await render("final",5,"web-h264-1080p");expect(preview.length).toBe(final.bytes.length);
  let difference=0;for(let i=0;i<preview.length;i++)difference+=Math.abs(preview[i]!-final.bytes[i]!);expect(difference/preview.length).toBeLessThanOrEqual(3);
  await new ProjectStore(store.root).undo(3);await new ProjectStore(store.root).redo(4);expect((await store.read()).sequences.find(s=>s.id===childId)!.clips[0]!.effects).toEqual([changed]);
 }finally{await runtime.jobs.close();await rm(root,{recursive:true,force:true});}
},120000);
