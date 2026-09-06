import type {
  GeneratedArtifact,
  GeneratedArtifactOutput,
  GeneratedSegment,
} from "./types.js";
export function generatedSegments(
  output: GeneratedArtifactOutput,
  durationTick: number,
): GeneratedSegment[] {
  if (output.segments) return structuredClone(output.segments);
  const source = output.mediaId
    ? { type: "media" as const, mediaId: output.mediaId }
    : output.animationId
      ? { type: "animation" as const, animationId: output.animationId }
      : undefined;
  return source
    ? [{ offsetTick: 0, durationTick, source, sourceInTick: 0 }]
    : [];
}
export function composeGeneratedRegion(
  base: GeneratedArtifactOutput,
  replacement: GeneratedArtifactOutput,
  region: { offsetTick: number; durationTick: number },
  durationTick: number,
): GeneratedSegment[] {
  const end = region.offsetTick + region.durationTick;
  if (
    !Number.isSafeInteger(region.offsetTick) ||
    !Number.isSafeInteger(region.durationTick) ||
    region.offsetTick < 0 ||
    region.durationTick <= 0 ||
    end > durationTick
  )
    throw new Error("Regeneration region must be inside the artifact slot");
  const inserted = generatedSegments(replacement, region.durationTick);
  if (inserted.length !== 1)
    throw new Error("A provider replacement must have one source");
  const segments: GeneratedSegment[] = [];
  for (const item of generatedSegments(base, durationTick)) {
    const finish = item.offsetTick + item.durationTick;
    if (item.offsetTick < region.offsetTick) {
      const right = Math.min(finish, region.offsetTick);
      if (right > item.offsetTick)
        segments.push({ ...item, durationTick: right - item.offsetTick });
    }
    if (finish > end) {
      const left = Math.max(item.offsetTick, end);
      segments.push({
        ...item,
        offsetTick: left,
        durationTick: finish - left,
        sourceInTick: item.sourceInTick + left - item.offsetTick,
      });
    }
  }
  segments.push({
    ...inserted[0]!,
    offsetTick: region.offsetTick,
    durationTick: region.durationTick,
  });
  segments.sort((a, b) => a.offsetTick - b.offsetTick);
  let cursor = 0;
  for (const item of segments) {
    if (item.offsetTick !== cursor)
      throw new Error("Parent version does not cover the whole artifact slot");
    cursor += item.durationTick;
  }
  if (cursor !== durationTick)
    throw new Error("Parent version does not cover the whole artifact slot");
  return segments;
}
export function generationRegion(
  artifact: GeneratedArtifact,
  region?: { offsetTick: number; durationTick: number },
) {
  return region ?? { offsetTick: 0, durationTick: artifact.scope.durationTick };
}
