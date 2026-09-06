import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import {
  createDefaultProject,
  defaultClip,
  secondsToTicks,
  type MediaAsset,
} from "@mcp-video-studio/contracts";
import { rampPcmFile } from "../packages/media/src/ramp-pcm.js";
import { retimePlan } from "../packages/media/src/retime-plan.js";
it.each([1, 2, 6])(
  "bounded sinc preserves %s-channel DC and exact length across extreme increasing/decreasing ramps",
  async (channels) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-sinc-"));
    try {
      for (const [startRate, endRate] of [
        [0.25, 4],
        [4, 0.25],
      ]) {
        const project = createDefaultProject("PCM"),
          clip = defaultClip(
            "a",
            { type: "media", mediaId: "m" },
            "PCM",
            secondsToTicks(0.2),
          ),
          media = { probe: { durationTick: secondsToTicks(10) } } as MediaAsset,
          plan = retimePlan(project, clip, media, {
            mode: "linear-ramp",
            startRate: startRate!,
            endRate: endRate!,
          });
        const input = Buffer.alloc(
          Math.round(plan.sourceDuration * 48000) * channels * 4,
        );
        for (let i = 0; i < input.length / 4; i++)
          input.writeFloatLE(0.1 * ((i % channels) + 1), i * 4);
        const source = path.join(root, "in.f32"),
          target = path.join(root, startRate + ".f32");
        await writeFile(source, input);
        await rampPcmFile(source, target, channels, 48000, plan);
        const output = await readFile(target);
        expect(output.length).toBe(plan.sampleCount * channels * 4);
        for (let i = 0; i < output.length / 4; i++)
          expect(output.readFloatLE(i * 4)).toBeCloseTo(
            0.1 * ((i % channels) + 1),
            6,
          );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it("suppresses above-Nyquist input energy when ramp speed reaches four times", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-sinc-alias-"));
  try {
    const project = createDefaultProject("PCM"),
      clip = defaultClip(
        "a",
        { type: "media", mediaId: "m" },
        "PCM",
        secondsToTicks(0.25),
      ),
      media = { probe: { durationTick: secondsToTicks(10) } } as MediaAsset,
      plan = retimePlan(project, clip, media, {
        mode: "linear-ramp",
        startRate: 4,
        endRate: 4,
      }),
      input = Buffer.alloc(48000 * 4);
    for (let i = 0; i < 48000; i++)
      input.writeFloatLE(
        0.5 * Math.sin((2 * Math.PI * 18000 * i) / 48000),
        i * 4,
      );
    const source = path.join(root, "in.f32"),
      target = path.join(root, "out.f32");
    await writeFile(source, input);
    await rampPcmFile(source, target, 1, 48000, plan);
    const output = await readFile(target);
    let energy = 0,
      count = 0;
    for (let i = 100; i < plan.sampleCount - 100; i++) {
      energy += output.readFloatLE(i * 4) ** 2;
      count++;
    }
    expect(Math.sqrt(energy / count)).toBeLessThan(0.0005);
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      rampPcmFile(
        source,
        path.join(root, "cancelled.f32"),
        1,
        48000,
        plan,
        stopped.signal,
      ),
    ).rejects.toThrow();
    await expect(access(path.join(root, "cancelled.f32"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
