import {mkdtemp,readFile,rm} from "node:fs/promises";import os from "node:os";import path from "node:path";
import {it,expect} from "vitest";import {chromium} from "patchright";import {Client} from "@modelcontextprotocol/client";import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {secondsToTicks,type StudioProject} from "@mcp-video-studio/contracts";import {browserEnvironment} from "../packages/animation/src/sandbox.js";import {storedZipEntries} from "./export-fixture.js";
const integration=process.env.RUN_BROWSER_INTEGRATION==="1"&&process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("actual bundled stdio MCP and browser export PNG/GIF ranges and replay saved settings",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-export-browser-")),projectPath=path.join(root,"project");
 const client=new Client({name:"export-browser-acceptance",version:"1"},{versionNegotiation:{mode:"auto"}}),transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(process.env.STUDIO_TEST_ENTRY??"dist/index.js"),"--stdio"],env:{...Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>typeof p[1]==="string")),VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"},stderr:"pipe"});
 const browser=await chromium.launch({headless:true,env:browserEnvironment()});
 async function call(name:string,args:Record<string,unknown>={}):Promise<Record<string,any>>{const result=await client.callTool({name,arguments:args}),data=result.structuredContent as Record<string,any>;expect(result.isError,JSON.stringify(data)).not.toBe(true);return data;}
 async function done(id:string){const deadline=Date.now()+90000;while(Date.now()<deadline){const {job}=await call("get_job",{jobId:id});if(job.status==="completed")return job.result;if(["failed","cancelled"].includes(job.status))throw new Error(JSON.stringify(job));await new Promise(r=>setTimeout(r,100));}throw new Error("Export browser job deadline");}
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
  const replay=path.join(root,"replayed.zip");await page.getByLabel("Reproduced output path",{exact:true}).fill(replay);await page.getByRole("button",{name:"Reproduce saved export",exact:true}).click();await page.getByText("Saved revision reproduced: "+replay,{exact:true}).waitFor({timeout:90000});expect(await readFile(replay)).toEqual(await readFile(output));
  await page.getByLabel("Export preset",{exact:true}).selectOption("animated-gif");await page.getByLabel("Export selected range",{exact:true}).check();await page.getByLabel("Export range start",{exact:true}).fill("30");await page.getByLabel("Export range end",{exact:true}).fill("45");
  const gif=path.join(root,"range.gif");await page.getByLabel("Export output path",{exact:true}).fill(gif);const gifResponse=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/render"&&response.status()===202);await page.getByRole("button",{name:"Queue render",exact:true}).click();const gifQueued=await (await gifResponse).json(),gifResult=await done(gifQueued.job.id);expect(gifResult.probe.hasAudio).toBe(false);expect(gifResult.frameCount).toBe(15);expect((await readFile(gif)).subarray(0,6).toString()).toBe("GIF89a");
  const hevc=await call("render_sequence",{projectPath,sequenceId:sequence.id,presetId:"web-hevc",outputPath:path.join(root,"range-hevc.mp4"),range:{startTick:secondsToTicks(1),endTick:secondsToTicks(1.5)}});expect((await done(hevc.job.id)).probe.videoCodec).toBe("hevc");
  expect((await call("get_project",{projectPath})).project).toEqual(project);expect(errors).toEqual([]);
 }finally{await browser.close();await client.close();await rm(root,{recursive:true,force:true});}
},180000);
