import {mkdtemp,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";import {chromium} from "patchright";
import {defaultClip,secondsToTicks,type ProjectCommand} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";import {createProxy,createThumbnail,importMedia,loadConfig,runChecked} from "@mcp-video-studio/media";import {renderSequence} from "@mcp-video-studio/renderer";
import {Client} from "@modelcontextprotocol/client";import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";import {browserEnvironment} from "../packages/animation/src/sandbox.js";
const integration=process.env.RUN_LONG_INTEGRATION==="1"?it:it.skip;
integration("30-minute mixed-media project stays responsive and one editor change reuses 179 of180 ranges",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-long-project-")),store=await ProjectStore.create(path.join(root,"projects","long"),"Long mixed-media");
 const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0",VIDEO_STUDIO_PROJECTS_DIR:path.join(root,"projects"),VIDEO_STUDIO_SCRATCH_DIR:path.join(root,"scratch")});
 let client:Client|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  await store.replace(0,p=>{p.settings.raster={width:160,height:90};},{sequences:[],tracks:[],clips:[],media:[],animations:[],generatedArtifacts:[]});
  const video=path.join(root,"source.mp4"),image=path.join(root,"still.png"),audio=path.join(root,"music.wav");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","testsrc2=s=160x90:r=30","-t","2","-c:v","libx264",video]);
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",video,"-frames:v","1",image]);
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","sine=frequency=220:sample_rate=48000:duration=1800","-c:a","pcm_s16le",audio],{timeoutMs:120000});
  const a=await importMedia(store,video,"managed",1,config),b=await importMedia(store,image,"managed",2,config),c=await importMedia(store,audio,"managed",3,config);
  await createProxy(store,a.asset.media,config);await createThumbnail(store,a.asset.media,config);await createThumbnail(store,b.asset.media,config);
  const project=await store.read(),sequence=project.sequences[0]!,track=sequence.tracks[0]!,audioTrack=sequence.tracks.find(t=>t.type==="audio")!;
  const commands:ProjectCommand[]=[];
  for(let index=0;index<900;index++){
   const source=index%3===0?{type:"media" as const,mediaId:a.asset.media.id}:index%3===1?{type:"color" as const,color:"#263b6a"}:{type:"media" as const,mediaId:b.asset.media.id};
   const clip={...defaultClip(track.id,source,"Long clip "+index,secondsToTicks(2)),startTick:secondsToTicks(index*2)};
   commands.push({type:"clip.add",sequenceId:sequence.id,clip,mode:"overwrite"});
  }
  commands.push({type:"clip.add",sequenceId:sequence.id,clip:defaultClip(audioTrack.id,{type:"media",mediaId:c.asset.media.id},"Music bed",secondsToTicks(1800)),mode:"overwrite"});
  await store.mutate(4,commands);
  const start=performance.now(),first=await renderSequence(store,config,{sequenceId:sequence.id,presetId:"web-h264-1080p",outputPath:path.join(root,"first.mp4")});
  const initialRenderMs=performance.now()-start;
  expect(first.frameCount).toBe(54000);expect((first.videoRanges as unknown[]).length).toBe(180);
  console.log(JSON.stringify({stage:"initial-render-complete",initialRenderMs,frames:first.frameCount}));
  client=new Client({name:"long-project-browser",version:"1"},{versionNegotiation:{mode:"auto"}});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(process.env.STUDIO_TEST_ENTRY??"dist/index.js"),"--stdio"],env:{...Object.fromEntries(Object.entries(process.env).filter((item):item is [string,string]=>typeof item[1]==="string")),VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0",VIDEO_STUDIO_PROJECTS_DIR:path.join(root,"projects")},stderr:"pipe"});
  await client.connect(transport);const opened=await client.callTool({name:"open_studio",arguments:{}}),studioUrl=new URL((opened.structuredContent as {studioUrl:string}).studioUrl);studioUrl.searchParams.set("projectPath",store.root);
  browser=await chromium.launch({headless:true,env:browserEnvironment()});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000);
  const load=performance.now();await page.goto(studioUrl.toString());await page.getByText("Project loaded",{exact:true}).waitFor();const loadMs=performance.now()-load;
  expect(loadMs).toBeLessThan(10000);expect(await page.locator(".timeline-clip").count()).toBeLessThan(60);
  const scroll=performance.now();await page.locator(".timeline-scroll").evaluate(element=>{element.scrollLeft=element.scrollWidth-element.clientWidth;});
  await page.getByRole("group",{name:"Long clip 899",exact:true}).waitFor();const scrollMs=performance.now()-scroll;expect(scrollMs).toBeLessThan(5000);
  await page.getByRole("group",{name:"Long clip 899",exact:true}).press("Enter");await page.getByLabel("Opacity",{exact:true}).press("ArrowLeft");await page.getByText("Saved revision 6",{exact:true}).waitFor();
  const edit=performance.now(),second=await renderSequence(store,config,{sequenceId:sequence.id,presetId:"web-h264-1080p",outputPath:path.join(root,"second.mp4")});
  const ranges=second.videoRanges as Array<{cacheHit:boolean}>;expect(ranges.filter(range=>range.cacheHit).length).toBe(179);expect(ranges.at(-1)?.cacheHit).toBe(false);expect(second.audioCache).toMatchObject({cacheHit:true});
  console.log(JSON.stringify({durationSeconds:1800,frames:54000,clips:901,videoRanges:180,reusedRanges:179,audioMixReused:true,loadMs,scrollMs,initialRenderMs,editedRenderMs:performance.now()-edit}));
 }finally{await browser?.close();await client?.close();await rm(root,{recursive:true,force:true});}
},600000);
