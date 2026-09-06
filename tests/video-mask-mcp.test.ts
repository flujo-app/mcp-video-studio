import {mkdtemp,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";import {expect,it} from "vitest";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";import {defaultClip,secondsToTicks,type StudioProject} from "@mcp-video-studio/contracts";import {loadConfig} from "@mcp-video-studio/media";
import {StudioRuntime} from "../packages/server/src/runtime.js";import {startGateway} from "../packages/server/src/gateway.js";import {startMcpHttp} from "../packages/server/src/http.js";
for(const mode of ["auto","legacy"] as const)it("actual "+mode+" typed mask edits preserve unrelated effects and enforce revision/identity boundaries",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-mask-wire-")),token="mask-fixture-0123456789-0123456789",runtime=new StudioRuntime(loadConfig({VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0",VIDEO_STUDIO_MCP_TOKEN:token}));await runtime.initialize();
 const gateway=await startGateway(runtime,"mask-editor-0123456789-0123456789"),http=await startMcpHttp(runtime,gateway,0,"127.0.0.1"),client=new Client({name:"mask-editor",version:"1"},{versionNegotiation:{mode}});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url),{requestInit:{headers:{authorization:"Bearer "+token}}}));
  const created=(await client.callTool({name:"create_project",arguments:{name:"Mask wire"}})).structuredContent as{projectPath:string;project:StudioProject};const {projectPath,project}=created,sequence=project.sequences[0]!,clip=defaultClip(sequence.tracks[0]!.id,{type:"color",color:"#ff0000"},"Red",secondsToTicks(1));
  clip.effects=[{id:"unrelated-color",type:"brightness",version:1,enabled:true,parameters:{value:.1}}];
  const initial=await client.callTool({name:"apply_timeline_transaction",arguments:{projectPath,expectedRevision:0,commands:[{type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"}]}});expect(initial.isError).not.toBe(true);
  const call=(expectedRevision:number,extra:Record<string,unknown>)=>client.callTool({name:"set_clip_mask",arguments:{projectPath,expectedRevision,sequenceId:sequence.id,clipId:clip.id,...extra}});
  const added=await call(1,{parameters:{shape:"ellipse",width:.4,height:.4,x:.3,y:.3}});expect(added.isError).not.toBe(true);const maskId=String((added.structuredContent as{maskId:string}).maskId);
  const get=async()=>((await client.callTool({name:"get_project",arguments:{projectPath}})).structuredContent as{project:StudioProject}).project;
  let value=await get();expect(value.sequences[0]!.clips[0]!.effects[0]).toEqual(clip.effects[0]);expect(value.sequences[0]!.clips[0]!.effects[1]).toMatchObject({id:maskId,type:"mask",parameters:{shape:"ellipse",width:.4}});
  expect((await call(1,{maskId,parameters:{shape:"rectangle"}})).isError).toBe(true);expect((await get()).revision).toBe(2);
  expect((await call(2,{maskId:"unrelated-color",parameters:{shape:"rectangle"}})).isError).toBe(true);expect((await get()).revision).toBe(2);
  expect((await call(2,{maskId,parameters:{shape:"rectangle",invert:true},enabled:false})).isError).not.toBe(true);
  expect((await call(3,{maskId,parameters:null})).isError).not.toBe(true);value=await get();expect(value.sequences[0]!.clips[0]!.effects).toEqual(clip.effects);
  expect((await client.callTool({name:"undo",arguments:{projectPath,expectedRevision:4}})).isError).not.toBe(true);value=await get();expect(value.sequences[0]!.clips[0]!.effects[1]).toMatchObject({id:maskId,enabled:false,parameters:{invert:true}});
 }finally{await client.close();await http.close();await gateway.close();await runtime.jobs.close();await rm(root,{recursive:true,force:true});}
});
