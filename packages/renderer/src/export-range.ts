import { ticksPerFrame, ticksPerSample, ticksToSeconds, type ProjectSettings } from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";

export interface ExportRange { startTick:number;endTick:number }
export interface ResolvedExportRange extends ExportRange {
  startFrame:number;endFrame:number;frameCount:number;startSample:number;endSample:number;sampleCount:number;durationSeconds:number;
}
/** Trim the completed program, so stateful effects still see all preceding samples. */
export function resolveExportRange(settings:ProjectSettings,totalDurationTick:number,audioOnly:boolean,requested?:ExportRange):ResolvedExportRange {
  const frameTick=ticksPerFrame(settings.fps),sampleTick=ticksPerSample(settings.sampleRate);
  const fullEnd=audioOnly?Math.ceil(totalDurationTick/sampleTick)*sampleTick:Math.ceil(totalDurationTick/frameTick)*frameTick;
  const {startTick,endTick}=requested??{startTick:0,endTick:fullEnd};
  if(!Number.isSafeInteger(startTick)||!Number.isSafeInteger(endTick)||startTick<0||endTick<=startTick||endTick>fullEnd)
    throw new StudioException("INVALID_EXPORT_RANGE","Export range must be a non-empty half-open interval inside the sequence.","input",{startTick,endTick,maximumEndTick:fullEnd});
  const grid=audioOnly?sampleTick:frameTick;
  if(startTick%grid!==0||endTick%grid!==0)
    throw new StudioException("INVALID_EXPORT_RANGE",audioOnly?"WAV range boundaries must align to audio samples.":"Video range boundaries must align to sequence frames.","input",{ticksPerUnit:grid});
  const startSample=Math.round(startTick/sampleTick),endSample=Math.round(endTick/sampleTick);
  return {startTick,endTick,startFrame:Math.round(startTick/frameTick),endFrame:Math.round(endTick/frameTick),frameCount:Math.round((endTick-startTick)/frameTick),startSample,endSample,sampleCount:endSample-startSample,durationSeconds:ticksToSeconds(endTick-startTick)};
}
export function exportRangeFilters(range:ResolvedExportRange):{video:string;audio:string} {
  return {video:`trim=start_frame=${range.startFrame}:end_frame=${range.endFrame},setpts=PTS-STARTPTS`,audio:`atrim=start_sample=${range.startSample}:end_sample=${range.endSample},asetpts=N/SR/TB`};
}
