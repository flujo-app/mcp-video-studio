import { describe, expect, it } from "vitest";
import { createDefaultProject, exportPresetsFor } from "@mcp-video-studio/contracts";
import { alphaDecoderArgs, streamHasAlpha } from "@mcp-video-studio/media";
import {
  backdropKeyGraph,
  backdropKeyOptionsFromEffect,
  colorHex,
  despillFilter,
  frameDifference,
  loopGraph,
  maxCornerAlpha,
  opaqueShare,
  parseColor,
  planLoop,
  resolveBackdropKey,
  resolveKeyMethod
} from "@mcp-video-studio/renderer";

function solidFrame(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const frame = new Uint8Array(width * height * 4);
  for (let index = 0; index < frame.length; index += 4) frame.set(rgba, index);
  return frame;
}

describe("backdrop keying", () => {
  it("parses colours and picks a key method for saturated and neutral backdrops", () => {
    expect(parseColor("#00b140")).toEqual([0, 177, 64]);
    expect(parseColor("0xFF00ff")).toEqual([255, 0, 255]);
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("green")).toEqual([0, 255, 0]);
    expect(() => parseColor("not a colour")).toThrow(/Unsupported colour/);
    expect(colorHex([0, 177, 64])).toBe("#00b140");
    expect(resolveKeyMethod([0, 177, 64])).toBe("chroma");
    expect(resolveKeyMethod([245, 245, 245])).toBe("color");
    expect(resolveKeyMethod([245, 245, 245], "chroma")).toBe("chroma");
  });

  it("removes spill only for channels the backdrop is strong in", () => {
    expect(despillFilter([0, 200, 0], 1)).toBe("geq=r='r(X,Y)':g='g(X,Y)-max(0,g(X,Y)-max(r(X,Y),b(X,Y)))*1':b='b(X,Y)':a='alpha(X,Y)'");
    expect(despillFilter([255, 0, 255], 0.5)).toBe("geq=r='r(X,Y)-max(0,min(r(X,Y),b(X,Y))-g(X,Y))*0.5':g='g(X,Y)':b='b(X,Y)-max(0,min(r(X,Y),b(X,Y))-g(X,Y))*0.5':a='alpha(X,Y)'");
    expect(despillFilter([245, 245, 245], 1)).toBeUndefined();
    expect(despillFilter([0, 200, 0], 0)).toBeUndefined();
  });

  it("keeps the source's own alpha by multiplying it with the keyed matte", () => {
    const graph = backdropKeyGraph("in", "out", resolveBackdropKey([0, 177, 64], { tolerance: 0.2 }), "k");
    expect(graph[0]).toBe("[in]format=rgba,split=2[ksrc][kown]");
    expect(graph[2]).toContain("chromakey=color=0x00b140:similarity=0.2:blend=0.08");
    expect(graph).toContain("[kkeyalpha][kownalpha]blend=all_mode=multiply[kalpha]");
    expect(graph.at(-1)).toMatch(/^\[kkeyed\]\[kalpha\]alphamerge,.*\[out\]$/);
    const white = backdropKeyGraph("in", "out", resolveBackdropKey([250, 250, 250]), "w");
    expect(white[2]).toContain("colorkey=color=0xfafafa");
    expect(white[2]).not.toContain("geq=");
  });

  it("reads backdropKey clip effects with defaults and clamps out-of-range values", () => {
    const options = backdropKeyOptionsFromEffect({ id: "e", type: "backdropKey", enabled: true, version: 1, parameters: { tolerance: 5 } });
    expect(options).toEqual({ color: "auto", method: "auto", tolerance: 5, softness: 0.08, despill: 1 });
    expect(resolveBackdropKey([0, 0, 255], options)).toEqual({ color: [0, 0, 255], method: "chroma", tolerance: 1, softness: 0.08, despill: 1 });
  });
});

