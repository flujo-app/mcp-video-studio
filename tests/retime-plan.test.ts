import { expect, it } from "vitest";
import {
  createDefaultProject,
  defaultClip,
  secondsToTicks,
  type MediaAsset,
} from "@mcp-video-studio/contracts";
import {
  retimePlan,
  rampSourceAt,
  rampOutputAt,
} from "../packages/media/src/retime-plan.js";
it.each([
  [0.5, 1.5],
  [1.5, 0.5],
  [1, 1],
])(
  "maps linear ramp source and output clocks inversely (%s to %s)",
  (startRate, endRate) => {
    const project = createDefaultProject("Retime"),
      clip = defaultClip(
        "video",
        { type: "media", mediaId: "source" },
        "Clip",
        secondsToTicks(4),
      );
    clip.sourceInTick = secondsToTicks(2);
    const media = {
      probe: {
        durationTick: secondsToTicks(20),
        hasAudio: true,
        hasVideo: true,
      },
    } as MediaAsset;
    const plan = retimePlan(
      project,
      clip,
      media,
      { mode: "linear-ramp", startRate, endRate },
      { leftTick: secondsToTicks(0.5), rightTick: secondsToTicks(0.5) },
    );
    for (let sample = 0; sample <= 500; sample++) {
      const time = sample / 100;
      expect(rampOutputAt(plan, rampSourceAt(plan, time))).toBeCloseTo(
        time,
        10,
      );
    }
    expect(plan.duration).toBe(5);
    expect(plan.sourceDuration).toBe(4);
  },
);

it("holds the last valid source frame and rejects unavailable ramp handles", () => {
  const project = createDefaultProject("Last frame"),
    clip = defaultClip(
      "v",
      { type: "media", mediaId: "m" },
      "Last",
      secondsToTicks(4),
    );
  clip.sourceInTick = secondsToTicks(2);
  const media = {
    probe: {
      durationTick: secondsToTicks(6),
      frameRate: { numerator: 10, denominator: 1 },
    },
  } as MediaAsset;
  const freeze = retimePlan(project, clip, media, {
    mode: "freeze",
    freezeAtTick: secondsToTicks(3.999),
  });
  expect(freeze.sourceStart).toBeCloseTo(5.9, 10);
  expect(freeze.sourceEnd).toBe(6);
  expect(() =>
    retimePlan(project, clip, media, {
      mode: "linear-ramp",
      startRate: 1,
      endRate: 2,
    }),
  ).toThrow(/lacks/);
  expect(() =>
    retimePlan(
      project,
      clip,
      media,
      { mode: "reverse" },
      { leftTick: secondsToTicks(0.5), rightTick: 0 },
    ),
  ).toThrow(/lacks/);
});
