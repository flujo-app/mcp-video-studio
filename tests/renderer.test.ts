import { describe, expect, it } from "vitest";
import { atempoChain, audioEffectFilters, videoEffectFilters } from "@mcp-video-studio/renderer";

describe("render filter compilation", () => {
  it("decomposes arbitrary playback rates into legal atempo stages", () => {
    expect(atempoChain(4.5)).toEqual(["atempo=2", "atempo=2", "atempo=1.12500000"]);
    expect(atempoChain(0.125)).toEqual(["atempo=0.5", "atempo=0.5", "atempo=0.5"]);
  });

  it("emits allowlisted video and audio filters", () => {
    expect(videoEffectFilters([{ id: "blur", type: "blur", enabled: true, version: 1, parameters: { radius: 6 } }]).join(",")).toContain("gblur=sigma=6");
    expect(audioEffectFilters([{ id: "hp", type: "highpass", enabled: true, version: 1, parameters: { frequency: 90 } }])).toEqual(["highpass=f=90"]);
  });
});

it("rejects filter injection, unknown effects, unbounded stacks and invalid numeric controls",()=>{
 const effect={id:"effect",type:"chromaKey",enabled:true,version:1,parameters:{color:"green;movie=/etc/passwd"}};
 expect(()=>videoEffectFilters([effect])).toThrow("filter expressions");
 expect(()=>videoEffectFilters([{...effect,type:"unknown"}])).toThrow("not supported");
 expect(()=>audioEffectFilters([{...effect,type:"equalizer",parameters:{bands:Array(33).fill({})}}])).toThrow("32 EQ");
 expect(()=>audioEffectFilters([{...effect,type:"highpass",parameters:{frequency:"100,amovie=/etc/passwd"}}])).toThrow("finite number");
 expect(()=>audioEffectFilters(Array(2).fill({...effect,type:"loudness",parameters:{}}))).toThrow("one loudness");
});
