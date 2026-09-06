import {mkdtemp,readFile,readdir,realpath,rm,writeFile} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {it,expect} from "vitest";import {chromium} from "patchright";import {Client} from "@modelcontextprotocol/client";import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {secondsToTicks,type StudioProject} from "@mcp-video-studio/contracts";import {browserEnvironment} from "../packages/animation/src/sandbox.js";import {storedZipEntries} from "./export-fixture.js";
const integration=process.env.RUN_BROWSER_INTEGRATION==="1"&&process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("actual bundled stdio MCP and browser export PNG/GIF ranges and replay saved settings",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-export-browser-")),projectPath=path.join(root,"project");
 const client=new Client({name:"export-browser-acceptance",version:"1"},{versionNegotiation:{mode:"auto"}}),transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(process.env.STUDIO_TEST_ENTRY??"dist/index.js"),"--stdio"],env:{...Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>typeof p[1]==="string")),VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"},stderr:"pipe"});
 const browser=await chromium.launch({headless:true,env:browserEnvironment()});
 const pendingJobs=new Set<string>();let failure:unknown,childStderr="";transport.stderr?.on("data",chunk=>{childStderr=(childStderr+String(chunk)).slice(-16000);});
 const redact=(value:unknown)=>String(value).replace(/Bearer\s+[^\s"\']+/gi,"Bearer [redacted]").replace(/([?&]token=)[^&\s"\']+/g,"$1[redacted]");
 async function call(name:string,args:Record<string,unknown>={}):Promise<Record<string,any>>{const result=await client.callTool({name,arguments:args}),data=result.structuredContent as Record<string,any>;expect(result.isError,JSON.stringify(data)).not.toBe(true);return data;}
 async function done(id:string){
  pendingJobs.add(id);let last:Record<string,any>|undefined;const deadline=Date.now()+180000;
  while(Date.now()<deadline){const {job}=await call("get_job",{jobId:id});last=job;
   if(["completed","failed","cancelled"].includes(job.status)){pendingJobs.delete(id);if(job.status==="completed")return job.result;throw new Error(JSON.stringify(job));}
   await new Promise(r=>setTimeout(r,100));
  }
  throw new Error("Export browser job exceeded its bounded 180-second wait: "+JSON.stringify(last));
 }
 try{
  await client.connect(transport);await call("create_project",{name:"Export range acceptance",projectPath});let project=(await call("get_project",{projectPath})).project as StudioProject;const sequence=project.sequences[0]!;
  await call("add_clip",{projectPath,expectedRevision:project.revision,sequenceId:sequence.id,trackId:sequence.tracks[0]!.id,name:"Export slate",source:{type:"color",color:"#1478a0"},startTick:0,durationTick:secondsToTicks(2)});
  project=(await call("get_project",{projectPath})).project;
  const opened=await call("open_studio"),url=new URL(opened.studioUrl);url.searchParams.set("projectPath",projectPath);
  const page=await browser.newPage({viewport:{width:1600,height:1200}});page.setDefaultTimeout(30000);const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto(url.toString());await page.getByText("Project loaded",{exact:true}).waitFor();await page.getByRole("button",{name:"Export",exact:true}).click();
  await page.getByLabel("Export preset",{exact:true}).selectOption("png-sequence");
  await page.getByRole("button",{name:"Check available encoders",exact:true}).click();await page.getByText("png: test frame encoded successfully",{exact:true}).waitFor();
  await page.getByLabel("Export selected range",{exact:true}).check();await page.getByLabel("Export range start",{exact:true}).fill("15");await page.getByLabel("Export range end",{exact:true}).fill("45");
  const output=path.join(root,"frames.zip");await page.getByLabel("Export output path",{exact:true}).fill(output);
  const response=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/render"&&response.status()===202);await page.getByRole("button",{name:"Queue render",exact:true}).click();const queued=await (await response).json(),result=await done(queued.job.id);
  expect(result.encoder.selected).toBe("png");expect(result.range).toMatchObject({startFrame:15,endFrame:45,frameCount:30});expect(storedZipEntries(await readFile(output)).size).toBe(31);
  await page.getByRole("button",{name:"Export",exact:true}).click();await page.getByLabel("Saved export",{exact:true}).selectOption(queued.exportId);await page.getByText("Output and source checksums",{exact:true}).click();await page.getByText("Encoder used: png",{exact:true}).waitFor();
  const replay=path.join(root,"replayed.zip");await page.getByLabel("Reproduced output path",{exact:true}).fill(replay);
  const replayResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/exports/reproduce"&&response.status()===202);
  await page.getByRole("button",{name:"Reproduce saved export",exact:true}).click();const replayQueued=await (await replayResponse).json(),replayResult=await done(replayQueued.job.id);
  // The server canonicalizes output parents; macOS temporary paths can use /var aliases for /private/var.
  expect(await realpath(replayResult.outputPath)).toBe(await realpath(replay));expect(replayResult.encoder.selected).toBe("png");
  await page.getByText("Saved revision reproduced: "+replayResult.outputPath,{exact:true}).waitFor();expect(await readFile(replay)).toEqual(await readFile(output));
  await page.getByLabel("Export preset",{exact:true}).selectOption("animated-gif");await page.getByLabel("Export selected range",{exact:true}).check();await page.getByLabel("Export range start",{exact:true}).fill("30");await page.getByLabel("Export range end",{exact:true}).fill("45");
  const gif=path.join(root,"range.gif");await page.getByLabel("Export output path",{exact:true}).fill(gif);const gifResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/render"&&response.status()===202);await page.getByRole("button",{name:"Queue render",exact:true}).click();const gifQueued=await (await gifResponse).json(),gifResult=await done(gifQueued.job.id);expect(gifResult.probe.hasAudio).toBe(false);expect(gifResult.frameCount).toBe(15);expect((await readFile(gif)).subarray(0,6).toString()).toBe("GIF89a");
  const hevc=await call("render_sequence",{projectPath,sequenceId:sequence.id,presetId:"web-hevc",outputPath:path.join(root,"range-hevc.mp4"),range:{startTick:secondsToTicks(1),endTick:secondsToTicks(1.5)}});expect((await done(hevc.job.id)).probe.videoCodec).toBe("hevc");
  expect((await call("get_project",{projectPath})).project).toEqual(project);expect(errors).toEqual([]);
 }catch(error){failure=error;const cause=new Error(redact(error));if(error instanceof Error&&error.stack)cause.stack=redact(error.stack);throw new Error(cause.message+"; child stderr: "+redact(childStderr),{cause});}
 finally{
  // An MCP client's forced process termination is not a job-cancellation protocol.
  // Settle owned exports before closing the transport or deleting their files.
  const cleanup:unknown[]=[];
  try{await browser.close();}catch(error){cleanup.push(error);}
  for(const jobId of pendingJobs)try{await call("cancel_job",{jobId});}catch(error){cleanup.push(error);}
  try{await client.close();}catch(error){cleanup.push(error);}
  try{await rm(root,{recursive:true,force:true});}catch(error){cleanup.push(error);}
  if(cleanup.length){if(failure===undefined)throw new AggregateError(cleanup,"Export browser cleanup failed");console.error("Export cleanup after primary failure: "+cleanup.map(redact).join("; "));}
 }
},360000);

