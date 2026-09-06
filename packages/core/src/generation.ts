import {
  defaultClip,
  generatedSegments,
  type GeneratedArtifact,
  type GeneratedArtifactVersion,
  type GeneratedSegment,
  type ProjectDelta,
  type Sequence,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { splitClipAt, requireUnlocked } from "./timeline.js";
import { StudioException } from "./errors.js";
function fail(message: string): never {
  throw new StudioException("GENERATION_BINDING_CONFLICT", message, "conflict");
}
const at = (segments: GeneratedSegment[], offset: number) =>
  segments.find(
    (s) => s.offsetTick <= offset && s.offsetTick + s.durationTick > offset,
  );
const sourceAt = (s: GeneratedSegment | undefined, offset: number) =>
  s
    ? JSON.stringify({
        source: s.source,
        in: s.sourceInTick + offset - s.offsetTick,
      })
    : "";
/** Apply a complete version composition on a transaction clone. Source-identical
 * regions retain human edits; splitting uses the timeline's automation/transition logic. */
export function activateGenerated(
  project: StudioProject,
  artifact: GeneratedArtifact,
  version: GeneratedArtifactVersion,
  sequence: Sequence,
  changed: ProjectDelta,
) {
  if (!version.output) fail("This version has no generated output.");
  const prior = artifact.versions.find(
    (v) => v.id === artifact.activeVersionId,
  );
  const segments = generatedSegments(
    version.output,
    artifact.scope.durationTick,
  );
  if (segments.length) {
    const priorSegments = prior?.output
      ? generatedSegments(prior.output, artifact.scope.durationTick)
      : [];
    let bindings = artifact.clipBindings
      ? structuredClone(artifact.clipBindings)
      : [];
    if (!bindings.length && artifact.scope.clipId) {
      const clip = sequence.clips.find((c) => c.id === artifact.scope.clipId);
      if (clip)
        bindings = [
          { clipId: clip.id, offsetTick: 0, durationTick: clip.durationTick },
        ];
    }
    if (!bindings.length) {
      const trackId = artifact.scope.trackId,
        clipId = artifact.scope.clipId;
      if (!trackId || !clipId)
        fail("Generated audio/animation requires a track and clip binding.");
      requireUnlocked(sequence, trackId);
      if (
        sequence.clips.some(
          (c) =>
            c.trackId === trackId &&
            c.startTick <
              artifact.scope.startTick + artifact.scope.durationTick &&
            c.startTick + c.durationTick > artifact.scope.startTick,
        )
      )
        fail(
          "The destination slot is occupied. Choose an empty slot or an explicit existing clip.",
        );
      const clip = defaultClip(
        trackId,
        segments[0]!.source,
        artifact.name,
        artifact.scope.durationTick,
      );
      clip.id = clipId;
      clip.startTick = artifact.scope.startTick;
      sequence.clips.push(clip);
      bindings = [
        { clipId, offsetTick: 0, durationTick: artifact.scope.durationTick },
      ];
    }
    const boundaries = [
      ...new Set(
        segments.flatMap((s) => [s.offsetTick, s.offsetTick + s.durationTick]),
      ),
    ].sort((a, b) => a - b);
    for (const binding of [...bindings]) {
      let clip = sequence.clips.find((c) => c.id === binding.clipId);
      if (!clip)
        fail(
          "A bound clip was removed. Restore it before changing this version.",
        );
      if (clip.durationTick !== binding.durationTick)
        fail(
          "A generated clip was trimmed. Restore its slot duration before applying a different version; edits elsewhere remain intact.",
        );
      requireUnlocked(sequence, clip.trackId);
      let current = binding;
      for (const boundary of boundaries.filter(
        (t) =>
          t > binding.offsetTick &&
          t < binding.offsetTick + binding.durationTick,
      )) {
        if (clip.linkedGroupId || clip.groupId)
          fail(
            "Ungroup or unlink the selected generated clip before splitting a regeneration region.",
          );
        const right = splitClipAt(
          sequence,
          clip,
          clip.startTick + boundary - current.offsetTick,
        );
        current.durationTick = clip.durationTick;
        changed.clips.push(clip.id);
        const next = {
          clipId: right.id,
          offsetTick: boundary,
          durationTick: right.durationTick,
        };
        bindings.push(next);
        current = next;
        clip = right;
      }
    }
    for (const binding of bindings) {
      const clip = sequence.clips.find((c) => c.id === binding.clipId)!;
      const segment = at(segments, binding.offsetTick);
      if (
        !segment ||
        binding.offsetTick + binding.durationTick >
          segment.offsetTick + segment.durationTick
      )
        fail("Version composition does not cover its bound clips.");
      if (
        sourceAt(segment, binding.offsetTick) !==
        sourceAt(at(priorSegments, binding.offsetTick), binding.offsetTick)
      ) {
        clip.source = structuredClone(segment.source);
        clip.sourceInTick =
          segment.sourceInTick +
          Math.round(
            ((binding.offsetTick - segment.offsetTick) *
              clip.playbackRate.numerator) /
              clip.playbackRate.denominator,
          );
        changed.clips.push(clip.id);
      }
    }
    artifact.clipBindings = bindings.sort(
      (a, b) => a.offsetTick - b.offsetTick,
    );
    artifact.scope.clipId = artifact.clipBindings[0]!.clipId;
  }
  if (version.output.captions) {
    const previous = new Map(
        prior?.output?.captions?.map((c) => [c.id, c]) ?? [],
      ),
      targets = new Map(version.output.captions.map((c) => [c.id, c]));
    for (const cue of version.output.captions)
      requireUnlocked(sequence, cue.trackId);
    for (const cue of prior?.output?.captions ?? [])
      requireUnlocked(sequence, cue.trackId);
    sequence.captions = sequence.captions.filter(
      (c) => !previous.has(c.id) || targets.has(c.id),
    );
    for (const cue of version.output.captions) {
      const index = sequence.captions.findIndex((c) => c.id === cue.id);
      if (index >= 0) {
        if (!previous.has(cue.id))
          fail("A generated caption conflicts with an unrelated caption ID.");
        if (JSON.stringify(previous.get(cue.id)) !== JSON.stringify(cue))
          sequence.captions[index] = structuredClone(cue);
      } else sequence.captions.push(structuredClone(cue));
    }
  }
  artifact.activeVersionId = version.id;
  changed.sequences.push(sequence.id);
  changed.generatedArtifacts.push(artifact.id);
}
