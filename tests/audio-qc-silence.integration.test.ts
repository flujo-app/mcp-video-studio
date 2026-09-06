import {mkdtemp,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";
import {expect,it} from "vitest";import {defaultClip,secondsToTicks} from "@mcp-video-studio/contracts";
import {ProjectStore} from "@mcp-video-studio/core";import {loadConfig,runChecked} from "@mcp-video-studio/media";
import {runQc} from "../packages/renderer/src/qc.js";
const integration=process.env.RUN_FFMPEG_INTEGRATION==="1"?it:it.skip;
integration("silent audio exposes null loudness/peak values and review warnings instead of non-finite JSON measurements",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"audio-silence-qc-"));
 try{const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root}),store=await ProjectStore.create(path.join(root,"project"),"Silent review"),p=await store.read(),s=p.sequences[0]!;
 await store.mutate(0,[{type:"clip.add",sequenceId:s.id,clip:defaultClip(s.tracks[0]!.id,{type:"color",color:"#fff"},"Duration",secondsToTicks(1)),mode:"overwrite"}]);
 const file=path.join(root,"silence.wav");await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","anullsrc=r=48000:cl=stereo","-t","1",file]);
 const result=await runQc(store,s.id,file,config),checks=result.checks as Array<{id:string;status:string;observed:Record<string,unknown>}>;
 for(const id of ["audio.loudness","audio.true_peak"]){const check=checks.find(c=>c.id===id)!;expect(check.status).toBe("WARN");expect(check.observed.integratedLufs).toBeNull();expect(check.observed.truePeakDbtp).toBeNull();}
 }finally{await rm(root,{recursive:true,force:true});}
},30000);
