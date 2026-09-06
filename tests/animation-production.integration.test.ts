import {mkdtemp,readFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {expect,it} from "vitest";import {chromium} from "patchright";
import {defaultTransform,secondsToTicks,morphPath,animationProblems,type AnimationDocument} from "@mcp-video-studio/contracts";
import {createAnimationPainter,evaluateAnimation,renderAnimation} from "@mcp-video-studio/animation";
import {loadConfig,runChecked} from "@mcp-video-studio/media";
const integration=process.env.RUN_BROWSER_INTEGRATION==="1"?it:it.skip;
const node=(id:string,type:AnimationDocument["nodes"][number]["type"],properties:Record<string,unknown>,x=0,y=0)=>({id,type,name:id,properties,transform:{...defaultTransform(),position:[x,y] as [number,number]}});
export function production():AnimationDocument{
 return{id:"production",name:"Editable diagram production",mode:"declarative",durationTick:secondsToTicks(4),seed:91,canvas:{width:160,height:90,background:"transparent"},
 nodes:[node("camera","camera",{zoom:1}),node("diagram","group",{},35,35),{...node("shape","path",{path:"M 0 0 L 20 0 L 20 20 L 0 20 Z",width:20,height:20,fill:"#ff0000"}),parentId:"diagram"},
 {...node("dot","ellipse",{width:6,height:6,fill:"#ffffff"},20,0),parentId:"diagram"},node("label","text",{text:"One → two",fontSize:16,fill:"#ffffff"},85,65),node("particles","particles",{count:20,lifetime:1,size:1,speed:8,fill:"#00ff00"},130,25)],
 operations:[
 {id:"morph","type":"morph",targetId:"shape",startTick:0,durationTick:secondsToTicks(1),easing:"linear",parameters:{to:"M 10 0 L 20 10 L 10 20 L 0 10 Z"}},
 {id:"move","type":"transform",targetId:"diagram",startTick:secondsToTicks(1),durationTick:secondsToTicks(1),easing:"easeInOut",parameters:{to:{position:[65,35],rotation:45,scale:[1.5,1.5]}}},
 {id:"color","type":"property",targetId:"shape",startTick:secondsToTicks(1),durationTick:secondsToTicks(1),easing:"linear",parameters:{property:"fill",from:"#ff0000",to:"#0000ff"}},
 {id:"write","type":"write",targetId:"label",startTick:secondsToTicks(1),durationTick:secondsToTicks(1),easing:"linear",parameters:{}},
 {id:"camera-zoom","type":"property",targetId:"camera",startTick:secondsToTicks(2),durationTick:secondsToTicks(1),easing:"linear",parameters:{property:"zoom",from:1,to:1.25}},
 {id:"outro","type":"fade",targetId:"diagram",startTick:secondsToTicks(3),durationTick:secondsToTicks(1),easing:"linear",parameters:{from:1,to:0}}
 ]};
}
it("validates compatible path morphs and preserves earlier operations before later keyframes",()=>{
 expect(morphPath("M0 0L10 0L10 10Z","M0 0L20 0L20 20Z",.5)).toBe("M 0 0 L 15 0 L 15 15 Z");
 expect(()=>morphPath("M0 0L10 0","M0 0C1 2 3 4 5 6",.5)).toThrow(/same commands/);
 expect(animationProblems(production())).toEqual([]);
 const doc=production(),early=evaluateAnimation(doc,secondsToTicks(.5));
 expect(early.find(n=>n.id==="shape")!.properties.fill).toBe("#ff0000");
 expect(early.find(n=>n.id==="label")!.visible).toBe(false);
 const later=evaluateAnimation(doc,secondsToTicks(1.5));
 expect(later.find(n=>n.id==="shape")!.properties.fill).toBe("#800080");
 const image={...doc,nodes:[node("external","image",{src:"https://example.com/image.png"})],operations:[]};
 expect(animationProblems(image).join(" ")).toMatch(/self-contained/);
});
integration("exports multiscene SVG morphs, grouped transforms, kinetic text, camera and seeded particles with exact editor pixels",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-animation-production-")),browser=await chromium.launch({headless:true});try{
  const doc=production(),fps={numerator:10,denominator:1},config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),output=path.join(root,"production.mkv");
  const result=await renderAnimation(doc,config,{fps,outputPath:output});expect(result.frameCount).toBe(40);
  const raw=path.join(root,"frames.rgba");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-pix_fmt","rgba","-f","rawvideo",raw]);
  const bytes=await readFile(raw),frameBytes=160*90*4;expect(bytes.length).toBe(40*frameBytes);
  expect(bytes.subarray((35*160+35)*4,(35*160+35)*4+4)).toEqual(Buffer.from([255,0,0,255]));
  expect(bytes[3]).toBe(0);
  const page=await browser.newPage();await page.setContent('<canvas id="scene"></canvas>');
  await page.addScriptTag({content:"window.paint=("+createAnimationPainter.toString()+")(document.getElementById('scene'));"});
  for(const frame of [0,5,10,15,20,25,30,35]){
   const state=evaluateAnimation(doc,secondsToTicks(frame/10));
   const pixels=await page.evaluate(async({state,meta})=>{await (window as unknown as{paint:(s:unknown,m:unknown)=>Promise<unknown>}).paint(state,meta);const canvas=document.getElementById("scene") as HTMLCanvasElement;return Array.from(canvas.getContext("2d")!.getImageData(0,0,canvas.width,canvas.height).data);},{state,meta:{...doc.canvas,seed:doc.seed,time:frame/10}},false);
   // Canvas screenshots pass through PNG premultiplication; at most one 8-bit rounding bit.
   let maximum=0;for(let index=0;index<frameBytes;index++)maximum=Math.max(maximum,Math.abs(bytes[frame*frameBytes+index]!-pixels[index]!));
   expect(maximum).toBeLessThanOrEqual(1);
  }
  const again=path.join(root,"again.mkv");await renderAnimation(doc,config,{fps,outputPath:again});const againRaw=path.join(root,"again.rgba");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",again,"-pix_fmt","rgba","-f","rawvideo",againRaw]);expect((await readFile(againRaw)).equals(bytes)).toBe(true);
 }finally{await browser.close();await rm(root,{recursive:true,force:true});}
},120000);
integration("decodes bounded embedded image/video nodes and holds the source end frame",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-animation-assets-"));try{
  const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
  const image=path.join(root,"image.png"),video=path.join(root,"video.webm");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","color=c=red:s=16x16","-frames:v","1","-threads","1",image]);
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","color=c=blue:s=16x16:r=2","-t","1","-c:v","libvpx-vp9",video]);
  const doc:AnimationDocument={id:"assets",name:"Assets",mode:"declarative",durationTick:secondsToTicks(2),seed:0,canvas:{width:32,height:16,background:"transparent"},operations:[],nodes:[node("image","image",{src:"data:image/png;base64,"+(await readFile(image)).toString("base64"),width:16,height:16},8,8),node("video","video",{src:"data:video/webm;base64,"+(await readFile(video)).toString("base64"),width:16,height:16},24,8)]};
  const output=path.join(root,"assets.mkv");await renderAnimation(doc,config,{fps:{numerator:2,denominator:1},outputPath:output});
  const raw=path.join(root,"assets.rgba");await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-pix_fmt","rgba","-f","rawvideo",raw]);const bytes=await readFile(raw),frameSize=32*16*4;expect(bytes.length).toBe(frameSize*4);
  if(bytes[0]!<=240)console.log("EMBEDDED_PIXEL_DIAGNOSTIC",JSON.stringify({left:[...bytes.subarray(0,4)],right:[...bytes.subarray(16*4,16*4+4)],last:[...bytes.subarray(frameSize*3,frameSize*3+4)]}));expect(bytes[0]).toBeGreaterThan(240);expect(bytes[16*4+2]).toBeGreaterThan(240);expect(bytes.subarray(0,frameSize).equals(bytes.subarray(frameSize*3))).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
