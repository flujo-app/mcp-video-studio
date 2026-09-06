import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  composeGeneratedRegion,
  defaultClip,
  secondsToTicks,
  type GeneratedArtifact,
  type GeneratedArtifactVersion,
  type MediaAsset,
} from "@mcp-video-studio/contracts";
import { ProjectStore } from "@mcp-video-studio/core";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const t = secondsToTicks;
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "generation-region-"));
  roots.push(root);
  const store = await ProjectStore.create(root, "Region test"),
    project = await store.read(),
    sequence = project.sequences[0]!,
    track = sequence.tracks.find((t) => t.type === "audio")!;
  const media = ["a", "b", "c"].map((id): MediaAsset => ({
    id,
    name: id + ".wav",
    kind: "audio",
    mimeType: "audio/wav",
    storage: {
      mode: "managed",
      sha256: id.repeat(64),
      relativePath: "assets/" + id + ".wav",
      bytes: 10,
    },
    probe: {
      durationTick: t(10),
      hasVideo: false,
      hasAudio: true,
      sampleRate: 48000,
      channels: 2,
    },
    createdAt: new Date().toISOString(),
  }));
  const clip = defaultClip(
    track.id,
    { type: "media", mediaId: "a" },
    "Main",
    t(4),
  );
  clip.id = "generated";
  clip.audio.gainDb = -4;
  const unrelated = defaultClip(
    track.id,
    { type: "media", mediaId: "c" },
    "Human elsewhere",
    t(1),
  );
  unrelated.startTick = t(10);
  unrelated.audio.gainDb = -12;
  const version: GeneratedArtifactVersion = {
    id: "v1",
    status: "draft",
    request: { provider: "local" },
    provenance: {
      provider: "local",
      model: "fixture",
      requestHash: "a".repeat(64),
      sourceRevision: 0,
    },
    createdAt: new Date().toISOString(),
    output: { mediaId: "a" },
  };
  const artifact: GeneratedArtifact = {
    id: "artifact",
    kind: "narration",
    name: "Narration",
    scope: {
      sequenceId: sequence.id,
      trackId: track.id,
      clipId: clip.id,
      startTick: 0,
      durationTick: t(4),
    },
    activeVersionId: "v1",
    versions: [version],
  };
  await store.replace(
    0,
    (draft) => {
      draft.media.push(...media);
      draft.sequences[0]!.clips.push(clip, unrelated);
      draft.generatedArtifacts.push(artifact);
    },
    {
      sequences: [sequence.id],
      tracks: [],
      clips: [clip.id, unrelated.id],
      media: media.map((m) => m.id),
      animations: [],
      generatedArtifacts: [artifact.id],
    },
  );
  return { root, store, artifact, sequenceId: sequence.id, unrelated };
}
it("persists partial-region composition, preserves edits outside it, and reverts every version after reopening", async () => {
  const { root, store, artifact, sequenceId, unrelated } = await setup();
  const v1 = artifact.versions[0]!;
  const v2: GeneratedArtifactVersion = {
    ...structuredClone(v1),
    id: "v2",
    parentVersionId: "v1",
    region: { offsetTick: t(1), durationTick: t(1) },
    output: {
      segments: composeGeneratedRegion(
        v1.output!,
        { mediaId: "b" },
        { offsetTick: t(1), durationTick: t(1) },
        t(4),
      ),
    },
  };
  await store.mutate(1, [
    { type: "generation.version.add", artifactId: artifact.id, version: v2 },
    {
      type: "generation.version.activate",
      artifactId: artifact.id,
      versionId: "v2",
    },
  ]);
  let project = await store.read();
  const generated = project.sequences[0]!.clips.filter(
    (c) => c.id !== unrelated.id,
  );
  expect(
    generated.map((c) => [
      c.startTick,
      c.durationTick,
      c.source,
      c.sourceInTick,
    ]),
  ).toEqual([
    [0, t(1), { type: "media", mediaId: "a" }, 0],
    [t(1), t(1), { type: "media", mediaId: "b" }, 0],
    [t(2), t(2), { type: "media", mediaId: "a" }, t(2)],
  ]);
  expect(generated.every((c) => c.audio.gainDb === -4)).toBe(true);
  await store.mutate(project.revision, [
    {
      type: "clip.update",
      sequenceId,
      clipId: generated[0]!.id,
      patch: { audio: { ...generated[0]!.audio, gainDb: -9 } },
    },
  ]);
  project = await store.read();
  const v3: GeneratedArtifactVersion = {
    ...structuredClone(v2),
    id: "v3",
    parentVersionId: "v2",
    region: { offsetTick: t(3), durationTick: t(1) },
    output: {
      segments: composeGeneratedRegion(
        v2.output!,
        { mediaId: "c" },
        { offsetTick: t(3), durationTick: t(1) },
        t(4),
      ),
    },
  };
  await store.mutate(project.revision, [
    { type: "generation.version.add", artifactId: artifact.id, version: v3 },
    {
      type: "generation.version.activate",
      artifactId: artifact.id,
      versionId: "v3",
    },
  ]);
  const reopened = new ProjectStore(root);
  for (const id of ["v1", "v2", "v3"]) {
    project = await reopened.read();
    await reopened.mutate(project.revision, [
      {
        type: "generation.version.activate",
        artifactId: artifact.id,
        versionId: id,
      },
    ]);
    project = await reopened.read();
    expect(project.generatedArtifacts[0]!.activeVersionId).toBe(id);
    expect(
      project.sequences[0]!.clips.find((c) => c.id === generated[0]!.id)!.audio
        .gainDb,
    ).toBe(-9);
    expect(
      project.sequences[0]!.clips.find((c) => c.id === unrelated.id),
    ).toEqual(unrelated);
  }
});
it("first explicit activation can create its clip while generation itself remains an unbound draft", async () => {
  const { store, artifact } = await setup();
  let project = await store.read();
  await store.replace(
    project.revision,
    (draft) => {
      draft.sequences[0]!.clips = draft.sequences[0]!.clips.filter(
        (c) => c.id !== "generated",
      );
      delete draft.generatedArtifacts[0]!.activeVersionId;
    },
    {
      sequences: [artifact.scope.sequenceId],
      tracks: [],
      clips: ["generated"],
      media: [],
      animations: [],
      generatedArtifacts: [artifact.id],
    },
  );
  project = await store.read();
  expect(project.sequences[0]!.clips.some((c) => c.id === "generated")).toBe(
    false,
  );
  await store.mutate(project.revision, [
    {
      type: "generation.version.activate",
      artifactId: artifact.id,
      versionId: "v1",
    },
  ]);
  expect(
    (await store.read()).sequences[0]!.clips.some((c) => c.id === "generated"),
  ).toBe(true);
});
it("incompatible trimmed binding rejects transactionally without discarding the human edit", async () => {
  const { store, artifact, sequenceId } = await setup();
  await store.mutate(1, [
    {
      type: "generation.version.activate",
      artifactId: artifact.id,
      versionId: "v1",
    },
  ]);
  let project = await store.read();
  await store.mutate(project.revision, [
    {
      type: "clip.update",
      sequenceId,
      clipId: "generated",
      patch: { durationTick: t(3) },
    },
  ]);
  project = await store.read();
  await expect(
    store.mutate(project.revision, [
      {
        type: "generation.version.activate",
        artifactId: artifact.id,
        versionId: "v1",
      },
    ]),
  ).rejects.toThrow("trimmed");
  expect(await store.read()).toEqual(project);
});
it("region composition preserves source offsets and rejects missing coverage or escaping ranges", () => {
  expect(
    composeGeneratedRegion(
      { mediaId: "a" },
      { mediaId: "b" },
      { offsetTick: t(1), durationTick: t(1) },
      t(4),
    ).map((s) => s.sourceInTick),
  ).toEqual([0, 0, t(2)]);
  expect(() =>
    composeGeneratedRegion(
      { mediaId: "a" },
      { mediaId: "b" },
      { offsetTick: t(3), durationTick: t(2) },
      t(4),
    ),
  ).toThrow("inside");
  expect(() =>
    composeGeneratedRegion(
      { segments: [] },
      { mediaId: "b" },
      { offsetTick: t(1), durationTick: t(1) },
      t(4),
    ),
  ).toThrow("cover");
});
