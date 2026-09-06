import {spawn} from "node:child_process";
import {mkdtemp,writeFile,readFile,readdir,rm,rename} from "node:fs/promises";
import path from "node:path";import os from "node:os";import {it,expect} from "vitest";
import {atomicWrite} from "@mcp-video-studio/core";
const windows=process.platform==="win32"?it:it.skip;
async function sharingLock(file:string){
 const script="$file=[System.IO.File]::Open($env:STUDIO_LOCK_PATH,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read);try{[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();$null=[Console]::In.ReadLine()}finally{$file.Dispose()}";
 const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{env:{...process.env,STUDIO_LOCK_PATH:file},windowsHide:true,stdio:["pipe","pipe","pipe"]});
 let stderr="";child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-3000);});child.stdin.on("error",()=>undefined);
 const exited=new Promise<void>(resolve=>child.once("close",()=>resolve()));
 const close=async()=>{if(child.exitCode===null&&child.signalCode===null)child.stdin.end("\n");const timer=setTimeout(()=>child.kill(),2000);try{await exited;}finally{clearTimeout(timer);}};
 try{await new Promise<void>((resolve,reject)=>{let out="";const timer=setTimeout(()=>reject(new Error("Native reader failed to acquire file: "+stderr)),15000);child.stdout.on("data",chunk=>{out+=String(chunk);if(out.includes("LOCKED")){clearTimeout(timer);resolve();}});child.once("error",error=>{clearTimeout(timer);reject(error);});child.once("exit",()=>{clearTimeout(timer);if(!out.includes("LOCKED"))reject(new Error("Native reader exited before lock: "+stderr));});});}
 catch(error){await close();throw error;}
 return{close};
}
windows("atomic journal replacement survives an actual short Windows read-sharing lock",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-atomic-sharing-"));let lock:Awaited<ReturnType<typeof sharingLock>>|undefined,writing:Promise<unknown>|undefined;
 try{
  const file=path.join(root,"journal.json");await writeFile(file,"prior complete record");lock=await sharingLock(file);
  await expect(rename(file,path.join(root,"must-stay.json"))).rejects.toMatchObject({code:expect.stringMatching(/EPERM|EACCES|EBUSY/)});
  writing=atomicWrite(file,"next complete record").then(()=>null,error=>error);
  await new Promise(resolve=>setTimeout(resolve,100));expect(await readFile(file,"utf8")).toBe("prior complete record");
  await lock.close();expect(await writing).toBeNull();expect(await readFile(file,"utf8")).toBe("next complete record");expect(await readdir(root)).toEqual(["journal.json"]);
 }finally{await lock?.close();await writing;await rm(root,{recursive:true,force:true});}
},25000);
windows("a sustained sharing violation fails within the retry bound and preserves prior data",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-atomic-bound-"));let lock:Awaited<ReturnType<typeof sharingLock>>|undefined;
 try{
  const file=path.join(root,"journal.json");await writeFile(file,"prior complete record");lock=await sharingLock(file);const started=Date.now();
  await expect(atomicWrite(file,"must not publish")).rejects.toMatchObject({code:expect.stringMatching(/EPERM|EACCES|EBUSY/)});
  expect(Date.now()-started).toBeLessThan(5000);expect(await readFile(file,"utf8")).toBe("prior complete record");expect(await readdir(root)).toEqual(["journal.json"]);
 }finally{await lock?.close();await rm(root,{recursive:true,force:true});}
},25000);
