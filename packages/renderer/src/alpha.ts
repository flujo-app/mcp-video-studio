import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ticksToSeconds, type EffectInstance, type MediaProbe } from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";
import { alphaDecoderArgs, probeMedia, runChecked, type StudioConfig } from "@mcp-video-studio/media";

/**
 * See-through (alpha) helpers shared by timeline rendering, loop export and QC.
 * Everything here is plain FFmpeg plus small pixel statistics computed in Node; no models.
 */

export type KeyMethod = "auto" | "chroma" | "color";
export type Rgb = [number, number, number];

export interface BackdropKeyOptions {
  /** Backdrop colour as `#rrggbb`, `0xrrggbb`, a basic colour name, or `auto` to read it from the frame corners. */
  color?: string | undefined;
  /** `chroma` keys on hue only (best for saturated green/blue/magenta screens); `color` keys on full RGB distance (needed for white, grey or black backdrops). */
  method?: KeyMethod | undefined;
  /** How far a colour may be from the backdrop and still be removed (0.01–1). */
  tolerance?: number | undefined;
  /** Width of the soft edge between removed and kept colours (0–1). */
  softness?: number | undefined;
  /** How strongly the backdrop's tint is pulled out of the subject (0 disables). */
  despill?: number | undefined;
}

export interface ResolvedBackdropKey {
  color: Rgb;
  method: "chroma" | "color";
  tolerance: number;
  softness: number;
  despill: number;
}

export const BACKDROP_KEY_DEFAULTS = { tolerance: 0.15, softness: 0.08, despill: 1 } as const;
/** Alpha values this close to fully clear or fully solid are snapped, which removes faint haze from compression noise. */
const ALPHA_SNAP = 8;

