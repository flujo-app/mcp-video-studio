import {
  ticksToFrames,
  ticksToSeconds,
  ticksPerSample,
  type Clip,
  type MediaAsset,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";
export interface RetimeOptions {
  mode: "freeze" | "reverse" | "linear-ramp";
  freezeAtTick?: number;
  startRate?: number;
  endRate?: number;
}
export interface RetimePlan {
  mode: RetimeOptions["mode"];
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  clipDuration: number;
  left: number;
  right: number;
  startRate: number;
  endRate: number;
  frameCount: number;
  sampleCount: number;
  durationTick: number;
  sourceDuration: number;
}
export function retimePlan(
  project: StudioProject,
  clip: Clip,
  media: MediaAsset,
  options: RetimeOptions,
  handles = { leftTick: 0, rightTick: 0 },
): RetimePlan {
  const baseRate = clip.playbackRate.numerator / clip.playbackRate.denominator,
    duration = ticksToSeconds(clip.durationTick),
    left = ticksToSeconds(handles.leftTick),
    right = ticksToSeconds(handles.rightTick),
    total = duration + left + right;
  const fail = (message: string): never => {
    throw new StudioException("INVALID_RETIMING", message, "input");
  };
  if (!["freeze", "reverse", "linear-ramp"].includes(options.mode))
    fail("Choose freeze, reverse or linear-ramp.");
  if (!Number.isFinite(total) || total <= 0 || total > 120)
    fail("Retime at most two minutes per clip, including transition handles.");
  const startRate =
      options.mode === "linear-ramp"
        ? (options.startRate ?? baseRate * 0.5)
        : baseRate,
    endRate =
      options.mode === "linear-ramp"
        ? (options.endRate ?? baseRate * 1.5)
        : baseRate;
  if (
    ![startRate, endRate].every(
      (rate) => Number.isFinite(rate) && rate >= 0.25 && rate <= 4,
    )
  )
    fail("Retiming rates must be between 0.25 and 4.");
  const sourceIn = ticksToSeconds(clip.sourceInTick),
    sourceDuration = (duration * (startRate + endRate)) / 2;
  let sourceStart = sourceIn - left * startRate,
    sourceEnd = sourceIn + sourceDuration + right * endRate;
  if (options.mode === "reverse") {
    sourceStart = sourceIn - right * baseRate;
    sourceEnd = sourceIn + (duration + left) * baseRate;
  }
  if (options.mode === "freeze") {
    const offset = options.freezeAtTick ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= clip.durationTick
    )
      fail("Choose a freeze frame inside the selected clip.");
    const frame =
      (media.probe.frameRate?.denominator ?? project.settings.fps.denominator) /
      (media.probe.frameRate?.numerator ?? project.settings.fps.numerator);
    sourceStart =
      Math.floor(
        (sourceIn + ticksToSeconds(offset) * baseRate + 1e-9) / frame,
      ) * frame;
    sourceEnd = Math.min(
      sourceStart + frame,
      ticksToSeconds(media.probe.durationTick),
    );
  }
  if (
    sourceStart < -0.0000001 ||
    sourceEnd > ticksToSeconds(media.probe.durationTick) + 0.000001
  )
    fail(
      "The source lacks the frames or transition handles required by this retiming.",
    );
  const durationTick = clip.durationTick + handles.leftTick + handles.rightTick,
    frameCount = ticksToFrames(durationTick, project.settings.fps, "ceil"),
    sampleCount = Math.round(
      durationTick / ticksPerSample(project.settings.sampleRate),
    );
  if (frameCount > 7200)
    fail("Retiming is bounded to 7200 output frames per clip.");
  return {
    mode: options.mode,
    sourceStart: Math.max(0, sourceStart),
    sourceEnd,
    duration: total,
    clipDuration: duration,
    left,
    right,
    startRate,
    endRate,
    frameCount,
    sampleCount,
    durationTick,
    sourceDuration,
  };
}
export function rampSourceAt(plan: RetimePlan, time: number): number {
  if (time < plan.left) return time * plan.startRate;
  const local = time - plan.left;
  if (local <= plan.clipDuration)
    return (
      plan.left * plan.startRate +
      local * plan.startRate +
      ((plan.endRate - plan.startRate) * local * local) /
        (2 * plan.clipDuration)
    );
  return (
    plan.left * plan.startRate +
    plan.sourceDuration +
    (local - plan.clipDuration) * plan.endRate
  );
}
export function rampOutputAt(plan: RetimePlan, sourceTime: number): number {
  const first = plan.left * plan.startRate,
    last = first + plan.sourceDuration;
  if (sourceTime < first) return sourceTime / plan.startRate;
  if (sourceTime > last)
    return plan.left + plan.clipDuration + (sourceTime - last) / plan.endRate;
  const relative = sourceTime - first,
    acceleration = (plan.endRate - plan.startRate) / plan.clipDuration;
  return (
    plan.left +
    (Math.abs(acceleration) < 1e-12
      ? relative / plan.startRate
      : (2 * relative) /
        (Math.sqrt(
          Math.max(
            0,
            plan.startRate * plan.startRate + 2 * acceleration * relative,
          ),
        ) +
          plan.startRate))
  );
}
export function rampVideoExpression(plan: RetimePlan): string {
  const first = plan.left * plan.startRate,
    last = first + plan.sourceDuration,
    acceleration = (plan.endRate - plan.startRate) / plan.clipDuration,
    relative = "(T-" + first + ")",
    middle =
      Math.abs(acceleration) < 1e-12
        ? relative + "/" + plan.startRate
        : "2*" +
          relative +
          "/(sqrt(max(0," +
          plan.startRate * plan.startRate +
          "+2*" +
          acceleration +
          "*" +
          relative +
          "))+" +
          plan.startRate +
          ")";
  return (
    "if(lt(T," +
    first +
    "),T/" +
    plan.startRate +
    ",if(lt(T," +
    last +
    ")," +
    plan.left +
    "+" +
    middle +
    "," +
    (plan.left + plan.clipDuration) +
    "+(T-" +
    last +
    ")/" +
    plan.endRate +
    "))/TB"
  );
}
