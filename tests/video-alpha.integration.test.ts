import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";import {it,expect} from "vitest";
import {type EffectInstance} from "@mcp-video-studio/contracts";import {loadConfig,runChecked} from "@mcp-video-studio/media";import {videoEffectFilters} from "../packages/renderer/src/filters.js";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("color effects retain exact incoming alpha, blur/flip geometry, and multiply chroma-key coverage",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-effect-alpha-")),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root}),width=160,height=90;
 try{
  const source=Buffer.alloc(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;source.set(x<80?[20,220,40,Math.round(x*255/159)]:[50,90,210,Math.round(x*255/159)],i);}
  const file=path.join(root,"source.rgba");await writeFile(file,source);
  let ordinal=0;const render=async(filters:string[],input=source)=>{const inputFile=path.join(root,"in-"+ordinal+".rgba"),output=path.join(root,"out-"+ordinal+++".rgba");await writeFile(inputFile,input);await runChecked(config.ffmpegPath,["-v","error","-y","-f","rawvideo","-pixel_format","rgba","-video_size",width+"x"+height,"-i",inputFile,"-vf",filters.join(","),"-frames:v","1","-pix_fmt","rgba","-f","rawvideo",output],{timeoutMs:15000});return readFile(output);};
  const effect=(type:string,parameters:Record<string,unknown>):EffectInstance=>({id:type,type,parameters,version:1,enabled:true});
  for(const e of [effect("color",{brightness:.1,contrast:1.2,saturation:.7}),effect("brightness",{value:.1}),effect("sharpen",{amount:1}),effect("vignette",{angle:.5}),effect("grayscale",{})]){
   const output=await render(videoEffectFilters([e]));
   for(let i=3;i<source.length;i+=4)expect(output[i],e.type+" alpha at "+i).toBe(source[i]);
  }
  for(const type of ["hflip","vflip"]){const output=await render(videoEffectFilters([effect(type,{})]));for(let y=0;y<height;y++)for(let x=0;x<width;x++){const from=((type==="vflip"?height-1-y:y)*width+(type==="hflip"?width-1-x:x))*4;expect(output.subarray((y*width+x)*4,(y*width+x)*4+4)).toEqual(source.subarray(from,from+4));}}
  const blurred=await render(videoEffectFilters([effect("blur",{radius:4})])),expectedAlpha=path.join(root,"blur.gray");
  await runChecked(config.ffmpegPath,["-v","error","-y","-f","rawvideo","-pixel_format","rgba","-video_size",width+"x"+height,"-i",file,"-vf","alphaextract,gblur=sigma=4","-frames:v","1","-pix_fmt","gray","-f","rawvideo",expectedAlpha],{timeoutMs:15000});
  const reference=await readFile(expectedAlpha);for(let i=0;i<reference.length;i++)expect(blurred[i*4+3]).toBe(reference[i]);
  const opaque=Buffer.from(source);for(let i=3;i<opaque.length;i+=4)opaque[i]=255;
  const key=effect("chromaKey",{color:"#14dc28",similarity:.1,blend:.25}),coverage=await render(videoEffectFilters([key]),opaque),keyed=await render(videoEffectFilters([key]));
  for(let i=3;i<source.length;i+=4)expect(keyed[i]).toBe(Math.round(source[i]!*coverage[i]!/255));
  expect(keyed[(45*width+10)*4+3]).toBe(0);expect(keyed[(45*width+140)*4+3]).toBe(source[(45*width+140)*4+3]);
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
