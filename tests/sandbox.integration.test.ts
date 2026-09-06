import { mkdtemp,readFile,rm } from "node:fs/promises";import path from "node:path";import os from "node:os";
import { createServer } from "node:http";import { createHash } from "node:crypto";
import { expect,it } from "vitest";import { chromium } from "patchright";
import { prepareSandbox,browserEnvironment } from "../packages/animation/src/sandbox.js";
import { renderAnimation } from "@mcp-video-studio/animation";import { framesToTicks,type AnimationDocument } from "@mcp-video-studio/contracts";
import { loadConfig,runChecked } from "@mcp-video-studio/media";
const integration=process.env.RUN_BROWSER_INTEGRATION==="1"?it:it.skip;
integration("hostile HTML cannot use network, parent DOM, popups, workers or local storage",async()=>{
 let calls=0;const server=createServer((_q,r)=>{calls++;r.end("secret");});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address() as {port:number};
 const browser=await chromium.launch({headless:true,env:browserEnvironment()});
 try{
  const context=await browser.newContext({serviceWorkers:"block",acceptDownloads:false}),page=await context.newPage();
  const frame=await prepareSandbox(browser,page,context,`<script>window.checks={};(async()=>{try{await fetch('http://127.0.0.1:${address.port}/');checks.network=true}catch{checks.network=false}try{checks.parent=!!parent.document.body}catch{checks.parent=false}try{checks.popup=!!open('data:text/html,popup')}catch{checks.popup=false}try{new Worker('data:text/javascript,postMessage(1)');checks.worker=true}catch{checks.worker=false}try{localStorage.setItem('bad','value');checks.storage=true}catch{checks.storage=false}try{await fetch('file:///etc/passwd');checks.file=true}catch{checks.file=false}checks.done=true;})();</script>`,7);
  for(let n=0;n<100&&!await frame.evaluate("window.checks?.done",undefined,false);n++)await new Promise(resolve=>setTimeout(resolve,20));
  expect(await frame.evaluate("window.checks",undefined,false)).toEqual({network:false,parent:false,popup:false,worker:false,storage:false,file:false,done:true});
  expect(context.pages()).toHaveLength(1);expect(calls).toBe(0);
 }finally{await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},30000);
integration("HTML frame pixels repeat exactly and cancellation stops a stuck user frame",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-html-"));const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),fps={numerator:30,denominator:1};
 const doc:AnimationDocument={id:"test",name:"Seeded",mode:"html",durationTick:framesToTicks(3,fps),canvas:{width:64,height:64,background:"#000000"},seed:42,nodes:[],operations:[],html:`<style>body{margin:0}</style><canvas width="64" height="64"></canvas><script>window.renderFrame=()=>{const c=document.querySelector('canvas').getContext('2d');c.fillStyle='rgb('+Math.floor(Math.random()*255)+','+Math.floor(Date.now()%255)+',0)';c.fillRect(0,0,64,64)}</script>`};
 try{
  const hashes=[];
  for(const n of [1,2]){const output=path.join(root,n+".mkv"),raw=path.join(root,n+".rgba");await renderAnimation(doc,config,{outputPath:output,fps});await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-f","rawvideo","-pix_fmt","rgba",raw]);const pixels=await readFile(raw);expect(pixels[0]).toBeGreaterThan(0);expect(pixels[1]).toBe(0);expect(pixels[64*64*4+1]).toBeGreaterThan(20);hashes.push(createHash("sha256").update(pixels).digest("hex"));}
  expect(hashes[0]).toBe(hashes[1]);
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),1000);
  await expect(renderAnimation({...doc,html:"<script>window.renderFrame=()=>{while(true){}}</script>"},config,{outputPath:path.join(root,"stuck.mkv"),fps,signal:controller.signal})).rejects.toThrow();
  clearTimeout(timer);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
