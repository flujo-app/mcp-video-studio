import {mkdtemp,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";import {expect,it} from "vitest";
import {defaultClip,secondsToTicks,MaskParametersSchema} from "@mcp-video-studio/contracts";import {ProjectStore} from "@mcp-video-studio/core";import {maskFilters} from "../packages/renderer/src/masks.js";
it("mask geometry is strict scalar data and invalid edits leave the project/history unchanged",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-mask-validation-"));try{
  const store=await ProjectStore.create(root,"Masks"),p=await store.read(),s=p.sequences[0]!,clip=defaultClip(s.tracks[0]!.id,{type:"color",color:"#ff0000"},"Masked clip",secondsToTicks(1));
  await store.mutate(0,[{type:"clip.add",sequenceId:s.id,clip,mode:"overwrite"}]);const before=await store.read();
  for(const parameters of [{shape:"freeform"},{x:"0;movie=/secret"},{width:0},{x:.8,width:.4},{feather:.4,width:.2},{invert:"yes"},{opacity:Infinity},{shape:"ellipse",expression:"random(1)"}]){
   expect(MaskParametersSchema.safeParse(parameters).success).toBe(false);expect(()=>maskFilters(parameters)).toThrow("bounded");
   await expect(store.mutate(1,[{type:"clip.update",sequenceId:s.id,clipId:clip.id,patch:{effects:[{id:"invalid",type:"mask",version:1,enabled:true,parameters}]}}])).rejects.toThrow();
   expect(await store.read()).toEqual(before);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
