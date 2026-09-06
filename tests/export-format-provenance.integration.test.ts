import {readFile,writeFile,access} from "node:fs/promises";import path from "node:path";
import {it,expect} from "vitest";
import {secondsToTicks} from "@mcp-video-studio/contracts";
import {generationFixture,until} from "./generation-fixture.js";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
for(const mode of ["auto","legacy"] as const)integration(mode+" MCP export ranges, built-ins and actual encoder replay persist without changing the project",async()=>{
 const f=await generationFixture();
 try{
  const client=await f.client(mode),project=await f.store.read(),sequence=project.sequences[0]!;
  await f.call(client,"add_clip",{projectPath:f.projectPath,expectedRevision:project.revision,sequenceId:sequence.id,trackId:sequence.tracks.find(track=>track.type==="video")!.id,name:"Export fixture",source:{type:"color",color:"#1478a0"},startTick:0,durationTick:secondsToTicks(2)});
  const before=await f.store.read(),capabilities=await f.call(client,"get_export_capabilities",{});
  expect(capabilities.presets.some((p:any)=>p.id==="png-sequence")).toBe(true);expect(capabilities.encoders.find((e:any)=>e.name==="libx265").usable).toBe(true);
  const unavailable=capabilities.encoders.find((e:any)=>e.hardware&&e.codec==="h264"&&!e.usable).name;
  const range={startTick:secondsToTicks(.5),endTick:secondsToTicks(1.5)},output=path.join(f.root,"fallback.mp4");
  const queued=await f.call(client,"render_sequence",{projectPath:f.projectPath,sequenceId:sequence.id,presetId:"web-h264-1080p",outputPath:output,expectedRevision:before.revision,range,encoder:{name:unavailable,allowSoftwareFallback:true}});
  const result=(await f.done(queued.job.id)).result as any;expect(result.encoder).toMatchObject({requested:unavailable,selected:"libx264",fallback:true});expect(result.frameCount).toBe(30);
  const history=(await f.call(client,"get_export_history",{exportId:queued.exportId})).export;expect(history.range).toEqual(range);expect(history.encoder).toMatchObject({name:unavailable,allowSoftwareFallback:true});
  const replay=await f.call(client,"reproduce_export",{projectPath:f.projectPath,exportId:queued.exportId,outputPath:path.join(f.root,"replayed.mp4")}),replayed=(await f.done(replay.job.id)).result as any;
  expect(replayed.encoder).toMatchObject({requested:"libx264",selected:"libx264",fallback:false});expect(replayed.sha256).toBe(result.sha256);
  const zip=await f.call(client,"render_sequence",{projectPath:f.projectPath,sequenceId:sequence.id,presetId:"png-sequence",outputPath:path.join(f.root,"frames.zip"),range}),zipResult=(await f.done(zip.job.id)).result as any;
  const zipReplay=await f.call(client,"reproduce_export",{projectPath:f.projectPath,exportId:zip.exportId,outputPath:path.join(f.root,"replayed.zip")});expect(((await f.done(zipReplay.job.id)).result as any).sha256).toBe(zipResult.sha256);
  expect(await f.store.read()).toEqual(before);
  // Simulate a receipt from a machine that had this hardware; replay must not reuse original fallback permission.
  const receipt=path.join(f.config.dataDir,"render-operations",queued.exportId+".json"),saved=JSON.parse(await readFile(receipt,"utf8"));saved.result.encoder.selected=unavailable;saved.result.encoder.hardware=true;saved.result.encoder.fallback=false;await writeFile(receipt,JSON.stringify(saved));
  const impossible=path.join(f.root,"hardware-replay.mp4"),failed=await f.call(client,"reproduce_export",{projectPath:f.projectPath,exportId:queued.exportId,outputPath:impossible});
  await until(()=>["failed","completed"].includes(f.runtime.jobs.get(failed.job.id)?.status??""));const failedJob=f.runtime.jobs.get(failed.job.id)!;expect(failedJob.status).toBe("failed");expect(failedJob.error?.code).toBe("ENCODER_UNAVAILABLE");await expect(access(impossible)).rejects.toThrow();
  const malformed=await client.callTool({name:"render_sequence",arguments:{projectPath:f.projectPath,sequenceId:sequence.id,presetId:"web-h264-1080p",outputPath:output,encoder:{name:"libx264",allowSoftwareFallback:"yes"}}});expect(malformed.isError).toBe(true);
 }finally{await f.close();}
},120000);
