import { expect, it } from "vitest";
import { secondsToTicks, defaultClip } from "@mcp-video-studio/contracts";
import {
  generationFixture,
  generationInput,
  providerSecret,
  secretFiles,
  uiToken,
  until,
} from "./generation-fixture.js";
const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
integration(
  "all four providers produce persistent drafts and partial versions from fresh modern/legacy MCP sessions without changing unrelated edits",
  async () => {
    const f = await generationFixture();
    try {
      for (const kind of ["narration", "music", "captions", "animation"]) {
        const first = await f.client("auto");
        let project = await f.store.read();
        const input = generationInput(project, kind, f.sourceMediaId);
        const generated = await f.call(first, "generate_" + kind, {
          projectPath: f.projectPath,
          ...input,
        });
        await f.done(generated.job.id);
        project = await f.store.read();
        let artifact = project.generatedArtifacts.find(
          (a) => a.id === generated.artifactId,
        )!;
        expect(artifact.activeVersionId).toBeUndefined();
        expect(artifact.versions[0]!.status).toBe("draft");
        await first.close();
        const fresh = await f.client("legacy");
        await f.call(fresh, "apply_timeline_transaction", {
          projectPath: f.projectPath,
          expectedRevision: project.revision,
          commands: [
            { type: "project.rename", name: "Human edit survives " + kind },
          ],
        });
        project = await f.store.read();
        const result = await f.call(fresh, "regenerate_generated_artifact", {
          projectPath: f.projectPath,
          expectedRevision: project.revision,
          artifactId: artifact.id,
          parentVersionId: artifact.versions[0]!.id,
          region: {
            offsetTick: secondsToTicks(1),
            durationTick: secondsToTicks(1),
          },
        });
        await f.done(result.job.id);
        project = await f.store.read();
        artifact = project.generatedArtifacts.find(
          (a) => a.id === artifact.id,
        )!;
        expect(project.name).toBe("Human edit survives " + kind);
        expect(artifact.activeVersionId).toBeUndefined();
        expect(artifact.versions).toHaveLength(2);
        expect(artifact.versions[1]!.region).toEqual({
          offsetTick: secondsToTicks(1),
          durationTick: secondsToTicks(1),
        });
        if (kind !== "captions")
          expect(artifact.versions[1]!.output!.segments).toHaveLength(3);
        else
          expect(
            artifact.versions[1]!.output!.captions!.some(
              (c) => c.startTick === secondsToTicks(1),
            ),
          ).toBe(true);
        await fresh.close();
      }
      expect(
        f.calls.filter((c) => c.url.includes("speech-to-text")),
      ).toHaveLength(2);
      const body = f.calls.filter((c) => c.url.includes("speech-to-text"))[1]!
        .body;
      expect(body.includes("RIFF")).toBe(true);
      expect(body.byteLength).toBeLessThan(40000);
      const wave = body.subarray(body.indexOf("RIFF"));
      let pcm: Buffer | undefined;
      for (let offset = 12; offset + 8 < wave.length;) {
        const name = wave.toString("ascii", offset, offset + 4),
          size = wave.readUInt32LE(offset + 4);
        if (name === "fmt ") expect(wave.readUInt32LE(offset + 12)).toBe(16000);
        if (name === "data") {
          pcm = wave.subarray(offset + 8, offset + 8 + size);
          break;
        }
        offset += 8 + size + (size % 2);
      }
      expect(pcm).toBeDefined();
      let crossings = 0;
      for (let offset = 2; offset < pcm!.length; offset += 2)
        if (pcm!.readInt16LE(offset - 2) <= 0 && pcm!.readInt16LE(offset) > 0)
          crossings++;
      expect(crossings).toBeGreaterThan(437);
      expect(crossings).toBeLessThan(443);
      expect(await secretFiles(f.root)).toEqual([]);
      const response = await fetch(
        f.gateway.origin +
          "/api/project?projectPath=" +
          encodeURIComponent(f.projectPath),
        { headers: { authorization: "Bearer " + uiToken } },
      );
      expect(await response.text()).not.toContain(providerSecret);
    } finally {
      await f.close();
    }
  },
  120000,
);
integration(
  "autoActivate is explicit and preserves a reviewable draft when timeline activation conflicts",
  async () => {
    const f = await generationFixture();
    try {
      const client = await f.client();
      let project = await f.store.read();
      const input = generationInput(project, "narration", f.sourceMediaId);
      const first = await f.call(client, "generate_narration", {
        projectPath: f.projectPath,
        ...input,
        autoActivate: true,
      });
      await f.done(first.job.id);
      project = await f.store.read();
      expect(project.generatedArtifacts[0]!.activeVersionId).toBe(
        first.versionId,
      );
      expect(project.sequences[0]!.clips).toHaveLength(1);
      const second = await f.call(client, "generate_narration", {
        projectPath: f.projectPath,
        ...input,
        expectedRevision: project.revision,
        autoActivate: true,
      });
      await f.done(second.job.id);
      project = await f.store.read();
      const draft = project.generatedArtifacts.find(
        (a) => a.id === second.artifactId,
      )!;
      expect(draft.activeVersionId).toBeUndefined();
      expect(draft.versions[0]!.status).toBe("draft");
      expect(draft.versions[0]!.error?.code).toBe("AUTO_ACTIVATE_CONFLICT");
      expect(project.sequences[0]!.clips).toHaveLength(1);
    } finally {
      await f.close();
    }
  },
  60000,
);
integration(
  "credential canaries never persist in outputs, history, jobs, MCP results or browser API on provider echoes and failures",
  async () => {
    const f = await generationFixture();
    try {
      const client = await f.client();
      for (const mode of ["echo", "echo-encoded", "echo-mislabel", "error"])
        for (const kind of ["narration", "music", "captions", "animation"]) {
          f.mode = mode;
          const project = await f.store.read(),
            result = await f.call(client, "generate_" + kind, {
              projectPath: f.projectPath,
              ...generationInput(project, kind, f.sourceMediaId),
            });
          await until(() =>
            ["completed", "failed"].includes(
              f.runtime.jobs.get(result.job.id)?.status ?? "",
            ),
          );
          const artifact = (await f.store.read()).generatedArtifacts.find(
            (a) => a.id === result.artifactId,
          )!;
          expect(JSON.stringify(artifact)).not.toContain(providerSecret);
          expect(JSON.stringify(f.runtime.jobs.list())).not.toContain(
            providerSecret,
          );
        }
      const project = await f.store.read();
      const rejected = await client.callTool({
        name: "generate_narration",
        arguments: {
          projectPath: f.projectPath,
          ...generationInput(project, "narration", f.sourceMediaId),
          text: providerSecret,
        },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).not.toContain(providerSecret);
      expect((await f.store.read()).revision).toBe(project.revision);
      const catalog = await f.call(client, "list_generated_artifacts", {
        projectPath: f.projectPath,
      });
      expect(JSON.stringify(catalog)).not.toContain(providerSecret);
      expect(await secretFiles(f.root)).toEqual([]);
      for (const route of [
        "/api/generated?projectPath=" + encodeURIComponent(f.projectPath),
        "/api/jobs",
        "/api/providers",
      ]) {
        const response = await fetch(f.gateway.origin + route, {
          headers: { authorization: "Bearer " + uiToken },
        });
        expect(await response.text()).not.toContain(providerSecret);
      }
    } finally {
      await f.close();
    }
  },
  120000,
);

integration(
  "caption region completion preserves an outside caption edited while the provider was pending and reverts through fresh sessions",
  async () => {
    const f = await generationFixture();
    try {
      let client = await f.client(),
        project = await f.store.read();
      const generated = await f.call(client, "generate_captions", {
        projectPath: f.projectPath,
        ...generationInput(project, "captions", f.sourceMediaId),
        autoActivate: true,
      });
      await f.done(generated.job.id);
      project = await f.store.read();
      const artifact = project.generatedArtifacts[0]!,
        cue = project.sequences[0]!.captions[0]!;
      expect(artifact.activeVersionId).toBe(generated.versionId);
      f.mode = "hold";
      const regenerated = await f.call(
        client,
        "regenerate_generated_artifact",
        {
          projectPath: f.projectPath,
          expectedRevision: project.revision,
          artifactId: artifact.id,
          parentVersionId: generated.versionId,
          region: {
            offsetTick: secondsToTicks(1),
            durationTick: secondsToTicks(1),
          },
        },
      );
      await until(
        () =>
          f.calls.filter((c) => c.url.includes("speech-to-text")).length === 2,
      );
      await client.close();
      client = await f.client("legacy");
      project = await f.store.read();
      await f.call(client, "apply_timeline_transaction", {
        projectPath: f.projectPath,
        expectedRevision: project.revision,
        commands: [
          {
            type: "caption.update",
            sequenceId: project.sequences[0]!.id,
            captionId: cue.id,
            patch: { text: "Human caption outside the region" },
          },
          { type: "project.rename", name: "Keep this human project name" },
        ],
      });
      f.mode = "ok";
      f.release();
      await f.done(regenerated.job.id);
      project = await f.store.read();
      expect(
        project.generatedArtifacts[0]!.versions[1]!.output!.captions!.find(
          (c) => c.id === cue.id,
        )!.text,
      ).toBe("Human caption outside the region");
      for (const versionId of [
        regenerated.versionId,
        generated.versionId,
        regenerated.versionId,
      ]) {
        project = await f.store.read();
        await f.call(client, "apply_timeline_transaction", {
          projectPath: f.projectPath,
          expectedRevision: project.revision,
          commands: [
            {
              type: "generation.version.activate",
              artifactId: artifact.id,
              versionId,
            },
          ],
        });
        project = await f.store.read();
        expect(project.name).toBe("Keep this human project name");
        expect(
          project.sequences[0]!.captions.find((c) => c.id === cue.id)!.text,
        ).toBe("Human caption outside the region");
        expect(project.sequences[0]!.captions).toHaveLength(
          versionId === generated.versionId ? 1 : 2,
        );
      }
    } finally {
      f.release();
      await f.close();
    }
  },
  60000,
);
integration(
  "actual generated animation partial activation and every-version revert retain clip transforms and unrelated audio after reconnecting",
  async () => {
    const f = await generationFixture();
    try {
      let client = await f.client(),
        project = await f.store.read();
      const generated = await f.call(client, "generate_animation", {
        projectPath: f.projectPath,
        ...generationInput(project, "animation", f.sourceMediaId),
        autoActivate: true,
      });
      await f.done(generated.job.id);
      project = await f.store.read();
      const sequence = project.sequences[0]!,
        clip = sequence.clips[0]!,
        unrelated = defaultClip(
          sequence.tracks.find((t) => t.type === "audio")!.id,
          { type: "media", mediaId: f.sourceMediaId },
          "Human audio elsewhere",
          secondsToTicks(1),
        );
      unrelated.startTick = secondsToTicks(10);
      await f.call(client, "apply_timeline_transaction", {
        projectPath: f.projectPath,
        expectedRevision: project.revision,
        commands: [
          {
            type: "clip.update",
            sequenceId: sequence.id,
            clipId: clip.id,
            patch: { transform: { ...clip.transform, opacity: 0.6 } },
          },
          {
            type: "clip.add",
            sequenceId: sequence.id,
            clip: unrelated,
            mode: "overwrite",
          },
        ],
      });
      await client.close();
      client = await f.client("legacy");
      project = await f.store.read();
      const regenerated = await f.call(
        client,
        "regenerate_generated_artifact",
        {
          projectPath: f.projectPath,
          expectedRevision: project.revision,
          artifactId: generated.artifactId,
          parentVersionId: generated.versionId,
          region: {
            offsetTick: secondsToTicks(1),
            durationTick: secondsToTicks(1),
          },
        },
      );
      await f.done(regenerated.job.id);
      for (const versionId of [
        regenerated.versionId,
        generated.versionId,
        regenerated.versionId,
      ]) {
        project = await f.store.read();
        await f.call(client, "apply_timeline_transaction", {
          projectPath: f.projectPath,
          expectedRevision: project.revision,
          commands: [
            {
              type: "generation.version.activate",
              artifactId: generated.artifactId,
              versionId,
            },
          ],
        });
        project = await f.store.read();
        const clips = project.sequences[0]!.clips.filter(
          (c) => c.id !== unrelated.id,
        );
        expect(clips).toHaveLength(3);
        expect(clips.every((c) => c.transform.opacity === 0.6)).toBe(true);
        expect(clips[0]!.source).toEqual(clip.source);
        expect(clips[2]!.source).toEqual(clip.source);
        expect(clips[1]!.source).toEqual(
          versionId === generated.versionId
            ? clip.source
            : {
                type: "animation",
                animationId:
                  project.generatedArtifacts[0]!.versions[1]!.output!
                    .segments![1]!.source.type === "animation"
                    ? (
                        project.generatedArtifacts[0]!.versions[1]!.output!
                          .segments![1]!.source as { animationId: string }
                      ).animationId
                    : "",
              },
        );
        expect(
          project.sequences[0]!.clips.find((c) => c.id === unrelated.id),
        ).toEqual(unrelated);
      }
    } finally {
      await f.close();
    }
  },
  60000,
);
