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

integration("HTML uses seeded crypto and frame hooks, and cannot navigate, download or register service workers",async()=>{
 const browser=await chromium.launch({headless:true,env:browserEnvironment()});try{
  const context=await browser.newContext({serviceWorkers:"block",acceptDownloads:false}),page=await context.newPage();let downloads=0;page.on("download",()=>downloads++);
  const frame=await prepareSandbox(browser,page,context,"<script>window.renderFrame=()=>{};</script>",12);
  const check=await frame.evaluate(async()=>{
   const w=window as unknown as {__studioFrame(t:number,f:number):void};
   const results:Record<string,unknown>={};for(const name of ["setTimeout","setInterval","requestAnimationFrame"]){try{(window[name as keyof Window] as (callback:()=>void)=>void)(()=>{});results[name]=true;}catch{results[name]=false;}}
   w.__studioFrame(1,30);const a=[...crypto.getRandomValues(new Uint8Array(16))],uuid=crypto.randomUUID();w.__studioFrame(1,30);const b=[...crypto.getRandomValues(new Uint8Array(16))],again=crypto.randomUUID();results.random=JSON.stringify(a)===JSON.stringify(b)&&uuid===again;results.clock=Date.now()===1000&&performance.now()===1000&&performance.timeOrigin===0;
   try{await navigator.serviceWorker.register("data:text/javascript,self.onfetch=()=>{}");results.serviceWorker=true;}catch{results.serviceWorker=false;}
   const link=document.createElement("a");link.href="data:text/plain,offline-download";link.download="blocked.txt";document.body.append(link);link.click();return results;
  },undefined,false);
  expect(check).toEqual({setTimeout:false,setInterval:false,requestAnimationFrame:false,random:true,clock:true,serviceWorker:false});
  await new Promise(resolve=>setTimeout(resolve,100));expect(downloads).toBe(0);
  await frame.evaluate(()=>{location.href="about:blank";},undefined,false).catch(()=>undefined);
  for(let n=0;n<100&&!page.isClosed();n++)await new Promise(resolve=>setTimeout(resolve,10));
  expect(page.isClosed()).toBe(true);
 }finally{await browser.close();}
},30000);
integration("CSS animation screenshots retain the requested paused time instead of fast-forwarding",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-css-")),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")}),fps={numerator:1,denominator:1};
 try{
  const document:AnimationDocument={id:"css",name:"CSS clock",mode:"html",durationTick:framesToTicks(2,fps),canvas:{width:32,height:32,background:"#000000"},seed:1,nodes:[],operations:[],html:'<style>html,body{margin:0;width:100%;height:100%}body{animation:color 2s linear both}@keyframes color{from{background:rgb(255,0,0)}to{background:rgb(0,0,255)}}</style><script>window.renderFrame=()=>{};</script>'};
  const hashes=[];for(const name of ["one","two"]){const output=path.join(root,name+".mkv"),raw=output+".rgba";await renderAnimation(document,config,{fps,outputPath:output});await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",output,"-f","rawvideo","-pix_fmt","rgba",raw]);const pixels=await readFile(raw),offset=32*32*4;expect(pixels[0]).toBeGreaterThan(240);expect(pixels[2]).toBeLessThan(10);expect(pixels[offset]).toBeGreaterThan(50);expect(pixels[offset]).toBeLessThan(220);expect(pixels[offset+2]).toBeGreaterThan(50);hashes.push(createHash("sha256").update(pixels).digest("hex"));}
  expect(hashes[0]).toBe(hashes[1]);
 }finally{await rm(root,{recursive:true,force:true});}
},60000);
