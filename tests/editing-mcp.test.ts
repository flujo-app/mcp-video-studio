import {mkdtemp,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";import {expect,it} from "vitest";
import {Client,StreamableHTTPClientTransport} from "@modelcontextprotocol/client";
import {defaultClip,secondsToTicks,type StudioProject} from "@mcp-video-studio/contracts";import {loadConfig} from "@mcp-video-studio/media";
import {StudioRuntime} from "../packages/server/src/runtime.js";import {startGateway} from "../packages/server/src/gateway.js";import {startMcpHttp} from "../packages/server/src/http.js";
for(const mode of ["auto","legacy"] as const)it("actual "+mode+" MCP grouping/linking defaults and duplicate preserve linked automation",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-editing-wire-")),token="editing-fixture-0123456789-0123456789",runtime=new StudioRuntime(loadConfig({VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0",VIDEO_STUDIO_MCP_TOKEN:token}));await runtime.initialize();
 const gateway=await startGateway(runtime,"editor-fixture-0123456789-0123456789"),http=await startMcpHttp(runtime,gateway,0,"127.0.0.1"),client=new Client({name:"editing-contract",version:"1"},{versionNegotiation:{mode}});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url),{requestInit:{headers:{authorization:"Bearer "+token}}}));
  const created=await client.callTool({name:"create_project",arguments:{name:"Editing wire"}});expect(created.isError).not.toBe(true);
  const {projectPath,project}=created.structuredContent as{projectPath:string;project:StudioProject},sequence=project.sequences[0]!;
  const clips=sequence.tracks.slice(0,2).map(track=>defaultClip(track.id,{type:"color",color:"#123456"},track.name,secondsToTicks(2)));
  const apply=async(name:string,revision:number,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:{projectPath,expectedRevision:revision,sequenceId:sequence.id,...args}});expect(result.isError,JSON.stringify(result)).not.toBe(true);return result;};
  await apply("apply_timeline_transaction",0,{commands:[...clips.map(clip=>({type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"})),{type:"automation.set",sequenceId:sequence.id,lane:{id:"gain",sequenceId:sequence.id,target:"clip:"+clips[0]!.id+":gainDbOffset",enabled:true,points:[{tick:0,value:-6,curve:"linear"},{tick:secondsToTicks(2),value:0,curve:"linear"}]}}]});
  const get=async()=>((await client.callTool({name:"get_project",arguments:{projectPath}})).structuredContent as{project:StudioProject}).project;
  await apply("group_clips",1,{clipIds:clips.map(c=>c.id)});let value=await get();expect(value.sequences[0]!.clips[0]!.groupId).toBeTruthy();expect(new Set(value.sequences[0]!.clips.map(c=>c.groupId)).size).toBe(1);
  await apply("link_clips",2,{clipIds:clips.map(c=>c.id)});value=await get();expect(value.sequences[0]!.clips[0]!.linkedGroupId).toBeTruthy();
  await apply("duplicate_clips",3,{clipIds:[clips[0]!.id]});value=await get();const duplicated=value.sequences[0]!.clips.filter(c=>!clips.some(original=>original.id===c.id));
  expect(duplicated).toHaveLength(2);expect(duplicated.every(c=>c.startTick===secondsToTicks(2))).toBe(true);expect(duplicated[0]!.groupId).not.toBe(value.sequences[0]!.clips[0]!.groupId);expect(new Set(duplicated.map(c=>c.linkedGroupId)).size).toBe(1);
  const duplicatedVideo=duplicated.find(c=>c.trackId===clips[0]!.trackId)!;expect(value.sequences[0]!.automation.find(l=>l.target==="clip:"+duplicatedVideo.id+":gainDbOffset")!.points.map(p=>p.tick)).toEqual([secondsToTicks(2),secondsToTicks(4)]);
  await apply("group_clips",4,{clipIds:duplicated.map(c=>c.id),groupId:null});await apply("link_clips",5,{clipIds:duplicated.map(c=>c.id),linkedGroupId:null});value=await get();expect(value.sequences[0]!.clips.filter(c=>duplicated.some(d=>d.id===c.id)).every(c=>!c.groupId&&!c.linkedGroupId)).toBe(true);
  const stale=await client.callTool({name:"duplicate_clips",arguments:{projectPath,expectedRevision:3,sequenceId:sequence.id,clipIds:[clips[0]!.id]}});expect(stale.isError).toBe(true);expect((await get()).revision).toBe(6);
 }finally{await client.close();await http.close();await gateway.close();await runtime.jobs.close();await rm(root,{recursive:true,force:true});}
});
