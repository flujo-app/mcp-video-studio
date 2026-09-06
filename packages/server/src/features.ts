import { createHash, randomUUID } from "node:crypto";
import { ANIMATION_PRESETS, animationPreset, StudioException } from "@mcp-video-studio/core";
import { parseCaptions, serializeCaptions, defaultClip, type GeneratedArtifact, type ProjectCommand } from "@mcp-video-studio/contracts";
import { z } from "zod";
import type { StudioRuntime } from "./runtime.js";

const revision = { projectPath: z.string().min(1), expectedRevision: z.number().int().nonnegative() };
export const featureSchemas = {
  create_animation_preset: z.object({ ...revision, sequenceId: z.string(), trackId: z.string(), startTick: z.number().int().nonnegative(), durationTick: z.number().int().positive(), preset: z.enum(ANIMATION_PRESETS), text: z.string().min(1).max(200) }),
  import_captions: z.object({ ...revision, sequenceId: z.string(), trackId: z.string(), format: z.enum(["srt", "vtt"]), text: z.string().max(1_000_000) }),
  export_captions: z.object({ projectPath: z.string(), sequenceId: z.string(), format: z.enum(["srt", "vtt"]) }),
  adopt_generated_media: z.object({ ...revision, sequenceId: z.string(), clipId: z.string(), mediaId: z.string(), kind: z.enum(["narration", "music"]), name: z.string().min(1).max(300), artifactId: z.string().optional(), note: z.string().max(10000).optional() }),
  compare_generated_versions: z.object({ projectPath: z.string(), artifactId: z.string(), firstVersionId: z.string(), secondVersionId: z.string() }),
  annotate_generated_version: z.object({ ...revision, artifactId: z.string(), versionId: z.string(), reviewer: z.string().min(1).max(300), note: z.string().max(10000) })
};
export type FeatureName = keyof typeof featureSchemas;
function fail(message: string): never { throw new StudioException("INVALID_EDIT", message, "input"); }

export async function invokeFeature(runtime: StudioRuntime, name: FeatureName, value: unknown): Promise<Record<string, unknown>> {
  const input = featureSchemas[name].parse(value);
  const project = await runtime.store(input.projectPath).read();
  if (name === "export_captions") {
    const p = featureSchemas.export_captions.parse(input), sequence = project.sequences.find(s => s.id === p.sequenceId);
    if (!sequence) fail("Sequence not found.");
    return { success: true, format: p.format, mimeType: p.format === "vtt" ? "text/vtt" : "application/x-subrip", text: serializeCaptions(sequence.captions, p.format) };
  }
  if (name === "compare_generated_versions") {
    const p = featureSchemas.compare_generated_versions.parse(input), artifact = project.generatedArtifacts.find(a => a.id === p.artifactId);
    if (!artifact) fail("Artifact not found.");
    const versions = [p.firstVersionId, p.secondVersionId].map(id => {
      const version = artifact.versions.find(v => v.id === id); if (!version) fail("Version not found.");
      return { ...version, active: artifact.activeVersionId === id, approved: artifact.approvedVersionId === id, media: project.media.find(m => m.id === version.output?.mediaId) };
    });
    return { success: true, artifactId: artifact.id, scope: artifact.scope, versions };
  }
  if (name === "annotate_generated_version") {
    const p = featureSchemas.annotate_generated_version.parse(input);
    return runtime.apply(p.projectPath, p.expectedRevision, [{ type: "generation.version.update", artifactId: p.artifactId, versionId: p.versionId, patch: { review: { reviewer: p.reviewer, reviewedAt: new Date().toISOString(), note: p.note } } }]);
  }
  if (name === "adopt_generated_media") {
    const p = featureSchemas.adopt_generated_media.parse(input);
    const sequence = project.sequences.find(s => s.id === p.sequenceId), clip = sequence?.clips.find(c => c.id === p.clipId);
    const media = project.media.find(m => m.id === p.mediaId);
    if (!sequence || !clip || !media?.probe.hasAudio) fail("Select an existing clip and imported audio media.");
    const artifact = p.artifactId ? project.generatedArtifacts.find(a => a.id === p.artifactId) : undefined;
    if (p.artifactId && (!artifact || artifact.kind !== p.kind || artifact.scope.clipId !== clip.id || artifact.scope.sequenceId !== sequence.id)) fail("Artifact must match the selected kind and clip.");
    const request = { provider: "local", sourceMediaId: media.id };
    const version: GeneratedArtifact["versions"][number] = { id: randomUUID(), status: "draft", request, provenance: { provider: "local", model: "imported-media", requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"), sourceRevision: project.revision }, createdAt: new Date().toISOString(), output: { mediaId: media.id }, ...(p.note ? { review: { reviewer: "Studio user", reviewedAt: new Date().toISOString(), note: p.note } } : {}) };
    if (artifact) {
      const parent = artifact.versions.at(-1); if (parent) version.parentVersionId = parent.id;
      return runtime.apply(p.projectPath, p.expectedRevision, [{ type: "generation.version.add", artifactId: artifact.id, version }]);
    }
    const created: GeneratedArtifact = { id: randomUUID(), kind: p.kind, name: p.name, scope: { sequenceId: sequence.id, trackId: clip.trackId, clipId: clip.id, startTick: clip.startTick, durationTick: clip.durationTick }, versions: [version] };
    return runtime.apply(p.projectPath, p.expectedRevision, [{ type: "generation.create", artifact: created }]);
  }
  if (name === "import_captions") {
    const p = featureSchemas.import_captions.parse(input), sequence = project.sequences.find(s => s.id === p.sequenceId);
    if (!sequence?.tracks.some(t => t.id === p.trackId && t.type === "caption" && !t.locked)) fail("Select an unlocked caption track.");
    const captions = parseCaptions(p.text, p.format, p.trackId, project.settings.fps, { fontFamily: "Arial", fontSize: Math.round(54 * project.settings.raster.height / 1080), color: "#ffffff", background: "#000000aa", position: "bottom", align: "center" });
    if (!captions.length) fail("No captions found.");
    return runtime.apply(p.projectPath, p.expectedRevision, captions.map(caption => ({ type: "caption.add", sequenceId: sequence.id, caption })));
  }
  const p = featureSchemas.create_animation_preset.parse(input), sequence = project.sequences.find(s => s.id === p.sequenceId);
  if (!sequence?.tracks.some(t => t.id === p.trackId && ["video", "overlay"].includes(t.type) && !t.locked)) fail("Select an unlocked visual track.");
  const animation = animationPreset(p.preset, p.text, project.settings.raster.width, project.settings.raster.height, p.durationTick);
  const clip = defaultClip(p.trackId, { type: "animation", animationId: animation.id }, animation.name, p.durationTick); clip.startTick = p.startTick;
  const commands: ProjectCommand[] = [{ type: "animation.set", animation }, { type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" }];
  return runtime.apply(p.projectPath, p.expectedRevision, commands);
}
