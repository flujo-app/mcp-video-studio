export const TICKS_PER_SECOND = 35_280_000;

export type Rational = Readonly<{ numerator: number; denominator: number }>;
export type TimeInput =
  | { ticks: number }
  | { seconds: number }
  | { frames: number }
  | { samples: number; sampleRate: number };

function assertSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer.`);
  return value;
}

export function gcd(a: number, b: number): number {
  let left = Math.abs(assertSafeInteger(a, "a"));
  let right = Math.abs(assertSafeInteger(b, "b"));
  while (right !== 0) [left, right] = [right, left % right];
  return left || 1;
}

export function rational(numerator: number, denominator = 1): Rational {
  assertSafeInteger(numerator, "numerator");
  assertSafeInteger(denominator, "denominator");
  if (denominator === 0) throw new RangeError("Rational denominator cannot be zero.");
  const sign = denominator < 0 ? -1 : 1;
  const divisor = gcd(numerator, denominator);
  return {
    numerator: sign * numerator / divisor,
    denominator: sign * denominator / divisor
  };
}

export function ticksPerFrame(frameRate: Rational): number {
  const rate = rational(frameRate.numerator, frameRate.denominator);
  if (rate.numerator <= 0) throw new RangeError("Frame rate must be positive.");
  const scaled = TICKS_PER_SECOND * rate.denominator;
  if (scaled % rate.numerator !== 0) {
    throw new RangeError(`${rate.numerator}/${rate.denominator} fps is not exact in the Studio timebase.`);
  }
  return scaled / rate.numerator;
}

export function ticksPerSample(sampleRate: number): number {
  assertSafeInteger(sampleRate, "sampleRate");
  if (sampleRate <= 0 || TICKS_PER_SECOND % sampleRate !== 0) {
    throw new RangeError(`${sampleRate} Hz is not exact in the Studio timebase.`);
  }
  return TICKS_PER_SECOND / sampleRate;
}

export function framesToTicks(frames: number, frameRate: Rational): number {
  return assertSafeInteger(frames, "frames") * ticksPerFrame(frameRate);
}

export function ticksToFrames(ticks: number, frameRate: Rational, mode: "exact" | "floor" | "ceil" | "round" = "exact"): number {
  assertSafeInteger(ticks, "ticks");
  const perFrame = ticksPerFrame(frameRate);
  const value = ticks / perFrame;
  if (mode === "exact" && !Number.isInteger(value)) throw new RangeError(`${ticks} ticks is not frame-aligned.`);
  if (mode === "floor") return Math.floor(value);
  if (mode === "ceil") return Math.ceil(value);
  if (mode === "round") return Math.round(value);
  return value;
}

export function samplesToTicks(samples: number, sampleRate: number): number {
  return assertSafeInteger(samples, "samples") * ticksPerSample(sampleRate);
}

export function ticksToSamples(ticks: number, sampleRate: number, mode: "exact" | "floor" | "ceil" | "round" = "exact"): number {
  assertSafeInteger(ticks, "ticks");
  const perSample = ticksPerSample(sampleRate);
  const value = ticks / perSample;
  if (mode === "exact" && !Number.isInteger(value)) throw new RangeError(`${ticks} ticks is not sample-aligned.`);
  if (mode === "floor") return Math.floor(value);
  if (mode === "ceil") return Math.ceil(value);
  if (mode === "round") return Math.round(value);
  return value;
}

export function secondsToTicks(seconds: number): number {
  if (!Number.isFinite(seconds)) throw new RangeError("seconds must be finite.");
  return assertSafeInteger(Math.round(seconds * TICKS_PER_SECOND), "ticks");
}

export function ticksToSeconds(ticks: number): number {
  return assertSafeInteger(ticks, "ticks") / TICKS_PER_SECOND;
}

export function timeInputToTicks(input: TimeInput, frameRate: Rational): number {
  if ("ticks" in input) return assertSafeInteger(input.ticks, "ticks");
  if ("seconds" in input) return secondsToTicks(input.seconds);
  if ("frames" in input) return framesToTicks(input.frames, frameRate);
  return samplesToTicks(input.samples, input.sampleRate);
}

export function formatTimecode(ticks: number, frameRate: Rational): string {
  const frames = ticksToFrames(ticks, frameRate, "round");
  const nominalFps = Math.round(frameRate.numerator / frameRate.denominator);
  const frame = frames % nominalFps;
  const totalSeconds = Math.floor(frames / nominalFps);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return [hours, minutes, seconds, frame].map((value) => String(value).padStart(2, "0")).join(":");
}
