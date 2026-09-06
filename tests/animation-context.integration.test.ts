import {mkdtemp,rm,readFile,readdir} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {expect,it,vi} from "vitest";import {chromium} from "patchright";
import {defaultTransform,framesToTicks,type AnimationDocument} from "@mcp-video-studio/contracts";
import {renderAnimation} from "@mcp-video-studio/animation";import {loadConfig,runChecked} from "@mcp-video-studio/media";
const integration=process.env.RUN_BROWSER_INTEGRATION==="1"?it:it.skip;
integration.each([1,2,3])("redraws lost canvas backing stores within a strict three-attempt limit (losses=%s)",async losses=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-animation-context-")),originalLaunch=chromium.launch.bind(chromium);
 const launch=vi.spyOn(chromium,"launch").mockImplementation(async options=>{
  const browser=await originalLaunch(options),newContext=browser.newContext.bind(browser);
  browser.newContext=async options=>{
   const context=await newContext(options);
   await context.addInitScript((losses)=>{
    const original=HTMLCanvasElement.prototype.getContext,seen=new WeakSet<HTMLCanvasElement>();let creations=0;
    Object.defineProperty(HTMLCanvasElement.prototype,"getContext",{value:function(this:HTMLCanvasElement,...args:unknown[]){
     const result=Reflect.apply(original,this,args) as CanvasRenderingContext2D|null;
     if(args[0]==="2d"&&result&&!seen.has(this)){seen.add(this);const lost=++creations<=losses;if(lost){Object.defineProperty(result,"isContextLost",{value:()=>true});Object.defineProperty(result,"fillRect",{value:()=>undefined});}}
     return result;
    }});
   },losses);
   return context;
  };
  return browser;
 });
 try{
  const fps={numerator:10,denominator:1},doc:AnimationDocument={id:"context",name:"Context recovery",mode:"declarative",durationTick:framesToTicks(2,fps),seed:1,canvas:{width:32,height:32,background:"#ff0000"},nodes:[{id:"square",name:"Square",type:"rect",properties:{width:8,height:8,fill:"#00ff00"},transform:{...defaultTransform(),position:[16,16]}}],operations:[]},config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),output=path.join(root,"recovered.mkv");
  if(losses===3){await expect(renderAnimation(doc,config,{fps,outputPath:output})).rejects.toThrow(/three frame attempts/);expect((await readdir(root)).includes("recovered.mkv")).toBe(false);}
  else{
   const result=await renderAnimation(doc,config,{fps,outputPath:output});expect(result.canvasContextRecoveries).toBe(losses);
   const raw=output+".rgba";await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-pix_fmt","rgba","-f","rawvideo",raw]);const bytes=await readFile(raw);expect(bytes.length).toBe(2*32*32*4);
   for(const frame of [0,1]){expect([...bytes.subarray(frame*32*32*4,frame*32*32*4+4)]).toEqual([255,0,0,255]);const center=(frame*32*32+16*32+16)*4;expect([...bytes.subarray(center,center+4)]).toEqual([0,255,0,255]);}
  }
  expect((await readdir(config.scratchDir)).filter(name=>name.startsWith("animation-"))).toEqual([]);
 }finally{launch.mockRestore();await rm(root,{recursive:true,force:true});}
},60000);
