import {mkdtemp,readFile,writeFile,rm,stat} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";import {ProjectStore,sha256File} from "@mcp-video-studio/core";
import {exportProjectArchive,importProjectArchive,inspectProjectArchive} from "../packages/server/src/archive.js";
it("portable archives preserve media, repeat byte-for-byte and reject corrupt/traversal input without publication",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-archive-"));
 try{
  const store=await ProjectStore.create(path.join(root,"source"),"Archive fixture"),source=path.join(root,"local.wav");await writeFile(source,"media-fixture");const hash=await sha256File(source);
  await store.replace(0,p=>{p.media.push({id:"audio",name:"Local",kind:"audio",storage:{mode:"linked",path:source,...hash,mtimeMs:0},probe:{durationTick:35280000,hasAudio:true,hasVideo:false},createdAt:"2026-01-01T00:00:00Z"});},{sequences:[],tracks:[],clips:[],media:["audio"],animations:[],generatedArtifacts:[]});
  const first=path.join(root,"first.mcpstudio"),second=path.join(root,"second.mcpstudio");const a=await exportProjectArchive(store.root,first,1),b=await exportProjectArchive(store.root,second,1);expect(a.sha256).toBe(b.sha256);
  expect(await inspectProjectArchive(first)).toMatchObject({mediaCount:1,projectName:"Archive fixture",migration:{sourceSchemaVersion:2,targetSchemaVersion:2}});
  const destination=path.join(root,"imported");await importProjectArchive(first,destination);const imported=await new ProjectStore(destination).read(),media=imported.media[0]!;
  expect(media.storage.mode).toBe("managed");expect(imported.projectId).toBe((await store.read()).projectId);
  if(media.storage.mode==="managed")expect(await readFile(path.join(destination,media.storage.relativePath),"utf8")).toBe("media-fixture");
  await expect(importProjectArchive(first,destination)).rejects.toThrow("already exist");
  const data=await readFile(first);data[data.length-1]=data[data.length-1]!^1;const bad=path.join(root,"bad.mcpstudio");await writeFile(bad,data);
  const failed=path.join(root,"failed");await expect(importProjectArchive(bad,failed)).rejects.toThrow("checksum");expect(await stat(failed).catch(()=>undefined)).toBeUndefined();
  const original=await readFile(first),headerBytes=Buffer.from("MCPSTUDIO001\n").length,size=original.readUInt32BE(headerBytes),manifest=JSON.parse(original.subarray(headerBytes+4,headerBytes+4+size).toString());manifest.files[0].path="assets/../../escape";const encoded=Buffer.from(JSON.stringify(manifest)),length=Buffer.alloc(4);length.writeUInt32BE(encoded.length);
  await writeFile(bad,Buffer.concat([original.subarray(0,headerBytes),length,encoded,original.subarray(headerBytes+4+size)]));await expect(importProjectArchive(bad,failed)).rejects.toThrow("invalid media entry");expect(await readFile(source,"utf8")).toBe("media-fixture");
 }finally{await rm(root,{recursive:true,force:true});}
});
