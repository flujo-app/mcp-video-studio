import { mkdtemp, rm, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  defaultClip,
  secondsToTicks,
  type StudioProject,
  type JobRecord,
} from "@mcp-video-studio/contracts";
import { loadConfig, runChecked } from "@mcp-video-studio/media";
import { prepareTransitionTimeline } from "@mcp-video-studio/core";
import { StudioRuntime } from "../packages/server/src/runtime.js";
import { startGateway } from "../packages/server/src/gateway.js";
import { startMcpHttp } from "../packages/server/src/http.js";
const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
for (const mode of ["auto", "legacy"] as const)
  integration(
    "actual " +
      mode +
      " MCP retiming keeps linked clips, handles, automation, revision conflicts and durable undo",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "studio-retime-wire-")),
        token = "retime-fixture-0123456789-0123456789";
      const runtime = new StudioRuntime({
        ...loadConfig({
          ...process.env,
          VIDEO_STUDIO_DATA_DIR: root,
          VIDEO_STUDIO_GATEWAY_PORT: "0",
          VIDEO_STUDIO_MCP_TOKEN: token,
        }),
        maxConcurrentJobs: 1,
      });
      await runtime.initialize();
      const gateway = await startGateway(
          runtime,
          "retime-editor-fixture-0123456789-0123456789",
        ),
        http = await startMcpHttp(runtime, gateway, 0, "127.0.0.1");
      let client = new Client(
        { name: "retime-contract", version: "1" },
        { versionNegotiation: { mode } },
      );
      const connect = async () =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(http.url), {
            requestInit: { headers: { authorization: "Bearer " + token } },
          }),
        );
      try {
        await connect();
        const call = async (
          name: string,
          args: Record<string, unknown> = {},
        ) => {
          const result = await client.callTool({ name, arguments: args });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          return result.structuredContent as Record<string, unknown>;
        };
        const created = await call("create_project", { name: "Retime wire" }),
          projectPath = created.projectPath as string;
        const get = async () =>
          (await call("get_project", { projectPath })).project as StudioProject;
        let project = await get();
        await runtime.store(projectPath).replace(
          project.revision,
          (p) => {
            p.settings.fps = { numerator: 10, denominator: 1 };
            p.settings.raster = { width: 160, height: 90 };
          },
          {
            sequences: [],
            tracks: [],
            clips: [],
            media: [],
            animations: [],
            generatedArtifacts: [],
          },
        );
        const input = path.join(root, "source.mkv");
        await runChecked(runtime.config.ffmpegPath, [
          "-hide_banner",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=s=160x90:r=10:d=10",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000:duration=10",
          "-c:v",
          "ffv1",
          "-c:a",
          "pcm_f32le",
          "-ac",
          "2",
          input,
        ]);
        project = await get();
        await call("import_media", {
          projectPath,
          expectedRevision: project.revision,
          filePath: input,
          storageMode: "managed",
        });
        await expect
          .poll(
            () =>
              runtime.jobs
                .list()
                .every((j) =>
                  ["completed", "failed", "cancelled"].includes(j.status),
                ),
            { timeout: 30000 },
          )
          .toBe(true);
        project = await get();
        const sequence = project.sequences[0]!,
          media = project.media[0]!,
          videoTrack = sequence.tracks.find((t) => t.type === "video")!,
          audioTrack = sequence.tracks.find((t) => t.type === "audio")!;
        const video = defaultClip(
            videoTrack.id,
            { type: "media", mediaId: media.id },
            "Linked video",
            secondsToTicks(2),
          ),
          audio = defaultClip(
            audioTrack.id,
            { type: "media", mediaId: media.id },
            "Linked audio",
            secondsToTicks(2),
          ),
          next = defaultClip(
            videoTrack.id,
            { type: "media", mediaId: media.id },
            "Following video",
            secondsToTicks(2),
          );
        for (const clip of [video, audio]) {
          clip.sourceInTick = secondsToTicks(2);
          clip.linkedGroupId = "linked-retime";
          clip.groupId = "group-retime";
        }
        video.audio.muted = true;
        next.startTick = secondsToTicks(2);
        next.sourceInTick = secondsToTicks(5);
        await call("apply_timeline_transaction", {
          projectPath,
          expectedRevision: project.revision,
          commands: [
            ...[video, audio, next].map((clip) => ({
              type: "clip.add",
              sequenceId: sequence.id,
              clip,
              mode: "overwrite",
            })),
            {
              type: "automation.set",
              sequenceId: sequence.id,
              lane: {
                id: "retime-gain",
                sequenceId: sequence.id,
                target: "clip:" + audio.id + ":gainDbOffset",
                enabled: true,
                points: [
                  { tick: 0, value: -6, curve: "linear" },
                  { tick: secondsToTicks(2), value: 0, curve: "linear" },
                ],
              },
            },
            {
              type: "transition.add",
              sequenceId: sequence.id,
              transition: {
                id: "retime-transition",
                sequenceId: sequence.id,
                parameters: {},
                fromClipId: video.id,
                toClipId: next.id,
                type: "crossfade",
                durationTick: secondsToTicks(0.4),
              },
            },
          ],
        });
        const baseline = await get(),
          baseSequence = baseline.sequences[0]!,
          snapshot = JSON.stringify(baseSequence);
        const wait = async (id: string) => {
          let job: JobRecord | undefined;
          await expect
            .poll(
              async () => {
                job = (await call("get_job", { jobId: id })).job as JobRecord;
                return job.status;
              },
              { timeout: 60000, interval: 50 },
            )
            .toMatch(/^(completed|failed|cancelled)$/);
          return job!;
        };
        for (const options of [
          { mode: "reverse" },
          { mode: "freeze", freezeAtTick: secondsToTicks(0.5) },
          { mode: "linear-ramp", startRate: 0.5, endRate: 1.5 },
        ]) {
          project = await get();
          const result = await call("retime_clip", {
              projectPath,
              expectedRevision: project.revision,
              sequenceId: sequence.id,
              clipId: video.id,
              ...options,
            }),
            job = await wait((result.job as JobRecord).id);
          expect(job.status, JSON.stringify(job)).toBe("completed");
          const after = await get(),
            current = after.sequences[0]!;
          expect(after.revision).toBe(project.revision + 1);
          expect(after.media.length).toBe(baseline.media.length + 2);
          expect(current.automation).toEqual(baseSequence.automation);
          expect(current.transitions).toEqual(baseSequence.transitions);
          expect(current.clips.find((c) => c.id === next.id)).toEqual(
            baseSequence.clips.find((c) => c.id === next.id),
          );
          for (const id of [video.id, audio.id]) {
            const original = baseSequence.clips.find((c) => c.id === id)!,
              changed = current.clips.find((c) => c.id === id)!;
            const {
              source: _,
              sourceInTick: __,
              playbackRate: ___,
              ...rest
            } = changed;
            const {
              source: _o,
              sourceInTick: __o,
              playbackRate: ___o,
              ...originalRest
            } = original;
            expect(rest).toEqual(originalRest);
            expect(changed.source).not.toEqual(original.source);
            const derived = after.media.find(
              (m) =>
                changed.source.type === "media" &&
                m.id === changed.source.mediaId,
            )!;
            expect(derived.retiming?.sourceSha256).toBe(media.storage.sha256);
          }
          expect(() => prepareTransitionTimeline(after, current)).not.toThrow();
          await client.close();
          client = new Client(
            { name: "retime-reopen", version: "1" },
            { versionNegotiation: { mode } },
          );
          await connect();
          expect((await get()).sequences[0]).toEqual(current);
          await call("undo", { projectPath, expectedRevision: after.revision });
          project = await get();
          expect(JSON.stringify(project.sequences[0])).toBe(snapshot);
          expect(project.media).toEqual(baseline.media);
          await call("redo", {
            projectPath,
            expectedRevision: project.revision,
          });
          project = await get();
          expect(project.sequences[0]).toEqual(current);
          await call("undo", {
            projectPath,
            expectedRevision: project.revision,
          });
        }
        // A real queued operation sees a later public edit and fails atomically.
        let release!: () => void;
        const fence = new Promise<void>((resolve) => {
          release = resolve;
        });
        await runtime.jobs.enqueue(
          "media",
          "Fixture queue boundary",
          async () => {
            await fence;
            return {};
          },
        );
        project = await get();
        const conflict = await call("retime_clip", {
          projectPath,
          expectedRevision: project.revision,
          sequenceId: sequence.id,
          clipId: video.id,
          mode: "reverse",
        });
        await call("update_clip", {
          projectPath,
          expectedRevision: project.revision,
          sequenceId: sequence.id,
          clipId: video.id,
          patch: { name: "Human edit while queued" },
        });
        const human = await get();
        release();
        const failed = await wait((conflict.job as JobRecord).id);
        expect(failed.status).toBe("failed");
        expect(failed.error?.code).toBe("REVISION_CONFLICT");
        expect(await get()).toEqual(human);
        // Cancellation returns only after the owned renderer/scratch have settled.
        const cancel = await call("retime_clip", {
          projectPath,
          expectedRevision: human.revision,
          sequenceId: sequence.id,
          clipId: video.id,
          mode: "reverse",
        });
        await call("cancel_job", { jobId: (cancel.job as JobRecord).id });
        expect((await wait((cancel.job as JobRecord).id)).status).toBe(
          "cancelled",
        );
        expect(await get()).toEqual(human);
        expect(
          (await readdir(runtime.config.scratchDir).catch(() => [])).filter(
            (name) => name.startsWith("retiming-"),
          ),
        ).toEqual([]);
      } finally {
        await client.close();
        await http.close();
        await gateway.close();
        await runtime.jobs.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    180000,
  );
