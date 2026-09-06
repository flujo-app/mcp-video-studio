import {describe,it,expect} from "vitest";
import {ticksPerFrame,ticksPerSample,TICKS_PER_SECOND} from "@mcp-video-studio/contracts";
import {resolveExportRange,exportRangeFilters} from "../packages/renderer/src/export-range.js";
const settings={fps:{numerator:30,denominator:1},raster:{width:640,height:360},sampleRate:48000,channels:2 as const,colorSpace:"rec709" as const,background:"#000000"};
describe("final program export range",()=>{
 it("resolves half-open frame/sample trims while preserving upstream DSP history",()=>{
  const range=resolveExportRange(settings,5*TICKS_PER_SECOND,false,{startTick:TICKS_PER_SECOND,endTick:3*TICKS_PER_SECOND});
  expect(range).toMatchObject({startFrame:30,endFrame:90,frameCount:60,startSample:48000,endSample:144000,sampleCount:96000,durationSeconds:2});
  expect(exportRangeFilters(range)).toEqual({video:"trim=start_frame=30:end_frame=90,setpts=PTS-STARTPTS",audio:"atrim=start_sample=48000:end_sample=144000,asetpts=N/SR/TB"});
 });
 it("requires exact frame or sample boundaries and rejects outside or empty ranges",()=>{
  for(const range of [{startTick:0,endTick:0},{startTick:-1,endTick:TICKS_PER_SECOND},{startTick:1,endTick:TICKS_PER_SECOND},{startTick:0,endTick:6*TICKS_PER_SECOND}])expect(()=>resolveExportRange(settings,5*TICKS_PER_SECOND,false,range)).toThrow();
  const sample=ticksPerSample(48000);expect(resolveExportRange(settings,TICKS_PER_SECOND,true,{startTick:sample,endTick:3*sample}).sampleCount).toBe(2);
  expect(()=>resolveExportRange(settings,TICKS_PER_SECOND,true,{startTick:1,endTick:3*sample})).toThrow();
 });
 it("rounds NTSC frame boundaries to the nearest audio sample without moving video frames",()=>{
  const ntsc={...settings,fps:{numerator:30000,denominator:1001}},frame=ticksPerFrame(ntsc.fps),range=resolveExportRange(ntsc,300*frame,false,{startTick:frame,endTick:3*frame});
  expect(range.frameCount).toBe(2);expect(range.startSample).toBe(1602);expect(range.endSample).toBe(4805);
 });
});
