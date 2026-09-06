import {it,expect} from "vitest";
import {loadConfig,runProcess} from "@mcp-video-studio/media";
import {encoderArguments,probeExportEncoder,selectExportEncoder,exportEncoderCapabilities} from "../packages/renderer/src/export-encoders.js";
it("validates encoder/codec choices and bounded numeric options",async()=>{
 expect(()=>encoderArguments("made-up")).toThrow();expect(()=>encoderArguments("libx264",{crf:100})).toThrow();expect(()=>encoderArguments("libx264",{videoBitrate:"6M -i bad"})).toThrow();
 await expect(selectExportEncoder("unneeded","libx265",{name:"h264_nvenc"})).rejects.toThrow(/match/);
 expect(encoderArguments("libx265",{crf:23})).toContain("pools=1:frame-threads=1");
 expect(encoderArguments("hevc_videotoolbox")).toContain("-allow_sw");
});
it.runIf(process.env.RUN_FFMPEG_INTEGRATION==="1")("checks compiled versus usable hardware with real FFmpeg and explicit software fallback",async()=>{
 const config=loadConfig(),capabilities=await exportEncoderCapabilities(config.ffmpegPath);
 expect(capabilities.find(entry=>entry.name==="libx264")?.usable).toBe(true);
 for(const name of ["libx265","gif","png"])expect((await probeExportEncoder(config.ffmpegPath,name)).usable,name).toBe(true);
 const unavailable=capabilities.find(entry=>entry.hardware&&entry.codec==="h264"&&!entry.usable);
 expect(unavailable).toBeDefined();
 await expect(selectExportEncoder(config.ffmpegPath,"libx264",{name:unavailable!.name})).rejects.toThrow(/test frame/);
 expect(await selectExportEncoder(config.ffmpegPath,"libx264",{name:unavailable!.name,allowSoftwareFallback:true})).toMatchObject({selected:"libx264",fallback:true,hardware:false});
 const realList=await runProcess(config.ffmpegPath,["-hide_banner","-encoders"]);
 for(const capability of capabilities.filter(entry=>entry.compiled))expect(realList.stdout).toContain(capability.name);
},180000);
