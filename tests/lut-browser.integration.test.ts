import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { it, expect } from "vitest";
import { chromium } from "patchright";
import axe from "axe-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  secondsToTicks,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
import { loadConfig, runChecked } from "@mcp-video-studio/media";
import { presentedVideoFrame } from "./presented-video-frame.js";
const integration =
  process.env.RUN_FFMPEG_INTEGRATION === "1" &&
  process.env.RUN_BROWSER_INTEGRATION === "1"
    ? it
    : it.skip;
integration(
  "human imports and applies a portable LUT, sees real program pixels, and a fresh legacy MCP session safely revises the saved effect",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-lut-browser-")),
      projectPath = path.join(root, "project"),
      clients: Client[] = [];
    const browser = await chromium.launch({
      headless: true,
      env: browserEnvironment(),
    });
    const connect = async (mode: "auto" | "legacy") => {
      const client = new Client(
        { name: "lut-browser-" + mode, version: "1" },
        { versionNegotiation: { mode } },
      );
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            path.resolve(process.env.STUDIO_TEST_ENTRY ?? "dist/index.js"),
            "--stdio",
          ],
          env: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (e): e is [string, string] => typeof e[1] === "string",
              ),
            ),
            VIDEO_STUDIO_DATA_DIR: root,
            VIDEO_STUDIO_GATEWAY_PORT: "0",
          },
          stderr: "pipe",
        }),
      );
      clients.push(client);
      return client;
    };
    const call = async (
      client: Client,
      name: string,
      args: Record<string, unknown> = {},
    ) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
        true,
      );
      return result.structuredContent as Record<string, any>;
    };
    try {
      const modern = await connect("auto");
      await call(modern, "create_project", {
        name: "Human color finishing",
        projectPath,
      });
      let project = (await call(modern, "get_project", { projectPath }))
        .project as StudioProject;
      const seq = project.sequences[0]!;
      await call(modern, "add_clip", {
        projectPath,
        expectedRevision: project.revision,
        sequenceId: seq.id,
        trackId: seq.tracks.find((t) => t.type === "video")!.id,
        name: "Color sample",
        source: { type: "color", color: "#ff0000" },
        startTick: 0,
        durationTick: secondsToTicks(0.5),
      });
      const source = path.join(root, "Human invert.cube");
      await writeFile(
        source,
        "LUT_3D_SIZE 2\n" +
          Array.from({ length: 8 }, (_, i) =>
            [
              1 - (i % 2),
              1 - (Math.floor(i / 2) % 2),
              1 - Math.floor(i / 4),
            ].join(" "),
          ).join("\n") +
          "\n",
      );
      const { studioUrl } = await call(modern, "open_studio", { projectPath }),
        page = await browser.newPage({
          viewport: { width: 1500, height: 1100 },
        });
      page.setDefaultTimeout(20000);
      const url = new URL(studioUrl);
      url.searchParams.set("projectPath", projectPath);
      await page.goto(url.toString());
      await page.getByText("Project loaded", { exact: true }).waitFor();
      await page
        .getByLabel("Absolute media file path", { exact: true })
        .fill(source);
      const imported = page.waitForResponse(
        (r) => new URL(r.url()).pathname === "/api/import" && r.ok(),
      );
      await page
        .getByRole("button", { name: "Import media", exact: true })
        .click();
      await imported;
      await page.locator(".timeline-clip").first().press("Enter");
      await page
        .getByRole("button", { name: "Inspector", exact: true })
        .click();
      await page
        .getByLabel("New Clip video effect", { exact: true })
        .selectOption("lut3d");
      await page
        .getByRole("button", { name: "Add Clip video effect", exact: true })
        .click();
      await page.getByText("Saved revision 3", { exact: true }).waitFor();
      expect(
        await page.getByLabel("Color LUT", { exact: true }).inputValue(),
      ).toBe(
        (
          (await call(modern, "get_project", { projectPath }))
            .project as StudioProject
        ).media.find((m) => m.kind === "lut")!.id,
      );
      await page
        .getByLabel("LUT interpolation", { exact: true })
        .selectOption("trilinear");
      await page.getByText("Saved revision 4", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Build preview", exact: true })
        .click();
      await page.waitForFunction(() => {
        const video = document.querySelector(
          ".monitor video",
        ) as HTMLVideoElement | null;
        return video && video.readyState >= 2;
      });
      // Independently decode the exact HTTP preview, then capture a browser-presented
      // frame. A wrong encoded image or wrong browser pixel still fails strictly.
      const previewUrl = await page
        .locator(".monitor video")
        .evaluate((video: HTMLVideoElement) => video.currentSrc);
      const response = await page.request.get(previewUrl);
      expect(response.ok()).toBe(true);
      const previewFile = path.join(root, "downloaded-preview.mp4"),
        decodedFile = path.join(root, "preview-frame.rgba");
      await writeFile(previewFile, await response.body());
      const config = loadConfig({
        ...process.env,
        VIDEO_STUDIO_DATA_DIR: root,
      });
      await runChecked(config.ffmpegPath, [
        "-v",
        "error",
        "-i",
        previewFile,
        "-frames:v",
        "1",
        "-vf",
        "scale=32:18",
        "-pix_fmt",
        "rgba",
        "-f",
        "rawvideo",
        decodedFile,
      ]);
      const decoded = await readFile(decodedFile);
      expect(decoded.length).toBe(32 * 18 * 4);
      const encodedPixel = Array.from(
        decoded.subarray((9 * 32 + 16) * 4, (9 * 32 + 16) * 4 + 4),
      );
      expect(encodedPixel[0], JSON.stringify(encodedPixel)).toBeLessThan(15);
      expect(encodedPixel[1], JSON.stringify(encodedPixel)).toBeGreaterThan(
        235,
      );
      expect(encodedPixel[2], JSON.stringify(encodedPixel)).toBeGreaterThan(
        235,
      );
      expect(encodedPixel[3]).toBe(255);
      const capture = await presentedVideoFrame(
        page,
        ".monitor video",
        previewUrl,
        () =>
          page
            .getByRole("button", { name: "Play or pause", exact: true })
            .click(),
      );
      expect(capture.sourcePath).toBe("/preview");
      expect(capture.sourceRevision).toBe("4");
      expect(capture.presentedFrames).toBeGreaterThan(0);
      expect(capture.width).toBeGreaterThan(0);
      expect(capture.height).toBeGreaterThan(0);
      expect(capture.mediaTime).toBeGreaterThanOrEqual(0);
      expect(capture.mediaTime).toBeLessThan(0.5);
      const pixel = capture.pixels[0]!;
      expect(pixel[0], JSON.stringify(capture)).toBeLessThan(15);
      expect(pixel[1], JSON.stringify(capture)).toBeGreaterThan(235);
      expect(pixel[2], JSON.stringify(capture)).toBeGreaterThan(235);
      expect(pixel[3], JSON.stringify(capture)).toBe(255);
      await page.reload();
      await page.locator(".timeline-clip").first().waitFor();
      await page.locator(".timeline-clip").first().press("Enter");
      expect(
        await page
          .getByLabel("LUT interpolation", { exact: true })
          .inputValue(),
      ).toBe("trilinear");
      await page.evaluate(axe.source, undefined, false);
      const accessibility = await page.evaluate(
        async () =>
          await (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          }),
        undefined,
        false,
      );
      expect(
        accessibility.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
      ).toEqual([]);
      await browser.close();
      await modern.close();
      const legacy = await connect("legacy");
      project = (await call(legacy, "get_project", { projectPath })).project;
      const clip = project.sequences[0]!.clips[0]!,
        effect = clip.effects[0]!;
      expect(effect.parameters.interpolation).toBe("trilinear");
      await call(legacy, "update_clip", {
        projectPath,
        expectedRevision: project.revision,
        sequenceId: seq.id,
        clipId: clip.id,
        patch: {
          effects: [
            {
              ...effect,
              parameters: {
                ...effect.parameters,
                interpolation: "tetrahedral",
              },
            },
          ],
        },
      });
      project = (await call(legacy, "get_project", { projectPath })).project;
      expect(
        project.sequences[0]!.clips[0]!.effects[0]!.parameters.interpolation,
      ).toBe("tetrahedral");
      const invalid = await legacy.callTool({
        name: "update_clip",
        arguments: {
          projectPath,
          expectedRevision: project.revision,
          sequenceId: seq.id,
          clipId: clip.id,
          patch: {
            effects: [
              {
                ...effect,
                parameters: {
                  mediaId: effect.parameters.mediaId,
                  file: "/etc/passwd",
                },
              },
            ],
          },
        },
      });
      expect(invalid.isError).toBe(true);
      expect(
        (
          (await call(legacy, "get_project", { projectPath }))
            .project as StudioProject
        ).revision,
      ).toBe(project.revision);
    } finally {
      await browser.close();
      await Promise.allSettled(clients.map((client) => client.close()));
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
