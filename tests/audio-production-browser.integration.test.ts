import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";import {chromium} from "patchright";
import {Client} from "@modelcontextprotocol/client";import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
import {secondsToTicks,ticksPerSample,type StudioProject} from "@mcp-video-studio/contracts";
import {loadConfig,runChecked} from "@mcp-video-studio/media";import {browserEnvironment} from "../packages/animation/src/sandbox.js";
const integration=process.env.RUN_BROWSER_INTEGRATION==="1"&&process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("browser and actual stdio MCP produce, duck, mix, meter, review and export spoken voiceover with music",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-voice-music-ui-")),projectPath=path.join(root,"projects","production"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root});
 const client=new Client({name:"audio-production-acceptance",version:"1"},{versionNegotiation:{mode:"auto"}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(process.env.STUDIO_TEST_ENTRY??"dist/index.js"),"--stdio"],env:{...Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>typeof p[1]==="string")),VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"},stderr:"pipe"});
 const browser=await chromium.launch({headless:true,env:browserEnvironment()});
 const evidence:string[]=[];
 async function call(name:string,args:Record<string,unknown>={}):Promise<Record<string,any>>{
  const result=await client.callTool({name,arguments:args});const data=result.structuredContent as Record<string,any>;
  expect(result.isError,JSON.stringify(data)).not.toBe(true);expect(data.success,JSON.stringify(data)).toBe(true);evidence.push(name);return data;
 }
 async function project():Promise<StudioProject>{return (await call("get_project",{projectPath})).project;}
 async function edit(name:string,args:Record<string,unknown>){return call(name,{projectPath,expectedRevision:(await project()).revision,...args});}
 async function done(id:string){const deadline=Date.now()+90000;while(Date.now()<deadline){const {job}=await call("get_job",{jobId:id});if(job.status==="completed")return job.result;if(["failed","cancelled"].includes(job.status))throw new Error(JSON.stringify(job));await new Promise(r=>setTimeout(r,100));}throw new Error("Audio production job deadline");}
 try{
  const musicFile=path.join(root,"music.wav");await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","aevalsrc=0.12*sin(2*PI*220*t)+0.07*sin(2*PI*330*t)+0.05*sin(2*PI*440*t):s=44100:d=12","-c:a","pcm_s16le",musicFile]);
  await client.connect(transport);await call("create_project",{name:"Voiceover and music acceptance",projectPath});
  await edit("import_media",{filePath:path.resolve("tests/fixtures/audio/voiceover.wav")});await edit("import_media",{filePath:musicFile});
  let p=await project(),s=p.sequences[0]!,voice=s.tracks.find(t=>t.type==="audio")!;
  await edit("update_track",{sequenceId:s.id,trackId:voice.id,patch:{name:"Voiceover"}});
  await edit("add_track",{sequenceId:s.id,trackType:"audio",name:"Music"});
  p=await project();s=p.sequences[0]!;const music=s.tracks.find(t=>t.name==="Music")!,speech=p.media.find(m=>m.name==="voiceover.wav")!,musicMedia=p.media.find(m=>m.name==="music.wav")!,q=ticksPerSample(p.settings.sampleRate);
  await edit("add_clip",{sequenceId:s.id,trackId:s.tracks.find(t=>t.type==="video")!.id,name:"Review slate",startTick:0,durationTick:secondsToTicks(12),source:{type:"color",color:"#24365e"}});
  await edit("add_clip",{sequenceId:s.id,trackId:music.id,name:"Music bed",startTick:0,durationTick:secondsToTicks(12),source:{type:"media",mediaId:musicMedia.id}});
  const speechDuration=Math.floor(speech.probe.durationTick/q)*q;
  await edit("add_clip",{sequenceId:s.id,trackId:voice.id,name:"Spoken voiceover",startTick:secondsToTicks(1),durationTick:speechDuration,source:{type:"media",mediaId:speech.id}});
  p=await project();const speechClip=p.sequences[0]!.clips.find(c=>c.name==="Spoken voiceover")!,musicClip=p.sequences[0]!.clips.find(c=>c.name==="Music bed")!;
  await edit("set_audio_parameter_range",{sequenceId:s.id,targetType:"clip",targetId:musicClip.id,parameter:"pan",startTick:secondsToTicks(2),endTick:secondsToTicks(3),value:-.4});
  const opened=await call("open_studio"),url=new URL(opened.studioUrl);url.searchParams.set("projectPath",projectPath);
  const page=await browser.newPage({viewport:{width:1600,height:1100}});page.setDefaultTimeout(30000);const browserErrors:string[]=[];page.on("pageerror",error=>browserErrors.push(error.message));
  await page.goto(url.toString());await page.getByText("Project loaded",{exact:true}).waitFor();
  await page.getByRole("group",{name:"Spoken voiceover",exact:true}).click();
  await page.getByRole("button",{name:"Apply dialogue chain",exact:true}).click();
  await page.waitForFunction(()=>Boolean(document.querySelector('fieldset[aria-label^="Exact audio range"] select option[value$=":frequency"]')));
  let revision=(await project()).revision;
  const range=page.locator('fieldset[aria-label="Exact audio range '+speechClip.id+'"]');
  await range.getByRole("combobox").selectOption({label:"highpass frequency"});
  await range.getByLabel("Parameter range start seconds").fill("1.333");
  await range.getByLabel("Parameter range end seconds").fill("2.456");
  await range.getByLabel("Range parameter value").fill("150");
  await range.getByRole("button",{name:"Set parameter range",exact:true}).click();
  await page.getByText("Saved revision "+(revision+1),{exact:true}).waitFor();
  await page.getByText("Audio mixer and track processing",{exact:true}).click();
  await page.getByLabel("Ducking music track").selectOption(music.id);await page.getByLabel("Ducking voice track").selectOption(voice.id);
  revision=(await project()).revision;await page.getByRole("button",{name:"Duck music under voice",exact:true}).click();await page.getByText("Saved revision "+(revision+1),{exact:true}).waitFor();
  revision=(await project()).revision;await page.getByRole("button",{name:"Normalize final mix to -16 LUFS",exact:true}).click();await page.getByText("Saved revision "+(revision+1),{exact:true}).waitFor();
  const mixed=await project();expect(mixed.sequences[0]!.automation).toHaveLength(3);expect(mixed.sequences[0]!.audioMaster?.effects[0]!.type).toBe("loudness");
  await page.getByRole("button",{name:"Build preview",exact:true}).click();
  await page.getByRole("button",{name:"Enable audio meters",exact:true}).waitFor({timeout:90000});await page.getByRole("button",{name:"Enable audio meters",exact:true}).click();
  await page.getByRole("button",{name:"Play or pause",exact:true}).click();
  const playingSample=await page.waitForFunction(()=>{const dbfs=Number(document.querySelector('[data-audio-meter="left"]')?.getAttribute("data-db")??-90);return dbfs>-50?{dbfs}:false;});
  const measured=await playingSample.jsonValue();await playingSample.dispose();
  const meter=typeof measured==="object"?measured.dbfs:-90;expect(meter).toBeGreaterThan(-50);
  await page.getByRole("button",{name:"Play or pause",exact:true}).click();
  await page.getByRole("button",{name:"Export",exact:true}).click();await page.getByRole("button",{name:"Queue render",exact:true}).click();
  const qc=page.locator("section[aria-label='Quality control']");
  await page.waitForFunction(()=>Boolean((document.querySelector("section[aria-label='Quality control'] input") as HTMLInputElement)?.value),undefined,{timeout:90000});
  const output=await qc.locator("input").first().inputValue();
  await page.getByRole("button",{name:"Analyze export",exact:true}).click();
  await page.getByText("PASS audio.loudness",{exact:true}).waitFor({timeout:90000});
  await page.getByText("PASS audio.true_peak",{exact:true}).waitFor();
  const qcResult=await done((await call("run_qc",{projectPath,sequenceId:s.id,filePath:output})).job.id);
  expect(qcResult.checks.find((c:any)=>c.id==="audio.loudness").status).toBe("PASS");expect(qcResult.checks.find((c:any)=>c.id==="audio.true_peak").status).toBe("PASS");
  const wav=path.join(root,"mix.wav");await done((await call("render_sequence",{projectPath,sequenceId:s.id,presetId:"audio-wav",outputPath:wav})).job.id);
  expect((await readFile(wav)).byteLength).toBeGreaterThan(12*48000*2*2);
  expect(browserErrors).toEqual([]);
  if(process.env.AUDIO_ACCEPTANCE_EVIDENCE){await writeFile(process.env.AUDIO_ACCEPTANCE_EVIDENCE,JSON.stringify({projectPath,revision:(await project()).revision,meterDbfs:meter,output,wav,checks:qcResult.checks,tools:[...new Set(evidence)]},null,2));}
 }finally{await browser.close();await client.close();if(!process.env.AUDIO_ACCEPTANCE_KEEP)await rm(root,{recursive:true,force:true});}
},240000);
