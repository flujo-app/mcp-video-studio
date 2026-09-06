import {mkdtemp,rm,writeFile} from "node:fs/promises";import os from "node:os";import path from "node:path";import {randomUUID} from "node:crypto";import {expect,it} from "vitest";
import {Client} from "@modelcontextprotocol/client";import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";import {secondsToTicks,type StudioProject} from "@mcp-video-studio/contracts";import {loadConfig,runChecked} from "@mcp-video-studio/media";
const integration=process.env.RUN_PROMO_INTEGRATION==="1"?it:it.skip;
integration("actual MCP constructs and repairs a full30s1080p promo with transitions, HTML, titles, captions and spoken VO/music, then delivers900 H264/AAC frames with QC PASS",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-full-promo-")),projectPath=path.join(root,"projects","promo"),config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root}),evidence:string[]=[];
 const env={...Object.fromEntries(Object.entries(process.env).filter((p):p is[string,string]=>typeof p[1]==="string")),VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"};
 const connect=async(name:string)=>{const client=new Client({name,version:"1"},{versionNegotiation:{mode:"auto"}});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.resolve(process.env.STUDIO_TEST_ENTRY??"dist/index.js"),"--stdio"],env,stderr:"pipe"}));return client;};
 let client:Client|undefined,peer:Client|undefined;
 async function call(name:string,args:Record<string,unknown>={},target=client!):Promise<Record<string,any>>{const result=await target.callTool({name,arguments:args});const data=result.structuredContent as Record<string,any>;expect(result.isError,JSON.stringify(data)).not.toBe(true);expect(data.success,JSON.stringify(data)).toBe(true);evidence.push(name);return data;}
 const project=async():Promise<StudioProject>=>(await call("get_project",{projectPath})).project;
 const edit=async(name:string,args:Record<string,unknown>)=>call(name,{projectPath,expectedRevision:(await project()).revision,...args});
 async function done(id:string){const deadline=Date.now()+15*60_000;for(;;){const {job}=await call("get_job",{jobId:id});if(job.status==="completed")return job.result;if(["failed","cancelled"].includes(job.status))throw new Error(JSON.stringify(job));if(Date.now()>deadline)throw new Error("Promo job exceeded15 minute deadline");await new Promise(resolve=>setTimeout(resolve,500));}}
 try{
  // Input-fixture preparation precedes the agent workflow. Once connected, every project
  // creation/edit/review/render action below goes through a public MCP tool.
  const motion=path.join(root,"motion.mp4"),music=path.join(root,"music.wav");
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","testsrc2=s=640x360:r=30:d=12","-an","-c:v","libx264","-preset","ultrafast","-threads","2","-pix_fmt","yuv420p",motion]);
  await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","aevalsrc=0.12*sin(2*PI*220*t)+0.07*sin(2*PI*330*t)+0.05*sin(2*PI*440*t):s=44100:d=30","-c:a","pcm_s16le",music]);
  client=await connect("full-promo-author");await call("create_project",{name:"Thirty second production acceptance",projectPath});
  for(const filePath of [motion,music,path.resolve("tests/fixtures/audio/voiceover.wav")])await edit("import_media",{filePath});
  let p=await project(),s=p.sequences[0]!,video=s.tracks.find(t=>t.type==="video")!,voice=s.tracks.find(t=>t.type==="audio")!,captions=s.tracks.find(t=>t.type==="caption")!;
  expect(p.settings).toMatchObject({raster:{width:1920,height:1080},fps:{numerator:30,denominator:1}});
  await edit("update_track",{sequenceId:s.id,trackId:voice.id,patch:{name:"Voiceover"}});
  await edit("add_track",{sequenceId:s.id,trackType:"audio",name:"Music"});await edit("add_track",{sequenceId:s.id,trackType:"video",name:"Titles and HTML"});
  p=await project();s=p.sequences[0]!;const musicTrack=s.tracks.find(t=>t.name==="Music")!,overlay=s.tracks.find(t=>t.name==="Titles and HTML")!,motionMedia=p.media.find(m=>m.name==="motion.mp4")!,musicMedia=p.media.find(m=>m.name==="music.wav")!,speech=p.media.find(m=>m.name==="voiceover.wav")!;
  for(let i=0;i<3;i++)await edit("add_clip",{sequenceId:s.id,trackId:video.id,name:"Motion scene "+(i+1),source:{type:"media",mediaId:motionMedia.id},startTick:secondsToTicks(i*10),durationTick:secondsToTicks(10)});
  p=await project();const sceneClips=p.sequences[0]!.clips.filter(c=>c.trackId===video.id).sort((a,b)=>a.startTick-b.startTick);
  for(const clip of sceneClips)await edit("update_clip",{sequenceId:s.id,clipId:clip.id,patch:{sourceInTick:secondsToTicks(.5)}});
  for(let i=0;i<2;i++)await edit("add_transition",{sequenceId:s.id,transition:{id:randomUUID(),sequenceId:s.id,fromClipId:sceneClips[i]!.id,toClipId:sceneClips[i+1]!.id,type:i?"wipeleft":"crossfade",durationTick:secondsToTicks(1),parameters:{}}});
  await edit("add_clip",{sequenceId:s.id,trackId:musicTrack.id,name:"Music bed",source:{type:"media",mediaId:musicMedia.id},startTick:0,durationTick:secondsToTicks(30)});
  const sampleTick=735,speechDuration=Math.floor(speech.probe.durationTick/sampleTick)*sampleTick;expect(speechDuration).toBeLessThan(secondsToTicks(9));
  for(const start of [1,11,21])await edit("add_clip",{sequenceId:s.id,trackId:voice.id,name:"Spoken VO "+start,source:{type:"media",mediaId:speech.id},startTick:secondsToTicks(start),durationTick:speechDuration});
  await edit("duck_audio_under_voice",{sequenceId:s.id,musicTrackId:musicTrack.id,voiceTrackIds:[voice.id],attenuationDb:-12,attackTick:secondsToTicks(.1),releaseTick:secondsToTicks(.3)});
  await edit("set_audio_master",{sequenceId:s.id,master:{gainDb:0,pan:0,effects:[{id:"delivery-loudness",type:"loudness",enabled:true,version:1,parameters:{}}]}});
  await edit("add_title",{sequenceId:s.id,trackId:overlay.id,text:"Built through MCP",startTick:secondsToTicks(.5),durationTick:secondsToTicks(2),fontSize:90,color:"#ffffff"});
  await edit("import_html_animation",{sequenceId:s.id,trackId:overlay.id,name:"Offline moving callout",startTick:secondsToTicks(12),durationTick:secondsToTicks(2),seed:19,html:'<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}#callout{position:absolute;top:220px;padding:24px;border:6px solid white;border-radius:20px;color:white;font:64px sans-serif;background:#20355bcc}</style></head><body><div id="callout">Editable offline animation</div><script>window.renderFrame=({time})=>{document.getElementById("callout").style.left=(300+80*Math.sin(time*3))+"px";};</script></body></html>'});
  for(let i=0;i<6;i++)await edit("add_caption",{sequenceId:s.id,trackId:captions.id,startTick:secondsToTicks(i*5),durationTick:secondsToTicks(5),text:["A complete thirty second production","Real motion and centered transitions","Reviewable offline HTML animation","Titles and captions stay editable","Voiceover and music share one final mix","Exported, decoded and checked"][i],style:{fontFamily:"Arial",fontSize:54,color:"#ffffff",background:"#000000aa",position:"bottom",align:"center"}});
  p=await project();const targetCaption=p.sequences[0]!.captions.at(-1)!;
  // A second genuine server process commits a concurrent review note. The stale author
  // must observe a conflict, reload and repair only its requested caption.
  peer=await connect("independent-promo-reviewer");const marker={id:"peer-review",tick:secondsToTicks(25),durationTick:0,label:"Preserve this independent review",color:"#55ccff"};
  await call("add_marker",{projectPath,expectedRevision:p.revision,sequenceId:s.id,marker},peer);
  const stale=await client.callTool({name:"update_caption",arguments:{projectPath,expectedRevision:p.revision,sequenceId:s.id,captionId:targetCaption.id,patch:{text:"Delivered with verified timing"}}});expect(stale.isError).toBe(true);expect(JSON.stringify(stale.structuredContent)).toContain("REVISION_CONFLICT");
  const beforeRepair=await project(),untouched=structuredClone(beforeRepair.sequences[0]!.clips);
  await edit("update_caption",{sequenceId:s.id,captionId:targetCaption.id,patch:{text:"Delivered with verified timing"}});
  p=await project();expect(p.sequences[0]!.clips).toEqual(untouched);expect(p.sequences[0]!.markers).toContainEqual(marker);expect(p.sequences[0]!.captions.at(-1)!.text).toBe("Delivered with verified timing");
  const layout=await call("inspect_caption_layout",{projectPath,sequenceId:s.id});expect(layout.complete).toBe(true);expect(layout.measurements.every((m:any)=>!m.overflow&&!m.outsideSafeArea)).toBe(true);
  await peer.close();peer=undefined;await client.close();client=await connect("reopened-promo-delivery");
  const reopened=await project();expect(reopened).toEqual(p);
  const output=path.join(root,"promo.mp4"),started=Date.now(),render=await done((await call("render_sequence",{projectPath,sequenceId:s.id,presetId:"web-h264-1080p",outputPath:output})).job.id);
  expect(render.frameCount).toBe(900);
  const qc=await done((await call("run_qc",{projectPath,sequenceId:s.id,filePath:output})).job.id);expect(qc.passed,JSON.stringify(qc.checks)).toBe(true);expect(qc.checks.filter((check:any)=>check.status!=="PASS"),JSON.stringify(qc.checks)).toEqual([]);
  // Decoder inspection is verification of the delivered artifact, not an editing action.
  const probe=JSON.parse((await runChecked(config.ffprobePath,["-v","error","-show_streams","-of","json",output])).stdout),v=probe.streams.find((stream:any)=>stream.codec_type==="video"),a=probe.streams.find((stream:any)=>stream.codec_type==="audio");
  expect(v).toMatchObject({codec_name:"h264",width:1920,height:1080,r_frame_rate:"30/1",nb_frames:"900"});expect(a).toMatchObject({codec_name:"aac",sample_rate:"48000",channels:2});
  const report={projectPath,revision:p.revision,output,elapsedMs:Date.now()-started,frames:900,video:v.codec_name,audio:a.codec_name,conflictRejected:true,reopened:true,tools:[...new Set(evidence)],checks:qc.checks};console.log("FULL_PROMO_ACCEPTANCE",JSON.stringify(report));
  if(process.env.PROMO_ACCEPTANCE_EVIDENCE)await writeFile(process.env.PROMO_ACCEPTANCE_EVIDENCE,JSON.stringify(report,null,2));
 }finally{await peer?.close();await client?.close();if(!process.env.PROMO_ACCEPTANCE_KEEP)await rm(root,{recursive:true,force:true});}
},20*60_000);
