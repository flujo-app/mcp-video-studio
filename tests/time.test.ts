import { describe, expect, it } from "vitest";
import { TICKS_PER_SECOND, framesToTicks, rational, samplesToTicks, secondsToTicks, ticksPerFrame, ticksPerSample, ticksToFrames } from "@mcp-video-studio/contracts";

describe("exact timeline timebase", () => {
  it("represents common video and audio grids as integer ticks", () => {
    expect(TICKS_PER_SECOND).toBe(35_280_000);
    expect(ticksPerFrame(rational(30_000, 1_001))).toBe(1_177_176);
    expect(ticksPerFrame(rational(24, 1))).toBe(1_470_000);
    expect(ticksPerSample(48_000)).toBe(735);
    expect(ticksPerSample(44_100)).toBe(800);
  });

  it("round-trips frames and samples without floating point drift", () => {
    const fps = rational(30_000, 1_001);
    expect(ticksToFrames(framesToTicks(107_892, fps), fps)).toBe(107_892);
    expect(samplesToTicks(48_000 * 60, 48_000)).toBe(secondsToTicks(60));
  });
});
