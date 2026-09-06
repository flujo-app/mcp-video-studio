import path from "node:path";
import { readFile, writeFile, readdir, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  defaultClip,
  secondsToTicks,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { sha256File } from "@mcp-video-studio/core";
import { mediaPath, runChecked } from "@mcp-video-studio/media";
import { generationFixture, until } from "./generation-fixture.js";
import {
  getExportHistory,
  queueExport,
  listExportHistory,
} from "../packages/server/src/provenance.js";
const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
integration(
  "modern/legacy MCP reproduces the saved snapshot after edits, verifies inputs before cache reuse, and preserves existing output on failure",
  async () => {
    const f = await generationFixture();
    try {
      let project = await f.store.read();
      const seq = project.sequences[0]!,
        audio = defaultClip(
          seq.tracks.find((t) => t.type === "audio")!.id,
          { type: "media", mediaId: f.sourceMediaId },
          "Saved original",
          secondsToTicks(1),
        );
      audio.audio.gainDb = -8;
      await f.store.mutate(project.revision, [
        {
          type: "clip.add",
          sequenceId: seq.id,
          clip: audio,
          mode: "overwrite",
        },
      ]);
      project = await f.store.read();
      const preset = project.exportPresets.find((p) => p.container === "wav")!,
        modern = await f.client(),
        legacy = await f.client("legacy"),
        output = path.join(f.root, "original.wav");
      const queued = await f.call(modern, "render_sequence", {
        projectPath: f.projectPath,
        sequenceId: seq.id,
        presetId: preset.id,
        outputPath: output,
      });
      const done = await f.done(queued.job.id),
        first = await readFile(output);
      expect(done.result?.exportId).toBe(queued.exportId);
      const record = (await getExportHistory(f.config, queued.exportId)).export;
      expect(record.status).toBe("completed");
      expect(record.projectSnapshot).toEqual(project);
      expect(record.sourceHashes?.[f.sourceMediaId]).toMatch(/^[a-f0-9]{64}$/);
      expect(record.engine?.ffmpeg).toContain("ffmpeg version");
      await f.store.mutate(project.revision, [
        {
          type: "clip.update",
          sequenceId: seq.id,
          clipId: audio.id,
          patch: { audio: { ...audio.audio, gainDb: -24 } },
        },
      ]);
      const edited = await f.store.read();
      const current = await f.runtime.render({
        projectPath: f.projectPath,
        sequenceId: seq.id,
        presetId: preset.id,
        outputPath: path.join(f.root, "edited.wav"),
      });
      await f.done((current.job as { id: string }).id);
      expect(await readFile(path.join(f.root, "edited.wav"))).not.toEqual(
        first,
      );
      const reproduced = path.join(f.root, "reproduced.wav"),
        again = await f.call(legacy, "reproduce_export", {
          projectPath: f.projectPath,
          exportId: queued.exportId,
          outputPath: reproduced,
        });
      const replay = await f.done(again.job.id);
      expect(replay.result?.cacheHit).toBe(true);
      expect(await readFile(reproduced)).toEqual(first);
      expect(await f.store.read()).toEqual(edited);
      const history = await f.call(modern, "list_export_history", {
        projectPath: f.projectPath,
      });
      expect(history.exports).toHaveLength(3);
      expect(
        history.exports.every(
          (r: Record<string, unknown>) => !("projectSnapshot" in r),
        ),
      ).toBe(true);
      const asset = project.media.find((m) => m.id === f.sourceMediaId)!,
        source = mediaPath(f.store, asset),
        bytes = await readFile(source);
      await writeFile(source, Buffer.concat([bytes, Buffer.from("changed")]));
      const sentinel = Buffer.from("preserve previous export");
      await writeFile(reproduced, sentinel);
      const bad = await f.call(modern, "reproduce_export", {
        projectPath: f.projectPath,
        exportId: queued.exportId,
        outputPath: reproduced,
      });
      await until(() => f.runtime.jobs.get(bad.job.id)?.status === "failed");
      expect(f.runtime.jobs.get(bad.job.id)?.error?.code).toBe(
        "HISTORICAL_SOURCE_CHANGED",
      );
      expect(await readFile(reproduced)).toEqual(sentinel);
      await writeFile(source, bytes);
      await expect(
        f.runtime.render({
          projectPath: f.projectPath,
          sequenceId: seq.id,
          presetId: preset.id,
          outputPath: path.join(f.projectPath, "project.json"),
        }),
      ).rejects.toMatchObject({ studio: { code: "PROTECTED_EXPORT_PATH" } });
      const saved = path.join(
          f.config.dataDir,
          "render-operations",
          queued.exportId + ".json",
        ),
        tampered = JSON.parse(await readFile(saved, "utf8"));
      tampered.engine.ffmpeg += "changed engine";
      await writeFile(saved, JSON.stringify(tampered));
      const mismatch = await queueExport(f.runtime, {
        projectPath: f.projectPath,
        sequenceId: "",
        presetId: "",
        reproduceId: queued.exportId,
        outputPath: reproduced,
      });
      await until(
        () =>
          f.runtime.jobs.get((mismatch.job as { id: string }).id)?.status ===
          "failed",
      );
      expect(
        f.runtime.jobs.get((mismatch.job as { id: string }).id)?.error?.code,
      ).toBe("HISTORICAL_ENGINE_CHANGED");
      expect(await readFile(reproduced)).toEqual(sentinel);
    } finally {
      await f.close();
    }
  },
  120000,
);
integration(
  "queued rendering pins the snapshot before another edit and nested sequence rendering reads the same saved revision",
  async () => {
    const f = await generationFixture();
    let release = () => {};
    try {
      let project = await f.store.read();
      const seq = project.sequences[0]!,
        preset = project.exportPresets.find((p) => p.container === "wav")!,
        clip = defaultClip(
          seq.tracks.find((t) => t.type === "audio")!.id,
          { type: "media", mediaId: f.sourceMediaId },
          "Nested source",
          secondsToTicks(1),
        );
      await f.store.mutate(project.revision, [
        { type: "clip.add", sequenceId: seq.id, clip, mode: "overwrite" },
      ]);
      project = await f.store.read();
      const parent = structuredClone(seq);
      parent.id = "parent-export";
      parent.name = "Parent export";
      parent.clips = [
        defaultClip(
          parent.tracks.find((t) => t.type === "audio")!.id,
          { type: "sequence", sequenceId: seq.id },
          "Nested original",
          secondsToTicks(1),
        ),
      ];
      parent.tracks = parent.tracks.map((t, i) => ({
        ...t,
        id: "parent-track-" + i,
        sequenceId: parent.id,
      }));
      parent.clips[0]!.trackId = parent.tracks.find(
        (t) => t.type === "audio",
      )!.id;
      await f.store.replace(
        project.revision,
        (draft) => {
          draft.sequences.push(parent);
        },
        {
          sequences: [parent.id],
          tracks: [],
          clips: [],
          media: [],
          animations: [],
          generatedArtifacts: [],
        },
      );
      project = await f.store.read();
      const held = await f.runtime.jobs.enqueue(
        "render",
        "Hold export queue",
        async () => {
          await new Promise<void>((r) => (release = r));
          return {};
        },
      );
      await until(() => f.runtime.jobs.get(held.id)?.status === "running");
      const pending = await f.runtime.render({
        projectPath: f.projectPath,
        sequenceId: parent.id,
        presetId: preset.id,
        outputPath: path.join(f.root, "snapshot.wav"),
      });
      await f.store.mutate(project.revision, [
        {
          type: "clip.update",
          sequenceId: seq.id,
          clipId: clip.id,
          patch: { audio: { ...clip.audio, gainDb: -30 } },
        },
      ]);
      release();
      const rendered = await f.done((pending.job as { id: string }).id);
      expect(rendered.result?.revision).toBe(project.revision);
      const data = await runChecked(f.config.ffmpegPath, [
        "-v",
        "error",
        "-i",
        String(rendered.result?.outputPath),
        "-f",
        "null",
        "-",
      ]);
      expect(data.exitCode).toBe(0);
      expect((await f.store.read()).revision).toBe(project.revision + 1);
    } finally {
      release();
      await f.close();
    }
  },
  120000,
);
