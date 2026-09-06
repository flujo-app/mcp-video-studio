import { mkdtemp,readFile,rm,symlink,writeFile,open } from "node:fs/promises";
import path from "node:path";import os from "node:os";
import { afterEach,expect,it,vi } from "vitest";
const fault=vi.hoisted(()=>({path:""}));
vi.mock("../packages/core/src/fs.js",async importOriginal=>{
 const actual=await importOriginal<typeof import("../packages/core/src/fs.js")>();
 return {...actual,writeJson:async(file:string,value:unknown)=>{if(fault.path&&file.includes(fault.path))throw Object.assign(new Error("Injected disk full"),{code:"ENOSPC"});return actual.writeJson(file,value);}};
});
import { ProjectStore,confinedPath,readJson } from "@mcp-video-studio/core";
const roots:string[]=[];afterEach(async()=>{fault.path="";await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),"studio-fault-"));roots.push(root);return{root,store:await ProjectStore.create(path.join(root,"project"),"Original")};}
it("failed history write or project publication never advances canonical revision/undo cursor",async()=>{
 const {store}=await fixture();
 fault.path="transactions";
 await expect(store.mutate(0,[{type:"project.rename",name:"Failed"}])).rejects.toThrow("disk full");
 fault.path="";expect((await store.read()).name).toBe("Original");
 await store.mutate(0,[{type:"project.rename",name:"Committed"}]);
 fault.path="project.json";
 await expect(store.undo(1)).rejects.toThrow("disk full");
 fault.path="";expect((await store.read()).revision).toBe(1);
 await store.undo(1);expect((await store.read()).name).toBe("Original");
 await store.redo(2);expect((await store.read()).name).toBe("Committed");
 const document=JSON.parse(await readFile(path.join(store.root,"project.json"),"utf8"));
 expect(document._history.past).toHaveLength(1);expect(document._history.future).toHaveLength(0);
});
it("rejects path traversal, managed symlink escapes and unsafe IDs before consuming files",async()=>{
 const {store,root}=await fixture();const outside=path.join(root,"outside");await writeFile(outside,"canary");
 expect(()=>confinedPath(store.root,outside)).toThrow();
 await symlink(outside,path.join(store.root,"assets","escape"));
 expect(()=>confinedPath(store.root,path.join(store.root,"assets","escape"))).toThrow();
 await expect(store.replace(0,p=>{p.sequences[0]!.id="../escape";},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]})).rejects.toThrow();
 expect(await readFile(outside,"utf8")).toBe("canary");
});

it("rejects oversized JSON documents before parsing or allocating their body",async()=>{
 const {root}=await fixture(),file=path.join(root,"oversized.json");
 const handle=await open(file,"w");try{await handle.truncate(64*1024*1024+1);}finally{await handle.close();}
 await expect(readJson(file)).rejects.toThrow("64 MiB");
});

it("upgrades schema 1 only on commit, preserves a recovery copy, and prevents old readers accepting new cursor semantics",async()=>{
 const {store}=await fixture(),file=path.join(store.root,"project.json"),legacy={...await store.read(),schemaVersion:1};
 await writeFile(file,JSON.stringify(legacy));
 expect((await store.read()).schemaVersion).toBe(2);
 expect(JSON.parse(await readFile(file,"utf8")).schemaVersion).toBe(1);
 await store.mutate(0,[{type:"project.rename",name:"Migrated"}]);
 expect(JSON.parse(await readFile(file,"utf8")).schemaVersion).toBe(2);
 expect(JSON.parse(await readFile(path.join(store.root,"history","schema1-project.json"),"utf8"))).toEqual(legacy);
 await new ProjectStore(store.root).undo(1);
 expect((await store.read()).name).toBe("Original");
});
