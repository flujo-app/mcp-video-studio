import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runChecked, type StudioConfig } from "@mcp-video-studio/media";
import { ticksToSeconds } from "@mcp-video-studio/contracts";
/** Owned temporary files are never kept in a project/history and are removed on failure. */
export async function withCaptionRegion<T>(
  source: string,
  startTick: number,
  durationTick: number,
  config: StudioConfig,
  signal: AbortSignal,
  consume: (file: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-caption-region-"));
  try {
    const output = path.join(dir, "region.wav");
    await runChecked(
      config.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-ss",
        String(ticksToSeconds(startTick)),
        "-i",
        source,
        "-t",
        String(ticksToSeconds(durationTick)),
        "-map",
        "0:a:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        "-y",
        output,
      ],
      { signal, timeoutMs: 120000, maxOutputChars: 8000 },
    );
    if ((await stat(output)).size > 25_000_000)
      throw new Error("Extracted caption region exceeds25MB");
    signal.throwIfAborted();
    return await consume(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function fitGeneratedAudio(
  data: Uint8Array,
  extension: string,
  durationTick: number,
  config: StudioConfig,
  signal: AbortSignal,
  rawAudio?: { encoding: "s16le" | "mulaw" | "alaw"; sampleRate: number },
): Promise<Uint8Array> {
  if (
    rawAudio &&
    (!["s16le", "mulaw", "alaw"].includes(rawAudio.encoding) ||
      ![8000, 16000, 22050, 24000, 32000, 44100, 48000].includes(
        rawAudio.sampleRate,
      ) ||
      data.byteLength === 0 ||
      (rawAudio.encoding === "s16le" && data.byteLength % 2 !== 0))
  )
    throw new Error("Invalid raw provider audio encoding or sample alignment");
  const dir = await mkdtemp(path.join(os.tmpdir(), "video-generated-audio-"));
  try {
    const input = path.join(dir, "provider." + extension),
      output = path.join(dir, "slot.wav");
    await writeFile(input, data);
    const seconds = String(ticksToSeconds(durationTick));
    await runChecked(
      config.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "wav,mp3,ogg,flac,aac,s16le,mulaw,alaw",
        ...(rawAudio
          ? [
              "-f",
              rawAudio.encoding,
              "-ar",
              String(rawAudio.sampleRate),
              "-ac",
              "1",
            ]
          : []),
        "-i",
        input,
        "-map",
        "0:a:0",
        "-vn",
        "-map_metadata",
        "-1",
        "-map_chapters",
        "-1",
        "-af",
        `apad=whole_dur=${seconds},atrim=duration=${seconds},asetpts=N/SR/TB`,
        "-ar",
        "48000",
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        "-y",
        output,
      ],
      { signal, timeoutMs: 120000, maxOutputChars: 8000 },
    );
    signal.throwIfAborted();
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