const NAMED_COLORS: Record<string, Rgb> = {
  green: [0, 255, 0], blue: [0, 0, 255], magenta: [255, 0, 255], red: [255, 0, 0],
  cyan: [0, 255, 255], yellow: [255, 255, 0], white: [255, 255, 255], black: [0, 0, 0], grey: [128, 128, 128], gray: [128, 128, 128]
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseColor(value: string): Rgb {
  const text = value.trim().toLowerCase();
  const named = NAMED_COLORS[text];
  if (named) return [...named];
  const match = /^(?:#|0x)?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (!match) throw new StudioException("INVALID_COLOR", `Unsupported colour: ${value}. Use #rrggbb, 0xrrggbb, a basic colour name, or auto.`, "input");
  const hex = match[1]!.length === 3 ? match[1]!.split("").map((digit) => digit + digit).join("") : match[1]!;
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

export function colorHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => clamp(Math.round(channel), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

/** Saturated backdrops are keyed by hue; neutral ones (white, grey, black) need full colour distance. */
export function resolveKeyMethod(rgb: Rgb, method: KeyMethod = "auto"): "chroma" | "color" {
  if (method !== "auto") return method;
  return Math.max(...rgb) - Math.min(...rgb) >= 64 ? "chroma" : "color";
}

export function resolveBackdropKey(color: Rgb, options: BackdropKeyOptions = {}): ResolvedBackdropKey {
  return {
    color,
    method: resolveKeyMethod(color, options.method ?? "auto"),
    tolerance: clamp(finite(options.tolerance, BACKDROP_KEY_DEFAULTS.tolerance), 0.01, 1),
    softness: clamp(finite(options.softness, BACKDROP_KEY_DEFAULTS.softness), 0, 1),
    despill: clamp(finite(options.despill, BACKDROP_KEY_DEFAULTS.despill), 0, 1)
  };
}

/** Reads a `backdropKey` clip effect's parameters. */
export function backdropKeyOptionsFromEffect(effect: EffectInstance): BackdropKeyOptions & { color: string } {
  const p = effect.parameters;
  const method = p.method === "chroma" || p.method === "color" ? p.method : "auto";
  return {
    color: typeof p.color === "string" && p.color.trim() ? p.color : "auto",
    method,
    tolerance: finite(p.tolerance, BACKDROP_KEY_DEFAULTS.tolerance),
    softness: finite(p.softness, BACKDROP_KEY_DEFAULTS.softness),
    despill: finite(p.despill, BACKDROP_KEY_DEFAULTS.despill)
  };
}

function nested(fn: "min" | "max", terms: string[]): string {
  return terms.reduce((left, right) => `${fn}(${left},${right})`);
}

/**
 * Spill removal for any backdrop hue (FFmpeg's own `despill` only knows green and blue).
 * The backdrop's strong channels are pulled down to the level of its weak channels, but only
 * where every strong channel stands out — skin, wood or a teal shirt are left alone.
 */
export function despillFilter(rgb: Rgb, strength: number): string | undefined {
  if (strength <= 0) return undefined;
  const channels = ["r", "g", "b"] as const;
  const high = channels.filter((_, index) => rgb[index]! / 255 > 0.6);
  const low = channels.filter((_, index) => rgb[index]! / 255 < 0.4);
  if (!high.length || !low.length) return undefined;
  const sample = (channel: string) => `${channel}(X,Y)`;
  const spill = `max(0,${nested("min", high.map(sample))}-${nested("max", low.map(sample))})*${Number(strength.toFixed(4))}`;
  const expressions = channels.map((channel) => `${channel}='${sample(channel)}${high.includes(channel) ? `-${spill}` : ""}'`);
  return `geq=${expressions.join(":")}:a='alpha(X,Y)'`;
}

/**
 * Filter-graph statements that turn `input` into `output` with the backdrop removed.
 * FFmpeg's keyers overwrite alpha, so the keyed matte is multiplied with the source's own
 * alpha: footage that is already partly see-through stays see-through.
 */
export function backdropKeyGraph(input: string, output: string, key: ResolvedBackdropKey, prefix: string): string[] {
  const color = `0x${colorHex(key.color).slice(1)}`;
  const tolerance = Number(key.tolerance.toFixed(4));
  const softness = Number(key.softness.toFixed(4));
  const keyer = key.method === "chroma"
    ? `format=yuva444p,chromakey=color=${color}:similarity=${tolerance}:blend=${softness}`
    : `format=rgba,colorkey=color=${color}:similarity=${tolerance}:blend=${softness}`;
  const despill = despillFilter(key.color, key.despill);
  const snap = `lutrgb=a='if(lt(val,${ALPHA_SNAP}),0,if(gt(val,${255 - ALPHA_SNAP}),255,val))'`;
  return [
    `[${input}]format=rgba,split=2[${prefix}src][${prefix}own]`,
    `[${prefix}own]alphaextract[${prefix}ownalpha]`,
    `[${prefix}src]${[keyer, "format=gbrap", ...(despill ? [despill] : []), "split=2"].join(",")}[${prefix}keyed][${prefix}matte]`,
    `[${prefix}matte]alphaextract[${prefix}keyalpha]`,
    `[${prefix}keyalpha][${prefix}ownalpha]blend=all_mode=multiply[${prefix}alpha]`,
    `[${prefix}keyed][${prefix}alpha]alphamerge,format=rgba,${snap}[${output}]`
  ];
}

export interface RgbaFrames {
  width: number;
  height: number;
  frames: Buffer[];
}

/** Small analysis raster that keeps the picture's shape. */
export function analysisSize(probe: Pick<MediaProbe, "width" | "height">, maxWidth = 96): { width: number; height: number } {
  const sourceWidth = probe.width ?? maxWidth;
  const sourceHeight = probe.height ?? maxWidth;
  const width = Math.max(2, Math.min(maxWidth, sourceWidth));
  return { width, height: Math.max(2, Math.round(sourceHeight * width / sourceWidth)) };
}

/** Decodes frames to straight RGBA at a small fixed size (alpha preserved) for pixel statistics. */
export async function readRgbaFrames(config: StudioConfig, inputPath: string, options: { width: number; height: number; inputArgs?: string[]; filters?: string[]; maxFrames?: number; signal?: AbortSignal | undefined }): Promise<RgbaFrames> {
  await mkdir(config.scratchDir, { recursive: true });
  const rawPath = path.join(config.scratchDir, `frames-${randomUUID()}.rgba`);
  try {
    await runChecked(config.ffmpegPath, [
      "-hide_banner", "-v", "error", "-y", ...(options.inputArgs ?? []), "-i", path.resolve(inputPath), "-map", "0:v:0", "-an",
      "-vf", [...(options.filters ?? []), `scale=${options.width}:${options.height}:flags=area`, "format=rgba"].join(","),
      ...(options.maxFrames ? ["-frames:v", String(options.maxFrames)] : []),
      "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", rawPath
    ], { signal: options.signal, timeoutMs: 60 * 60_000 });
    const data = await readFile(rawPath);
    const size = options.width * options.height * 4;
    const frames: Buffer[] = [];
    for (let offset = 0; offset + size <= data.length; offset += size) frames.push(data.subarray(offset, offset + size));
    return { width: options.width, height: options.height, frames };
  } finally {
    await rm(rawPath, { force: true }).catch(() => undefined);
  }
}

/** Mean absolute difference of two RGBA frames with colour weighted by alpha (0 = identical, 1 = opposite). */
export function frameDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) throw new RangeError("Frames must have the same non-zero size.");
  let sum = 0;
  for (let index = 0; index < a.length; index += 4) {
    const alphaA = a[index + 3]! / 255;
    const alphaB = b[index + 3]! / 255;
    for (let channel = 0; channel < 3; channel += 1) sum += Math.abs(a[index + channel]! * alphaA - b[index + channel]! * alphaB) / 255;
    sum += Math.abs(alphaA - alphaB);
  }
  return sum / a.length;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function consecutiveDifferences(frames: Uint8Array[]): number[] {
  return frames.slice(1).map((frame, index) => frameDifference(frames[index]!, frame));
}

function cornerBoxes(width: number, height: number, share: number): Array<{ name: string; x0: number; y0: number; x1: number; y1: number }> {
  const w = Math.max(1, Math.round(width * share));
  const h = Math.max(1, Math.round(height * share));
  return [
    { name: "top-left", x0: 0, y0: 0, x1: w, y1: h },
    { name: "top-right", x0: width - w, y0: 0, x1: width, y1: h },
    { name: "bottom-left", x0: 0, y0: height - h, x1: w, y1: height },
    { name: "bottom-right", x0: width - w, y0: height - h, x1: width, y1: height }
  ];
}

/** Highest alpha (0–255) found in the four corner patches. */
export function maxCornerAlpha(frame: Uint8Array, width: number, height: number, share = 0.08): number {
  let max = 0;
  for (const box of cornerBoxes(width, height, share)) {
    for (let y = box.y0; y < box.y1; y += 1) for (let x = box.x0; x < box.x1; x += 1) max = Math.max(max, frame[(y * width + x) * 4 + 3]!);
  }
  return max;
}

/** Share of pixels that are fully solid (alpha >= 240). */
export function opaqueShare(frame: Uint8Array): number {
  let solid = 0;
  for (let index = 3; index < frame.length; index += 4) if (frame[index]! >= 240) solid += 1;
  return solid / (frame.length / 4);
}

/** Share of pixels that are at least partly see-through (alpha < 255). */
export function transparentShare(frame: Uint8Array): number {
  let clear = 0;
  for (let index = 3; index < frame.length; index += 4) if (frame[index]! < 255) clear += 1;
  return clear / (frame.length / 4);
}

export interface BackdropDetection {
  color: string;
  rgb: Rgb;
  method: "chroma" | "color";
  /** Largest per-channel difference (0–1) between the four corner colours; small means a clean, even backdrop. */
  spread: number;
  confident: boolean;
  /** True when the corners are already see-through, so there is no backdrop left to remove. */
  alreadyTransparent: boolean;
  corners: Array<{ position: string; color: string }>;
  atTick: number;
}

/** Reads the backdrop colour from the four corners of one frame. */
export async function detectBackdropColor(inputPath: string, config: StudioConfig, options: { atTick?: number; probe?: MediaProbe; signal?: AbortSignal | undefined } = {}): Promise<BackdropDetection> {
  const probe = options.probe ?? await probeMedia(inputPath, config, options.signal);
  if (!probe.hasVideo) throw new StudioException("NO_VIDEO_STREAM", "Backdrop detection needs a video or image source.", "input");
  const atTick = Math.max(0, Math.round(options.atTick ?? 0));
  const size = { width: 64, height: 64 };
  const { frames } = await readRgbaFrames(config, inputPath, {
    ...size, maxFrames: 1, signal: options.signal,
    inputArgs: [...(atTick > 0 ? ["-ss", String(ticksToSeconds(atTick))] : []), ...alphaDecoderArgs(probe)]
  });
  const frame = frames[0];
  if (!frame) throw new StudioException("NO_FRAME", "No frame could be decoded at the requested time.", "input");
  const corners = cornerBoxes(size.width, size.height, 0.1).map((box) => {
    const samples: Rgb[] = [];
    let alpha = 0;
    for (let y = box.y0; y < box.y1; y += 1) for (let x = box.x0; x < box.x1; x += 1) {
      const offset = (y * size.width + x) * 4;
      samples.push([frame[offset]!, frame[offset + 1]!, frame[offset + 2]!]);
      alpha = Math.max(alpha, frame[offset + 3]!);
    }
    const rgb: Rgb = [0, 1, 2].map((channel) => median(samples.map((sample) => sample[channel]!))) as Rgb;
    return { position: box.name, rgb, alpha };
  });
  const rgb: Rgb = [0, 1, 2].map((channel) => Math.round(median(corners.map((corner) => corner.rgb[channel]!)))) as Rgb;
  const spread = Math.max(...[0, 1, 2].map((channel) => {
    const values = corners.map((corner) => corner.rgb[channel]!);
    return (Math.max(...values) - Math.min(...values)) / 255;
  }));
  return {
    color: colorHex(rgb), rgb, method: resolveKeyMethod(rgb), spread: Number(spread.toFixed(4)), confident: spread <= 0.12,
    alreadyTransparent: corners.every((corner) => corner.alpha <= 16),
    corners: corners.map((corner) => ({ position: corner.position, color: colorHex(corner.rgb) })), atTick
  };
}
