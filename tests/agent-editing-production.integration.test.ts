import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  secondsToTicks,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import {
  coreEditingFixture,
  verifyMinuteDelivery,
} from "./core-editing-fixture.js";
const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
integration(
  "modern author and fresh legacy reviewer assemble the same one-minute mixed-media editor fixture with durable linked edits and targeted conflict repair exclusively through MCP",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-agent-minute-")),
      projectPath = path.join(root, "projects", "minute"),
      tools: string[] = [],
      clients: Client[] = [];
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (p): p is [string, string] => typeof p[1] === "string",
        ),
      ),
      VIDEO_STUDIO_DATA_DIR: root,
      VIDEO_STUDIO_GATEWAY_PORT: "0",
    };
    const connect = async (mode: "auto" | "legacy") => {
      const client = new Client(
        { name: "agent-minute-" + mode, version: "1" },
        { versionNegotiation: { mode } },
      );
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.resolve(process.env.STUDIO_TEST_ENTRY ?? "dist/index.js"),
            "--stdio",
          ],
          env,
          stderr: "pipe",
        }),
      );
      clients.push(client);
      return client;
    };
    let author: Client;
    const call = async (
      name: string,
      args: Record<string, unknown> = {},
      client = author,
    ): Promise<Record<string, any>> => {
      const result = await client.callTool({ name, arguments: args }),
        body = result.structuredContent as Record<string, any>;
      expect(result.isError, JSON.stringify(body)).not.toBe(true);
      expect(body.success, JSON.stringify(body)).toBe(true);
      tools.push(name);
      return body;
    };
    const project = async (): Promise<StudioProject> =>
      (await call("get_project", { projectPath })).project;
    const edit = async (name: string, args: Record<string, unknown>) =>
      call(name, {
        projectPath,
        expectedRevision: (await project()).revision,
        ...args,
      });
    try {
      const inputs = await coreEditingFixture(root);
      author = await connect("auto");
      await call("create_project", {
        name: "Agent one-minute edit",
        projectPath,
      });
      for (const filePath of [inputs.video, inputs.audio, inputs.image])
        await edit("import_media", { filePath });
      let p = await project(),
        s = p.sequences[0]!,
        video = s.tracks.find((t) => t.type === "video")!,
        audio = s.tracks.find((t) => t.type === "audio")!;
      const videoMedia = p.media.find(
          (m) => m.name === path.basename(inputs.video),
        )!,
        audioMedia = p.media.find(
          (m) => m.name === path.basename(inputs.audio),
        )!,
        stillMedia = p.media.find(
          (m) => m.name === path.basename(inputs.image),
        )!;
      await edit("add_clip", {
        sequenceId: s.id,
        trackId: video.id,
        name: "Provided video",
        source: { type: "media", mediaId: videoMedia.id },
        startTick: 0,
        durationTick: secondsToTicks(36),
      });
      let first = (await project()).sequences[0]!.clips[0]!;
      await edit("trim_clip", {
        sequenceId: s.id,
        clipId: first.id,
        edge: "out",
        tick: secondsToTicks(30),
      });
      await edit("duplicate_clips", {
        sequenceId: s.id,
        clipIds: [first.id],
        offsetTick: secondsToTicks(30),
      });
      let second = (await project()).sequences[0]!.clips.find(
        (c) => c.startTick === secondsToTicks(30),
      )!;
      await edit("update_clip", {
        sequenceId: s.id,
        clipId: second.id,
        patch: {
          sourceInTick: secondsToTicks(1),
          name: "Revised second scene",
        },
      });
      await edit("add_transition", {
        sequenceId: s.id,
        transition: {
          id: "minute-cut",
          sequenceId: s.id,
          fromClipId: first.id,
          toClipId: second.id,
          type: "crossfade",
          durationTick: secondsToTicks(0.4),
          parameters: {},
        },
      });
      await edit("add_clip", {
        sequenceId: s.id,
        trackId: audio.id,
        name: "Provided music",
        source: { type: "media", mediaId: audioMedia.id },
        startTick: 0,
        durationTick: secondsToTicks(60),
      });
      await edit("update_track", {
        sequenceId: s.id,
        trackId: audio.id,
        patch: {
          gainDb: -12,
          effects: [
            {
              id: "music-highpass",
              type: "highpass",
              enabled: true,
              version: 1,
              parameters: { frequency: 100 },
            },
          ],
        },
      });
      await edit("add_track", {
        sequenceId: s.id,
        trackType: "overlay",
        name: "Overlay 1",
      });
      p = await project();
      s = p.sequences[0]!;
      const overlay = s.tracks.find((t) => t.name === "Overlay 1")!;
      await edit("add_clip", {
        sequenceId: s.id,
        trackId: overlay.id,
        name: "Provided still",
        source: { type: "media", mediaId: stillMedia.id },
        startTick: secondsToTicks(15),
        durationTick: secondsToTicks(5),
      });
      p = await project();
      const music = p.sequences[0]!.clips.find(
          (c) => c.name === "Provided music",
        )!,
        still = p.sequences[0]!.clips.find((c) => c.name === "Provided still")!;
      await edit("group_clips", {
        sequenceId: s.id,
        clipIds: [first.id, music.id],
        groupId: "editorial-pair",
      });
      await edit("link_clips", {
        sequenceId: s.id,
        clipIds: [first.id, music.id],
        linkedGroupId: "av-pair",
      });
      const beforeSplit = (await project()).sequences[0]!;
      await edit("split_clip", {
        sequenceId: s.id,
        clipId: first.id,
        atTick: secondsToTicks(15),
        rightClipId: "video-right",
      });
      const split = (await project()).sequences[0]!;
      expect(split.clips.filter((c) => c.trackId === audio.id)).toHaveLength(2);
      expect(split.clips.filter((c) => c.trackId === video.id)).toHaveLength(3);
      await edit("undo", {});
      expect((await project()).sequences[0]).toEqual(beforeSplit);
      await edit("redo", {});
      expect((await project()).sequences[0]).toEqual(split);
      const marker = {
        id: "minute-review",
        tick: secondsToTicks(15),
        durationTick: secondsToTicks(5),
        label: "Review overlay",
        color: "#55ccff",
      };
      await edit("add_marker", { sequenceId: s.id, marker });
      p = await project();
      const reviewer = await connect("legacy");
      await call(
        "update_track",
        {
          projectPath,
          expectedRevision: p.revision,
          sequenceId: s.id,
          trackId: overlay.id,
          patch: { name: "Human-reviewed overlay" },
        },
        reviewer,
      );
      const stale = await author.callTool({
        name: "update_clip",
        arguments: {
          projectPath,
          expectedRevision: p.revision,
          sequenceId: s.id,
          clipId: still.id,
          patch: { transform: { ...still.transform, opacity: 0.8 } },
        },
      });
      expect(stale.isError).toBe(true);
      expect(JSON.stringify(stale.structuredContent)).toContain(
        "REVISION_CONFLICT",
      );
      const beforeRepair = await project();
      await edit("update_clip", {
        sequenceId: s.id,
        clipId: still.id,
        patch: { transform: { ...still.transform, opacity: 0.8 } },
      });
      const final = await project(),
        finalSequence = final.sequences[0]!;
      expect(finalSequence.tracks.find((t) => t.id === overlay.id)!.name).toBe(
        "Human-reviewed overlay",
      );
      expect(finalSequence.clips.filter((c) => c.id !== still.id)).toEqual(
        beforeRepair.sequences[0]!.clips.filter((c) => c.id !== still.id),
      );
      expect(finalSequence.markers).toContainEqual(marker);
      expect(
        Math.max(
          ...finalSequence.clips.map((c) => c.startTick + c.durationTick),
        ),
      ).toBe(secondsToTicks(60));
      expect(final.media.map((m) => m.kind).sort()).toEqual([
        "audio",
        "image",
        "video",
      ]);
      await author.close();
      author = await connect("legacy");
      expect(await project()).toEqual(final);
      await edit("undo", {});
      expect(
        (await project()).sequences[0]!.clips.find((c) => c.id === still.id)!
          .transform.opacity,
      ).toBe(1);
      await edit("redo", {});
      expect((await project()).sequences[0]).toEqual(finalSequence);

      // Complete the same minute benchmark through public tools, including a real
      // measured caption defect and its targeted repair before final delivery.
      await edit("add_title", {
        sequenceId: s.id,
        trackId: overlay.id,
        text: "One minute production",
        startTick: 0,
        durationTick: secondsToTicks(4),
        fontSize: 90,
        color: "#ffffff",
      });
      const animation = (await project()).animations.at(-1)!;
      expect(animation.operations.length).toBeGreaterThan(0);
      await edit("add_caption", {
        sequenceId: s.id,
        trackId: s.tracks.find((t) => t.type === "caption")!.id,
        startTick: secondsToTicks(5),
        durationTick: secondsToTicks(3),
        text: "One minute production reviewed",
        style: {
          fontFamily: "Arial",
          fontSize: 500,
          color: "#ffffff",
          background: "#000000aa",
          position: "bottom",
          align: "center",
        },
      });
      const caption = (await project()).sequences[0]!.captions.at(-1)!;
      const broken = await call("inspect_caption_layout", {
        projectPath,
        sequenceId: s.id,
      });
      expect(broken.complete).toBe(true);
      expect(
        broken.measurements.some(
          (item: any) => item.overflow || item.outsideSafeArea,
        ),
      ).toBe(true);
      await edit("update_caption", {
        sequenceId: s.id,
        captionId: caption.id,
        patch: { style: { ...caption.style, fontSize: 54 } },
      });
      const repaired = await call("inspect_caption_layout", {
        projectPath,
        sequenceId: s.id,
      });
      expect(repaired.complete).toBe(true);
      expect(
        repaired.measurements.every(
          (item: any) => !item.overflow && !item.outsideSafeArea,
        ),
      ).toBe(true);
      await edit("set_audio_master", {
        sequenceId: s.id,
        master: {
          gainDb: 0,
          pan: 0,
          effects: [
            {
              id: "minute-loudness",
              type: "loudness",
              enabled: true,
              version: 1,
              parameters: { targetLufs: -16, truePeakDb: -1.5, rangeLu: 7 },
            },
          ],
        },
      });
      const done = async (id: string) => {
        const deadline = Date.now() + 600000;
        while (Date.now() < deadline) {
          const { job } = await call("get_job", { jobId: id });
          if (job.status === "completed") return job.result;
          if (["failed", "cancelled"].includes(job.status))
            throw new Error(JSON.stringify(job));
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error("Minute production job exceeded ten-minute deadline");
      };
      const output = path.join(root, "agent-minute.mp4"),
        render = await done(
          (
            await call("render_sequence", {
              projectPath,
              sequenceId: s.id,
              presetId: "web-h264-1080p",
              outputPath: output,
            })
          ).job.id,
        );
      expect(render.frameCount).toBe(1800);
      const qc = await done(
        (
          await call("run_qc", {
            projectPath,
            sequenceId: s.id,
            filePath: output,
          })
        ).job.id,
      );
      expect(
        qc.checks.find((item: any) => item.id === "video.frames"),
      ).toMatchObject({ status: "PASS", observed: { frames: 1800 } });
      expect(qc.passed, JSON.stringify(qc)).toBe(true);
      expect(
        qc.checks.filter((item: any) => item.status !== "PASS"),
        JSON.stringify(qc.checks),
      ).toEqual([]);
      const delivery = await verifyMinuteDelivery(root, output),
        delivered = await project();
      await author.close();
      author = await connect("auto");
      expect(await project()).toEqual(delivered);
      const report = {
        workflow: "agent-minute-delivery",
        projectPath,
        output,
        revision: delivered.revision,
        delivery,
        checks: qc.checks,
        captionDefectRepaired: true,
        titleAndAnimation: true,
        linkedSplit: true,
        durableUndoRedo: true,
        conflictRejected: true,
        unrelatedReviewPreserved: true,
        protocols: ["2026-07-28", "2025-11-25"],
        tools: [...new Set(tools)],
      };
      if (process.env.MINUTE_ACCEPTANCE_EVIDENCE)
        await writeFile(
          path.join(
            process.env.MINUTE_ACCEPTANCE_EVIDENCE,
            "agent-minute.json",
          ),
          JSON.stringify(report, null, 2),
        );
      console.log("AGENT_MINUTE_ACCEPTANCE", JSON.stringify(report));
    } finally {
      for (const client of clients) await client.close().catch(() => undefined);
      if (!process.env.MINUTE_ACCEPTANCE_KEEP)
        await rm(root, { recursive: true, force: true });
    }
  },
  900000,
);
