import {randomUUID} from "node:crypto";import {z} from "zod";
import type {McpServer} from "@modelcontextprotocol/server";
import {MaskParametersSchema,type EffectInstance,type Sequence} from "@mcp-video-studio/contracts";
import {StudioException,asStudioError} from "@mcp-video-studio/core";
import type {StudioRuntime} from "./runtime.js";
export function registerMaskTools(server:McpServer,runtime:StudioRuntime):void{
 server.registerTool("set_clip_mask",{
  description:"Create or replace a bounded rectangle/ellipse clip mask without replacing unrelated effects. maskId selects an existing mask; parameters:null removes that mask. Bounds are fractions of the transformed clip rectangle. Multiple masks intersect after color effects.",
  inputSchema:z.object({projectPath:z.string().min(1),expectedRevision:z.number().int().nonnegative(),sequenceId:z.string().min(1),clipId:z.string().min(1),maskId:z.string().min(1).optional(),parameters:MaskParametersSchema.nullable(),enabled:z.boolean().default(true)}),
  annotations:{destructiveHint:true,openWorldHint:false}
 },async({projectPath,expectedRevision,sequenceId,clipId,maskId,parameters,enabled})=>{
  try{
   const {sequence}=await runtime.getSequence(projectPath,sequenceId) as{sequence:Sequence},clip=sequence.clips.find(item=>item.id===clipId);
   if(!clip)throw new StudioException("CLIP_NOT_FOUND","Select an existing clip.","input");
   if(maskId&&!clip.effects.some(effect=>effect.id===maskId&&effect.type==="mask"))throw new StudioException("MASK_NOT_FOUND","The mask ID must identify an existing mask on this clip.","input");
   if(parameters===null&&!maskId)throw new StudioException("MASK_NOT_FOUND","Removing a mask requires its ID.","input");
   const id=maskId??randomUUID(),replacement:EffectInstance|undefined=parameters?{id,type:"mask",version:1,enabled,parameters}:undefined;
   const effects=clip.effects.filter(effect=>effect.id!==id);if(replacement)effects.push(replacement);
   const data={...(await runtime.apply(projectPath,expectedRevision,[{type:"clip.update",sequenceId,clipId,patch:{effects}}])),maskId:id};
   return{content:[{type:"text" as const,text:JSON.stringify(data)}],structuredContent:data};
  }catch(error){const data={success:false,error:asStudioError(error)};return{content:[{type:"text" as const,text:JSON.stringify(data)}],structuredContent:data,isError:true};}
 });
}
