import { describe, expect, it } from "vitest";
import { atempoChain, audioEffectFilters, videoEffectFilters } from "@mcp-video-studio/renderer";

describe("render filter compilation", () => {
  it("decomposes arbitrary playback rates into legal atempo stages", () => {
    expect(atempoChain(4.5)).toEqual(["atempo=2", "atempo=2", "atempo=1.12500000"]);
    expect(atempoChain(0.125)).toEqual(["atempo=0.5", "atempo=0.5", "atempo=0.5"]);
  });

  it("emits allowlisted video and audio filters", () => {
    expect(videoEffectFilters([{ id: "blur", type: "blur", enabled: true, version: 1, parameters: { radius: 6 } }])).toEqual(["gblur=sigma=6"]);
    expect(audioEffectFilters([{ id: "hp", type: "highpass", enabled: true, version: 1, parameters: { frequency: 90 } }])).toEqual(["highpass=f=90"]);
  });
});
