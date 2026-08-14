import type { Curve } from "@mcp-video-studio/contracts";

export function ease(curve: Curve, value: number): number {
  const t = Math.max(0, Math.min(1, value));
  if (curve === "hold") return t >= 1 ? 1 : 0;
  if (curve === "linear") return t;
  if (curve === "easeIn") return t * t;
  if (curve === "easeOut") return 1 - (1 - t) * (1 - t);
  if (curve === "easeInOut") return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  if (curve === "easeOutExpo") return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress;
}
