import { open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StudioException } from "./errors.js";

export async function projectWriteLock<T>(root:string, operation:()=>Promise<T>):Promise<T>{
  const lockPath=path.join(root,".studio-write-lock"),nonce=randomUUID(),deadline=Date.now()+30000;
  for(;;){
    try{
      const handle=await open(lockPath,"wx",0o600);
      try{await handle.writeFile(JSON.stringify({pid:process.pid,nonce}));await handle.sync();}finally{await handle.close();}
      break;
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;
      try{
        const content=await readFile(lockPath,"utf8"),owner=JSON.parse(content) as {pid:number;nonce:string};
        if(!Number.isInteger(owner.pid)||owner.pid<=0)throw new Error("Invalid lock owner.");
        let dead=false;
        try{process.kill(owner.pid,0);}catch(probe){dead=(probe as NodeJS.ErrnoException).code==="ESRCH";}
        if(dead&&(await readFile(lockPath,"utf8"))===content){await rm(lockPath);continue;}
      }catch{
        const info=await stat(lockPath).catch(()=>undefined);
        if(info&&Date.now()-info.mtimeMs>60000){throw new StudioException("STALE_LOCK","An invalid project lock needs inspection before recovery.","conflict");}
      }
      if(Date.now()>=deadline)throw new StudioException("PROJECT_BUSY","Another process is writing this project. Retry after it completes.","conflict");
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  }
  try{return await operation();}
  finally{
    const owner=await readFile(lockPath,"utf8").then(value=>JSON.parse(value) as {nonce:string}).catch(()=>undefined);
    if(owner?.nonce===nonce)await rm(lockPath,{force:true});
  }
}
