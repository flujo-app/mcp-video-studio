import {afterEach,it,expect} from "vitest";
import {mkdtemp,writeFile,readFile,rm,symlink} from "node:fs/promises";
import os from "node:os";import path from "node:path";import {createHash} from "node:crypto";
import {createDefaultProject,TICKS_PER_SECOND} from "@mcp-video-studio/contracts";
import {resolveExportRange} from "../packages/renderer/src/export-range.js";
import {pngFrameName,writePngSequenceZip} from "../packages/renderer/src/png-sequence.js";
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==","base64");
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),"studio-png-"));roots.push(root);const settings={...createDefaultProject("PNG").settings,raster:{width:1,height:1},fps:{numerator:1,denominator:1}};const range=resolveExportRange(settings,TICKS_PER_SECOND,false);await writeFile(path.join(root,pngFrameName(1)),png);return {root,settings,range};}
import {storedZipEntries} from "./export-fixture.js";
it("writes a standard independently readable ZIP and exact numbered PNG/hash manifest",async()=>{
 const {root,settings,range}=await fixture(),output=path.join(os.tmpdir(),path.basename(root)+".zip");roots.push(output);
 const result=await writePngSequenceZip(root,output,settings,range),entries=storedZipEntries(await readFile(output));
 expect([...entries.keys()]).toEqual(["frame-00000001.png","manifest.json"]);expect(entries.get("frame-00000001.png")).toEqual(png);
 const manifest=JSON.parse(entries.get("manifest.json")!.toString());expect(manifest).toEqual(result.manifest);expect(manifest.frames[0].sha256).toBe(createHash("sha256").update(png).digest("hex"));expect(manifest.audioIncluded).toBe(false);
});
it("supports a standard ZIP64 end record and keeps metadata reproducible",async()=>{
 const {root,settings,range}=await fixture(),first=path.join(os.tmpdir(),path.basename(root)+"-1.zip"),second=path.join(os.tmpdir(),path.basename(root)+"-2.zip");roots.push(first,second);
 await writePngSequenceZip(root,first,settings,range,undefined,{forceZip64Format:true});await writePngSequenceZip(root,second,settings,range,undefined,{forceZip64Format:true});
 const bytes=await readFile(first);expect(bytes.includes(Buffer.from([0x50,0x4b,0x06,0x06]))).toBe(true);expect(storedZipEntries(bytes).size).toBe(2);expect(bytes).toEqual(await readFile(second));
});
it("rejects invalid dimensions, unexpected paths, unsupported frame counts and cancellation",async()=>{
 const {root,settings,range}=await fixture(),output=path.join(os.tmpdir(),path.basename(root)+".zip");roots.push(output);
 await expect(writePngSequenceZip(root,output,{...settings,raster:{width:2,height:1}},range)).rejects.toThrow(/dimensions/);
 await writeFile(path.join(root,"unexpected.png"),png);await expect(writePngSequenceZip(root,output,settings,range)).rejects.toThrow(/count/);await rm(path.join(root,"unexpected.png"));
 const cancelled=new AbortController();cancelled.abort();await expect(writePngSequenceZip(root,output,settings,range,cancelled.signal)).rejects.toThrow();
 for(const index of [0,-1,100001,1.5])expect(()=>pngFrameName(index)).toThrow();
 await expect(readFile(output)).rejects.toThrow();
});
it.runIf(process.platform!=="win32")("refuses symbolic links among generated frames",async()=>{
 const {root,settings,range}=await fixture(),frame=path.join(root,pngFrameName(1)),outside=path.join(os.tmpdir(),path.basename(root)+"-outside.png"),output=outside+".zip";roots.push(outside,output);await writeFile(outside,png);await rm(frame);await symlink(outside,frame);
 await expect(writePngSequenceZip(root,output,settings,range)).rejects.toThrow(/regular/);
});
