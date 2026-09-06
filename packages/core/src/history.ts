import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectCommand, StudioProject } from "@mcp-video-studio/contracts";
import { confinedPath, readJson, writeJson } from "./fs.js";
import { StudioException } from "./errors.js";

export interface HistoryEntry { id:string;createdAt:string;commands:ProjectCommand[];before:StudioProject;after:StudioProject }
export interface HistoryState {past:string[];future:string[]}
function entryPath(root:string,id:string){if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id))throw new StudioException("INVALID_HISTORY","Invalid history transaction ID.","policy");return confinedPath(root,path.join(root,"history","transactions",id+".json"));}
export async function loadHistoryState(root:string):Promise<HistoryState>{
  const document=await readJson<StudioProject&{_history?:HistoryState}>(path.join(root,"project.json"));
  let state=document._history;
  if(!state){
    const file=path.join(root,"history","state.json");
    if(!await stat(file).catch(()=>undefined))return{past:[],future:[]};
    state=await readJson<HistoryState>(file);
  }
  if(!state||!Array.isArray(state.past)||!Array.isArray(state.future)||state.past.length+state.future.length>200||[...state.past,...state.future].some(id=>typeof id!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)))throw new StudioException("INVALID_HISTORY","History state is invalid; preserve it for recovery.","runtime");
  return state;
}
export async function commitProject(root:string,project:StudioProject,state:HistoryState):Promise<void>{
  // This single atomic replacement is the commit point for both the document and undo cursor.
  await writeJson(path.join(root,"project.json"),{...project,_history:state});
  const retained=new Set([...state.past,...state.future].map(id=>id+".json"));
  const directory=confinedPath(root,path.join(root,"history","transactions"));
  // Garbage collection cannot turn a committed transaction into a reported failure.
  await readdir(directory).then(names=>Promise.all(names.filter(name=>/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name)&&!retained.has(name)).map(name=>rm(path.join(directory,name),{force:true})))).catch(()=>undefined);
}
export async function recordHistory(root:string,entry:HistoryEntry):Promise<void>{
  await mkdir(path.dirname(entryPath(root,entry.id)),{recursive:true});
  const state=await loadHistoryState(root);
  await writeJson(entryPath(root,entry.id),entry);
  await commitProject(root,entry.after,{past:[...state.past,entry.id].slice(-200),future:[]});
}
export async function historyUndo(root:string):Promise<{project:StudioProject;transactionId:string;state:HistoryState}|undefined>{
  const state=await loadHistoryState(root),id=state.past.at(-1);if(!id)return;
  const entry=await readJson<HistoryEntry>(entryPath(root,id));
  return{project:entry.before,transactionId:id,state:{past:state.past.slice(0,-1),future:[id,...state.future]}};
}
export async function historyRedo(root:string):Promise<{project:StudioProject;transactionId:string;state:HistoryState}|undefined>{
  const state=await loadHistoryState(root),id=state.future[0];if(!id)return;
  const entry=await readJson<HistoryEntry>(entryPath(root,id));
  return{project:entry.after,transactionId:id,state:{past:[...state.past,id],future:state.future.slice(1)}};
}
export async function verifyHistory(root:string):Promise<{entries:number;missing:string[]}>{
  const state=await loadHistoryState(root),names=await readdir(path.join(root,"history","transactions")).catch(()=>[]);
  const present=new Set(names.filter(name=>name.endsWith(".json")).map(name=>name.slice(0,-5)));
  return{entries:present.size,missing:[...state.past,...state.future].filter(id=>!present.has(id))};
}
