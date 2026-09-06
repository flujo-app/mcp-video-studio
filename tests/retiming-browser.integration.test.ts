import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { chromium } from "patchright";
import axe from "axe-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  framesToTicks,
  secondsToTicks,
  type StudioProject,
  type JobRecord,
} from "@mcp-video-studio/contracts";
import { ProjectStore } from "@mcp-video-studio/core";
import { loadConfig, runChecked } from "@mcp-video-studio/media";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
const integration =
  process.env.RUN_BROWSER_INTEGRATION === "1" &&
  process.env.RUN_FFMPEG_INTEGRATION === "1"
    ? it
    : it.skip;
integration(
  "bundled Studio retimes reverse, freeze and fractional-rate ramps with UI undo, export and reopen",
  async () => {
    const root = await mkdtemp(
        path.join(os.tmpdir(), "studio-retime-browser-"),
      ),
      projectPath = path.join(root, "project"),
      config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root }),
      input = path.join(root, "source.mkv");
    await runChecked(config.ffmpegPath, [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=320x180:r=30:d=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=6",
      "-c:v",
      "ffv1",
      "-c:a",
      "pcm_f32le",
      "-ac",
      "2",
      input,
    ]);
    const client = new Client(
        { name: "retiming-browser", version: "1" },
        { versionNegotiation: { mode: "auto" } },
      ),
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          path.resolve(process.env.STUDIO_TEST_ENTRY ?? "dist/index.js"),
          "--stdio",
        ],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (pair): pair is [string, string] => typeof pair[1] === "string",
            ),
          ),
          VIDEO_STUDIO_DATA_DIR: root,
          VIDEO_STUDIO_GATEWAY_PORT: "0",
        },
        stderr: "pipe",
      });
    const browser = await chromium.launch({
        headless: true,
        env: browserEnvironment(),
      }),
      page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return result.structuredContent as Record<string, any>;
    };
    const get = async () =>
      (await call("get_project", { projectPath })).project as StudioProject;
    const done = async (id: string) => {
      let job: JobRecord | undefined;
      await expect
        .poll(
          async () => {
            job = (await call("get_job", { jobId: id })).job;
            return job!.status;
          },
          { timeout: 90000, interval: 100 },
        )
        .toMatch(/^(completed|failed|cancelled)$/);
      expect(job!.status, JSON.stringify(job)).toBe("completed");
      return job!.result!;
    };
    try {
      await client.connect(transport);
      await call("create_project", {
        name: "Fractional retiming",
        projectPath,
      });
      await new ProjectStore(projectPath).replace(
        0,
        (project) => {
          project.settings.raster = { width: 320, height: 180 };
          project.settings.fps = { numerator: 30000, denominator: 1001 };
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
      await call("import_media", {
        projectPath,
        expectedRevision: 1,
        filePath: input,
        storageMode: "managed",
      });
      let project = await get(),
        sequence = project.sequences[0]!,
        original = project.media[0]!;
      await call("add_clip", {
        projectPath,
        expectedRevision: project.revision,
        sequenceId: sequence.id,
        trackId: sequence.tracks.find((t) => t.type === "video")!.id,
        name: "Frame-timed clip",
        source: { type: "media", mediaId: original.id },
        startTick: 0,
        sourceInTick: secondsToTicks(1),
        durationTick: framesToTicks(60, project.settings.fps),
      });
      project = await get();
      const clip = project.sequences[0]!.clips[0]!,
        baseline = structuredClone(clip);
      const opened = await call("open_studio"),
        url = new URL(opened.studioUrl);
      url.searchParams.set("projectPath", projectPath);
      await page.goto(url.toString());
      await page.getByText("Project loaded", { exact: true }).waitFor();
      for (const mode of ["reverse", "freeze", "linear-ramp"]) {
        project = await get();
        await page
          .locator(".timeline-clip")
          .filter({ hasText: "Frame-timed clip" })
          .press("Enter");
        try {
          await page
            .getByLabel("Retiming mode", { exact: true })
            .selectOption(mode);
        } catch (error) {
          throw new Error(
            "Retime controls missing: " +
              (await page.locator("body").innerText()).slice(-12000),
            { cause: error },
          );
        }
        if (mode === "freeze")
          await page
            .getByLabel("Freeze position in clip (seconds)", { exact: true })
            .fill("0.5");
        if (mode === "linear-ramp") {
          await page
            .getByLabel("Ramp start speed", { exact: true })
            .fill("0.5");
          await page.getByLabel("Ramp end speed", { exact: true }).fill("1.5");
        }
        const response = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/features/retime_clip" &&
            response.request().method() === "POST",
        );
        await page
          .getByRole("button", { name: "Apply retiming", exact: true })
          .click();
        const queued = await (await response).json();
        expect(queued.success, JSON.stringify(queued)).toBe(true);
        await done(queued.job.id);
        await page
          .getByText(
            "Retimed at revision " +
              (project.revision + 1) +
              ". Undo restores the original clips.",
            { exact: true },
          )
          .waitFor();
        await page.waitForFunction(
          (revision) => document.body.textContent?.includes("rev " + revision),
          project.revision + 1,
        );
        await expect
          .poll(
            async () =>
              page
                .getByLabel("Source preview", { exact: true })
                .evaluate((element) => {
                  const video = element as HTMLVideoElement;
                  return (
                    video.readyState >= 2 &&
                    video.videoWidth > 0 &&
                    !video.error
                  );
                }),
            { timeout: 30000 },
          )
          .toBe(true);
        const after = await get(),
          derived = after.media.find((media) => media.retiming?.mode === mode)!;
        expect(derived).toBeTruthy();
        expect(after.sequences[0]!.clips[0]!.durationTick).toBe(
          baseline.durationTick,
        );
        expect(derived.retiming?.sourceSha256).toBe(original.storage.sha256);
        if (mode !== "linear-ramp") {
          await page.getByRole("button", { name: "Undo", exact: true }).click();
          await expect
            .poll(async () => (await get()).revision)
            .toBe(after.revision + 1);
          expect((await get()).sequences[0]!.clips[0]).toEqual(baseline);
          await page.waitForFunction(
            (revision) =>
              document.body.textContent?.includes("rev " + revision),
            after.revision + 1,
          );
        }
      }
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const output = path.join(root, "retimed.mp4");
      await page.getByLabel("Export output path", { exact: true }).fill(output);
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/render" &&
          response.status() === 202,
      );
      await page
        .getByRole("button", { name: "Queue render", exact: true })
        .click();
      const queued = await (await response).json();
      await done(queued.job.id);
      const probe = JSON.parse(
        (
          await runChecked(config.ffprobePath, [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames,r_frame_rate",
            "-of",
            "json",
            output,
          ])
        ).stdout,
      );
      expect(Number(probe.streams[0].nb_read_frames)).toBe(60);
      expect(probe.streams[0].r_frame_rate).toBe("30000/1001");
      const saved = await get();
      await page.reload();
      await page.getByText("Project loaded", { exact: true }).waitFor();
      expect(await get()).toEqual(saved);
      await page
        .locator(".timeline-clip")
        .filter({ hasText: "Frame-timed clip" })
        .press("Enter");
      await page.evaluate(axe.source);
      const violations = await page.evaluate(
        async () =>
          (
            await (window as any).axe.run(document, {
              runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
            })
          ).violations,
      );
      expect(violations).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180000,
);
