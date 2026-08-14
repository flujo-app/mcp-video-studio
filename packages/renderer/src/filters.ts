import type { Clip, EffectInstance } from "@mcp-video-studio/contracts";

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function atempoChain(rate: number): string[] {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError("Audio tempo rate must be positive.");
  const filters: string[] = [];
  let value = rate;
  while (value > 2) { filters.push("atempo=2"); value /= 2; }
  while (value < 0.5) { filters.push("atempo=0.5"); value /= 0.5; }
  if (Math.abs(value - 0.5) < 1e-9) filters.push("atempo=0.5");
  else if (Math.abs(value - 2) < 1e-9) filters.push("atempo=2");
  else if (Math.abs(value - 1) > 1e-9) filters.push(`atempo=${value.toFixed(8)}`);
  return filters;
}

export function videoEffectFilters(effects: EffectInstance[]): string[] {
  const result: string[] = [];
  for (const effect of effects.filter((item) => item.enabled)) {
    const p = effect.parameters;
    if (effect.type === "color") {
      const brightness = number(p.brightness, 0);
      const contrast = number(p.contrast, 1);
      const saturation = number(p.saturation, 1);
      result.push(`eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}`);
    } else if (effect.type === "brightness") result.push(`eq=brightness=${Math.max(-1, Math.min(1, number(p.value, 0)))}`);
    else if (effect.type === "blur") result.push(`gblur=sigma=${Math.max(0, number(p.radius, 4))}`);
    else if (effect.type === "sharpen") result.push(`unsharp=5:5:${number(p.amount, 1)}`);
    else if (effect.type === "vignette") result.push(`vignette=angle=${number(p.angle, Math.PI / 5)}`);
    else if (effect.type === "chromaKey") result.push(`chromakey=${String(p.color ?? "0x00ff00")}:${number(p.similarity, 0.15)}:${number(p.blend, 0.05)}`);
  }
  return result;
}

export function audioEffectFilters(effects: EffectInstance[]): string[] {
  const result: string[] = [];
  for (const effect of effects.filter((item) => item.enabled)) {
    const p = effect.parameters;
    if (effect.type === "equalizer") {
      const bands = Array.isArray(p.bands) ? p.bands : [];
      for (const band of bands) {
        if (band && typeof band === "object") {
          const item = band as Record<string, unknown>;
          result.push(`equalizer=f=${number(item.frequency, 1000)}:width_type=q:width=${number(item.q, 1)}:g=${number(item.gainDb, 0)}`);
        }
      }
    } else if (effect.type === "highpass") result.push(`highpass=f=${number(p.frequency, 80)}`);
    else if (effect.type === "lowpass") result.push(`lowpass=f=${number(p.frequency, 16000)}`);
    else if (effect.type === "compressor") result.push(`acompressor=threshold=${number(p.threshold, 0.125)}:ratio=${number(p.ratio, 4)}:attack=${number(p.attack, 20)}:release=${number(p.release, 250)}`);
    else if (effect.type === "limiter") result.push(`alimiter=limit=${number(p.limit, 0.891)}`);
    else if (effect.type === "delay") result.push(`aecho=0.8:0.88:${number(p.delayMs, 250)}:${number(p.decay, 0.3)}`);
  }
  return result;
}

export function clipTransformFilters(clip: Clip, canvas: { width: number; height: number }): { filters: string[]; x: number; y: number } {
  const width = Math.max(2, Math.round(canvas.width * clip.transform.scale[0]));
  const height = Math.max(2, Math.round(canvas.height * clip.transform.scale[1]));
  const x = Math.round(clip.transform.position[0] * canvas.width - width * clip.transform.anchor[0]);
  const y = Math.round(clip.transform.position[1] * canvas.height - height * clip.transform.anchor[1]);
  const filters = [`scale=${width}:${height}:force_original_aspect_ratio=decrease`, `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black@0`, "format=rgba"];
  if (clip.transform.rotation !== 0) filters.push(`rotate=${clip.transform.rotation}*PI/180:ow=rotw(iw):oh=roth(ih):c=none`);
  if (clip.transform.opacity < 1) filters.push(`colorchannelmixer=aa=${clip.transform.opacity}`);
  return { filters, x, y };
}
