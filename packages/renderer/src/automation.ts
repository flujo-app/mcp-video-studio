import { ticksPerSample, type Clip, type Sequence, type StudioProject } from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";

/** Evaluate the additive dB envelope for every output sample, after resampling/time stretch. */
export function audioAutomationFilters(project: StudioProject, sequence: Sequence, clip: Clip): string[] {
  const targets = new Set([`clip:${clip.id}:gainDbOffset`, `track:${clip.trackId}:gainDbOffset`]);
  const lanes = sequence.automation.filter(lane => lane.enabled && targets.has(lane.target));
  if (!lanes.length) return [];
  const quantum = ticksPerSample(project.settings.sampleRate);
  const time = `(n+${clip.startTick / quantum})`;
  const expressions = lanes.map(lane => {
    const points = [...lane.points].sort((a, b) => a.tick - b.tick);
    if (!points.length) return "0";
    for (const point of points) {
      if (point.tick % quantum || !Number.isFinite(point.value) || point.value < -120 || point.value > 24 || !["hold", "linear"].includes(point.curve)) {
        throw new StudioException("UNSUPPORTED_AUTOMATION", "Audio gain automation requires sample-aligned hold/linear points between -120 and +24 dB.", "input");
      }
    }
    let expression = String(points.at(-1)!.value);
    for (let index = points.length - 2; index >= 0; index--) {
      const a = points[index]!, b = points[index + 1]!;
      if (b.tick <= a.tick) throw new StudioException("INVALID_AUTOMATION", "Automation points must have unique times.", "input");
      const segment = a.curve === "hold" ? String(a.value) : `(${a.value}+(${b.value - a.value})*(${time}-${a.tick / quantum})/${(b.tick - a.tick) / quantum})`;
      expression = `if(lt(${time},${b.tick / quantum}),${segment},${expression})`;
    }
    return `if(lt(${time},${points[0]!.tick / quantum}),0,${expression})`;
  });
  return [`aeval=exprs='val(ch)*pow(10,(${expressions.join("+")})/20)':c=same`];
}