integration("installed stdio cancellation settles a real open HEVC artifact before client and filesystem teardown",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-export-cancel-")),projectPath=path.join(root,"project"),output=path.join(root,"protected.mp4");
 const client=new Client({name:"export-cancel-acceptance",version:"1"},{versionNegotiation:{mode:"auto"}}),transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(process.env.STUDIO_TEST_ENTRY??"dist/index.js"),"--stdio"],env:{...Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>typeof p[1]==="string")),VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"},stderr:"pipe"});
 transport.stderr?.on("data",()=>undefined);let pending:string|undefined,failure:unknown;
 async function call(name:string,args:Record<string,unknown>={}):Promise<Record<string,any>>{const result=await client.callTool({name,arguments:args}),data=result.structuredContent as Record<string,any>;expect(result.isError,JSON.stringify(data)).not.toBe(true);return data;}
 try{
  await client.connect(transport);await call("create_project",{name:"Owned export cancellation",projectPath});const project=(await call("get_project",{projectPath})).project as StudioProject,sequence=project.sequences[0]!;
  await call("add_clip",{projectPath,expectedRevision:project.revision,sequenceId:sequence.id,trackId:sequence.tracks[0]!.id,name:"Cancel real encoder",source:{type:"color",color:"#1478a0"},startTick:0,durationTick:secondsToTicks(29)});
  await writeFile(output,"original destination");const queued=await call("render_sequence",{projectPath,sequenceId:sequence.id,presetId:"web-hevc",outputPath:output});pending=queued.job.id;
  let opened=false;const deadline=Date.now()+45000;
  while(Date.now()<deadline){const {job}=await call("get_job",{jobId:pending});expect(["completed","failed","cancelled"],JSON.stringify(job)).not.toContain(job.status);
   const files=await readdir(path.join(root,"scratch"),{recursive:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;});if(files.some(file=>file.endsWith(".tmp.mp4"))){opened=true;break;}await new Promise(r=>setTimeout(r,25));}
  expect(opened,"A real FFmpeg output must be open before cancellation").toBe(true);
  const cancelled=await call("cancel_job",{jobId:pending});expect(cancelled.job.status).toBe("cancelled");pending=undefined;
  expect(await readFile(output,"utf8")).toBe("original destination");
  // Windows makes an unclosed encoder output observable as EBUSY on removal.
  await client.close();await rm(root,{recursive:true,force:true});
 }catch(error){failure=error;throw error;}
 finally{
  const cleanup:unknown[]=[];if(pending)try{await call("cancel_job",{jobId:pending});}catch(error){cleanup.push(error);}
  for(const close of [()=>client.close(),()=>rm(root,{recursive:true,force:true})])try{await close();}catch(error){cleanup.push(error);}
  if(cleanup.length&&failure===undefined)throw new AggregateError(cleanup,"Cancellation fixture cleanup failed");
 }
},90000);
