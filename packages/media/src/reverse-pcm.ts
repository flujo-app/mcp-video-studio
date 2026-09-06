import { open, stat } from "node:fs/promises";
import { StudioException } from "@mcp-video-studio/core";
/** Reverse interleaved float32 sample frames with at most two 1 MiB buffers. */
export async function reversePcmFile(
  source: string,
  target: string,
  channels: number,
  signal?: AbortSignal,
): Promise<number> {
  if (!Number.isInteger(channels) || channels < 1 || channels > 8)
    throw new RangeError("Invalid PCM channel count.");
  const bytes = (await stat(source)).size,
    unit = channels * 4;
  if (bytes % unit)
    throw new StudioException(
      "INVALID_PCM",
      "Raw PCM length is not aligned to its channel count.",
      "runtime",
    );
  const input = await open(source, "r"),
    output = await open(target, "wx").catch(async (error) => {
      await input.close();
      throw error;
    }),
    chunk = Math.floor((1024 * 1024) / unit) * unit;
  try {
    for (let end = bytes; end > 0; ) {
      signal?.throwIfAborted();
      const start = Math.max(0, end - chunk),
        length = end - start,
        raw = Buffer.allocUnsafe(length),
        reversed = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const result = await input.read(
          raw,
          offset,
          length - offset,
          start + offset,
        );
        if (!result.bytesRead)
          throw new StudioException(
            "INVALID_PCM",
            "PCM input ended before its recorded length.",
            "runtime",
          );
        offset += result.bytesRead;
      }
      for (let frame = 0; frame < length / unit; frame++)
        raw.copy(
          reversed,
          frame * unit,
          length - (frame + 1) * unit,
          length - frame * unit,
        );
      offset = 0;
      while (offset < length) {
        const result = await output.write(reversed, offset, length - offset);
        if (!result.bytesWritten)
          throw new Error("PCM output did not advance.");
        offset += result.bytesWritten;
      }
      end = start;
    }
    await output.sync();
    return bytes / unit;
  } finally {
    await input.close();
    await output.close();
  }
}