describe("seamless loop planning", () => {
  const motion = { sourceFrames: 48, dropLastFrame: false, defaultCrossfadeFrames: 6, seamBefore: 0.06, typicalStep: 0.003 };

  it("cross-fades a visible jump and reports the exact length", () => {
    expect(planLoop({ ...motion, mode: "crossfade" })).toMatchObject({ loopInputFrames: 48, crossfadeFrames: 6, outputFrames: 42, warnings: [] });
    expect(planLoop({ ...motion, mode: "crossfade", crossfadeFrames: 10, dropLastFrame: true })).toMatchObject({ loopInputFrames: 47, crossfadeFrames: 10, outputFrames: 37 });
  });

  it("leaves an already seamless clip uncut unless a cross-fade is requested", () => {
    const smooth = { ...motion, seamBefore: 0.004 };
    expect(planLoop({ ...smooth, mode: "crossfade" })).toMatchObject({ crossfadeFrames: 0, outputFrames: 48 });
    expect(planLoop({ ...smooth, mode: "crossfade", crossfadeFrames: 4 })).toMatchObject({ crossfadeFrames: 4, outputFrames: 44 });
  });

  it("plans ping-pong and plain loops and shortens cross-fades that do not fit", () => {
    expect(planLoop({ ...motion, mode: "pingpong" })).toMatchObject({ outputFrames: 94 });
    expect(planLoop({ ...motion, mode: "none", dropLastFrame: true })).toMatchObject({ outputFrames: 47 });
    const short = planLoop({ ...motion, sourceFrames: 11, mode: "crossfade", crossfadeFrames: 6 });
    expect(short).toMatchObject({ crossfadeFrames: 3, outputFrames: 8 });
    expect(short.warnings[0]).toMatch(/shortened from 6 to 3/);
    expect(() => planLoop({ ...motion, sourceFrames: 4, mode: "crossfade" })).toThrow(/at least 5 frames/);
  });

  it("builds a premultiplied tail-into-head cross-fade graph", () => {
    const graph = loopGraph("in", "out", planLoop({ ...motion, mode: "crossfade", dropLastFrame: true }), "l");
    expect(graph).toEqual([
      "[in]trim=end_frame=47,setpts=PTS-STARTPTS[ltrimmed]",
      "[ltrimmed]format=gbrap,premultiply=inplace=1,split=3[la][lb][lc]",
      "[la]trim=start_frame=6:end_frame=41,setpts=PTS-STARTPTS[lbody]",
      "[lb]trim=start_frame=41:end_frame=47,setpts=PTS-STARTPTS[ltail]",
      "[lc]trim=start_frame=0:end_frame=6,setpts=PTS-STARTPTS[lhead]",
      "[ltail][lhead]blend=all_expr='A+(B-A)*(N+1)/7'[lmix]",
      "[lbody][lmix]concat=n=2:v=1:a=0,unpremultiply=inplace=1[out]"
    ]);
    expect(loopGraph("in", "out", planLoop({ ...motion, mode: "pingpong" }), "p")[1]).toBe("[prev]reverse,trim=start_frame=1:end_frame=47,setpts=PTS-STARTPTS[pback]");
  });
});

describe("transparency statistics", () => {
  it("compares frames on premultiplied colour and finds solid and clear areas", () => {
    const clear = solidFrame(10, 10, [0, 255, 0, 0]);
    const otherClear = solidFrame(10, 10, [255, 0, 0, 0]);
    const solid = solidFrame(10, 10, [255, 128, 0, 255]);
    expect(frameDifference(clear, otherClear)).toBe(0);
    expect(frameDifference(clear, solid)).toBeGreaterThan(0.5);
    expect(maxCornerAlpha(clear, 10, 10)).toBe(0);
    expect(opaqueShare(solid)).toBe(1);
    const centre = clear.slice();
    centre.set([255, 128, 0, 255], (5 * 10 + 5) * 4);
    expect(maxCornerAlpha(centre, 10, 10)).toBe(0);
    expect(opaqueShare(centre)).toBe(0.01);
  });

  it("recognises alpha streams and selects the libvpx decoder for VP8/VP9 alpha", () => {
    expect(streamHasAlpha("yuva420p")).toBe(true);
    expect(streamHasAlpha("yuv420p", { ALPHA_MODE: "1" })).toBe(true);
    expect(streamHasAlpha("yuv420p", { alpha_mode: "1" })).toBe(true);
    expect(streamHasAlpha("yuv420p", { alpha_mode: "0" })).toBe(false);
    expect(alphaDecoderArgs({ videoCodec: "vp9", hasAlpha: true })).toEqual(["-c:v", "libvpx-vp9"]);
    expect(alphaDecoderArgs({ videoCodec: "vp8", hasAlpha: true })).toEqual(["-c:v", "libvpx"]);
    expect(alphaDecoderArgs({ videoCodec: "vp9" })).toEqual([]);
    expect(alphaDecoderArgs({ videoCodec: "ffv1", hasAlpha: true })).toEqual([]);
  });

  it("offers the see-through presets to new and older projects", () => {
    const project = createDefaultProject("Presets");
    expect(project.exportPresets.find((preset) => preset.id === "web-vp9-alpha")).toMatchObject({ container: "webm", videoCodec: "libvpx-vp9", alpha: true });
    const older = { exportPresets: project.exportPresets.filter((preset) => !preset.alpha) };
    expect(exportPresetsFor(older).map((preset) => preset.id)).toEqual(["web-h264-1080p", "archive-ffv1", "web-vp9-alpha", "archive-ffv1-alpha"]);
  });
});
