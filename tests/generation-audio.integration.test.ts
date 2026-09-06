import { expect, it } from "vitest";
import { stat } from "node:fs/promises";
import path from "node:path";
import { secondsToTicks } from "@mcp-video-studio/contracts";
import { generationFixture } from "./generation-fixture.js";
import {
  fitGeneratedAudio,
  withCaptionRegion,
} from "../packages/server/src/generation-files.js";
import { GenerationProviders } from "../packages/server/src/generation.js";
const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
function pcmData(wav: Uint8Array) {
  const data = Buffer.from(wav);
  expect(data.toString("ascii", 0, 4)).toBe("RIFF");
  for (let offset = 12; offset + 8 < data.length;) {
    const name = data.toString("ascii", offset, offset + 4),
      size = data.readUInt32LE(offset + 4);
    if (name === "data") return data.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("Missing WAV PCM data");
}
integration(
  "raw signed PCM and telephony audio decode with explicit format and sample rate, then pad or trim to a bounded stereo slot",
  async () => {
    const f = await generationFixture();
    try {
      const signal = new AbortController().signal,
        raw = Buffer.alloc(24000 * 2);
      for (let i = 0; i < 24000; i++)
        raw.writeInt16LE(
          Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24000)),
          i * 2,
        );
      const padded = pcmData(
        await fitGeneratedAudio(
          raw,
          "wav",
          secondsToTicks(2),
          f.config,
          signal,
          { encoding: "s16le", sampleRate: 24000 },
        ),
      );
      expect(padded.byteLength).toBe(48000 * 2 * 2 * 2);
      expect(padded.subarray(0, 48000 * 4).some((v) => v !== 0)).toBe(true);
      expect(padded.subarray(49000 * 4).every((v) => v === 0)).toBe(true);
      const trimmed = pcmData(
        await fitGeneratedAudio(
          raw,
          "wav",
          secondsToTicks(0.25),
          f.config,
          signal,
          { encoding: "s16le", sampleRate: 24000 },
        ),
      );
      expect(trimmed.byteLength).toBe(48000);
      for (const encoding of ["mulaw", "alaw"] as const) {
        const bytes = Buffer.alloc(8000, encoding === "mulaw" ? 255 : 213);
        expect(
          pcmData(
            await fitGeneratedAudio(
              bytes,
              "mp3",
              secondsToTicks(0.5),
              f.config,
              signal,
              { encoding, sampleRate: 8000 },
            ),
          ).byteLength,
        ).toBe(96000);
      }
      await expect(
        fitGeneratedAudio(
          Buffer.alloc(3),
          "wav",
          secondsToTicks(1),
          f.config,
          signal,
          { encoding: "s16le", sampleRate: 24000 },
        ),
      ).rejects.toThrow("alignment");
    } finally {
      await f.close();
    }
  },
  60000,
);
integration(
  "provider raw formats carry decoding metadata and unsupported voice settings or formats fail before an HTTP call",
  async () => {
    const f = await generationFixture();
    try {
      const providers = new GenerationProviders(f.config);
      for (const [provider, format, rawAudio] of [
        ["openai", "pcm", { encoding: "s16le", sampleRate: 24000 }],
        ["elevenlabs", "pcm_16000", { encoding: "s16le", sampleRate: 16000 }],
        ["elevenlabs", "ulaw_8000", { encoding: "mulaw", sampleRate: 8000 }],
        ["elevenlabs", "alaw_8000", { encoding: "alaw", sampleRate: 8000 }],
      ] as const) {
        const result = await providers.synthesizeSpeech({
          provider,
          text: "Fixture.",
          outputFormat: format,
        });
        expect(result.rawAudio).toEqual(rawAudio);
      }
      const count = f.calls.length;
      for (const request of [
        { provider: "openai", text: "x", outputFormat: "unknown" },
        {
          provider: "openai",
          text: "x",
          model: "tts-1",
          parameters: { instructions: "Whisper" },
        },
        {
          provider: "elevenlabs",
          text: "x",
          parameters: { voice_settings: { speed: 5 } },
        },
        {
          provider: "elevenlabs",
          text: "x",
          parameters: { voice_settings: { unsupported: true } },
        },
      ])
        await expect(providers.synthesizeSpeech(request)).rejects.toThrow();
      expect(f.calls).toHaveLength(count);
    } finally {
      await f.close();
    }
  },
  60000,
);
integration(
  "caption temporary audio is removed when consumption fails or is cancelled",
  async () => {
    const f = await generationFixture();
    try {
      for (const cancel of [false, true]) {
        const controller = new AbortController();
        let extracted = "";
        await expect(
          withCaptionRegion(
            path.join(f.root, "source.wav"),
            secondsToTicks(1),
            secondsToTicks(0.5),
            f.config,
            controller.signal,
            async (file) => {
              extracted = file;
              expect((await stat(file)).size).toBeGreaterThan(16000);
              if (cancel) {
                controller.abort();
                controller.signal.throwIfAborted();
              }
              throw new Error("Fixture provider failure");
            },
          ),
        ).rejects.toThrow();
        expect(extracted).not.toBe("");
        await expect(stat(path.dirname(extracted))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      const controller = new AbortController();
      controller.abort();
      await expect(
        fitGeneratedAudio(
          Buffer.alloc(200),
          "wav",
          secondsToTicks(1),
          f.config,
          controller.signal,
          { encoding: "s16le", sampleRate: 24000 },
        ),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
  60000,
);
