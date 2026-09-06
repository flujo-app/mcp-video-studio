import { open, stat } from "node:fs/promises";
import { StudioException } from "@mcp-video-studio/core";
import { rampSourceAt, type RetimePlan } from "./retime-plan.js";
/** Pitch follows speed. A Blackman-windowed sinc uses the same source-time map as video. */
export async function rampPcmFile(
  source: string,
  target: string,
  channels: number,
  sampleRate: number,
  plan: RetimePlan,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  if (!Number.isInteger(channels) || channels < 1 || channels > 8)
    throw new StudioException(
      "INVALID_PCM",
      "Use one to eight interleaved channels.",
      "input",
    );
  const unit = channels * 4,
    bytes = (await stat(source)).size,
    total = bytes / unit;
  if (!Number.isSafeInteger(total) || total < 1)
    throw new StudioException(
      "INVALID_PCM",
      "Ramp input must contain complete PCM sample frames.",
      "runtime",
    );
  const input = await open(source, "r"),
    output = await open(target, "wx").catch(async (error) => {
      await input.close();
      throw error;
    }),
    blockFrames = 4096;
  try {
    for (let base = 0; base < plan.sampleCount; base += blockFrames) {
      signal?.throwIfAborted();
      const count = Math.min(blockFrames, plan.sampleCount - base),
        maxRadius = Math.ceil(
          16 / Math.min(0.94, 0.94 / Math.max(plan.startRate, plan.endRate)),
        ),
        start = Math.max(
          0,
          Math.floor(rampSourceAt(plan, base / sampleRate) * sampleRate) -
            maxRadius,
        ),
        end = Math.min(
          total,
          Math.ceil(
            rampSourceAt(plan, (base + count - 1) / sampleRate) * sampleRate,
          ) +
            maxRadius +
            1,
        ),
        data = Buffer.allocUnsafe((end - start) * unit),
        result = Buffer.allocUnsafe(count * unit);
      let read = 0;
      while (read < data.length) {
        const part = await input.read(
          data,
          read,
          data.length - read,
          start * unit + read,
        );
        if (!part.bytesRead)
          throw new StudioException(
            "INVALID_PCM",
            "Ramp input ended early.",
            "runtime",
          );
        read += part.bytesRead;
      }
      for (let frame = 0; frame < count; frame++) {
        const time = (base + frame) / sampleRate,
          position = rampSourceAt(plan, time) * sampleRate,
          local = Math.max(0, Math.min(plan.clipDuration, time - plan.left)),
          speed =
            plan.startRate +
            ((plan.endRate - plan.startRate) * local) / plan.clipDuration,
          cutoff = Math.min(0.94, 0.94 / speed),
          radius = Math.ceil(16 / cutoff),
          center = Math.floor(position),
          sums = new Float64Array(channels);
        let weightSum = 0;
        for (
          let index = center - radius + 1;
          index <= center + radius;
          index++
        ) {
          const distance = position - index;
          if (Math.abs(distance) >= radius) continue;
          const phase = Math.PI * distance * cutoff,
            sinc = Math.abs(phase) < 1e-12 ? 1 : Math.sin(phase) / phase,
            window =
              0.42 +
              0.5 * Math.cos((Math.PI * distance) / radius) +
              0.08 * Math.cos((2 * Math.PI * distance) / radius),
            weight = cutoff * sinc * window,
            owned = Math.max(0, Math.min(total - 1, index));
          for (let channel = 0; channel < channels; channel++) {
            const value = data.readFloatLE(
              (owned - start) * unit + channel * 4,
            );
            if (!Number.isFinite(value))
              throw new StudioException(
                "INVALID_PCM",
                "Ramp input contains a non-finite sample.",
                "runtime",
              );
            sums[channel]! += weight * value;
          }
          weightSum += weight;
        }
        for (let channel = 0; channel < channels; channel++)
          result.writeFloatLE(
            sums[channel]! / weightSum,
            frame * unit + channel * 4,
          );
      }
      let written = 0;
      while (written < result.length) {
        const part = await output.write(
          result,
          written,
          result.length - written,
        );
        if (!part.bytesWritten) throw new Error("Ramp output did not advance.");
        written += part.bytesWritten;
      }
    }
    await output.sync();
    return plan.sampleCount;
  } finally {
    await input.close();
    await output.close();
  }
}
