import { presentedVideoFrame } from "./presented-video-frame.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { chromium } from "patchright";
import axe from "axe-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  defaultClip,
  secondsToTicks,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { ProjectStore } from "@mcp-video-studio/core";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
const integration = process.env.RUN_BROWSER_INTEGRATION === "1" ? it : it.skip;
integration(
  "Studio edits geometric masks through controls, renders visible alpha, and preserves durable undo/redo",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-mask-browser-")),
      store = await ProjectStore.create(
        path.join(root, "project"),
        "Mask controls",
      );
    await store.replace(
      0,
      (p) => {
        p.settings.raster = { width: 160, height: 90 };
        p.settings.fps = { numerator: 10, denominator: 1 };
        p.settings.background = "#0000ff";
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
    const project = await store.read(),
      sequence = project.sequences[0]!,
      clip = defaultClip(
        sequence.tracks[0]!.id,
        { type: "color", color: "#ff0000" },
        "Mask subject",
        secondsToTicks(1),
      );
    await store.mutate(1, [
      { type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" },
    ]);
    const client = new Client(
        { name: "mask-ui-bootstrap", version: "1" },
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
              (p): p is [string, string] => typeof p[1] === "string",
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
      page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
    page.setDefaultTimeout(20000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await client.connect(transport);
      const open = await client.callTool({
        name: "open_studio",
        arguments: { projectPath: store.root },
      });
      await page.goto(
        (open.structuredContent as { studioUrl: string }).studioUrl,
      );
      await page.getByText("Project loaded", { exact: true }).waitFor();
      const get = async () =>
        (
          (
            await client.callTool({
              name: "get_project",
              arguments: { projectPath: store.root },
            })
          ).structuredContent as { project: StudioProject }
        ).project;
      const change = async (action: () => Promise<unknown>) => {
        const revision = (await get()).revision;
        await action();
        await expect
          .poll(async () => (await get()).revision)
          .toBeGreaterThan(revision);
        const next = (await get()).revision;
        await page.waitForFunction(
          (revision) => document.body.textContent?.includes("rev " + revision),
          next,
        );
      };
      await page
        .getByRole("group", { name: "Mask subject", exact: true })
        .press("Enter");
      await change(() =>
        page
          .getByRole("button", { name: "Add ellipse mask", exact: true })
          .press("Enter"),
      );
      await page
        .getByLabel("Mask 1 shape", { exact: true })
        .selectOption("rectangle");
      await page
        .getByLabel("Mask 1 shape", { exact: true })
        .selectOption("ellipse");
      for (const [key, value] of [
        ["x", ".3"],
        ["y", ".3"],
        ["width", ".4"],
        ["height", ".4"],
        ["opacity", ".6"],
      ])
        await page.getByLabel("Mask 1 " + key, { exact: true }).fill(value!);
      const beforeInvalid = (await get()).revision;
      await page.getByLabel("Mask 1 width", { exact: true }).fill(".8");
      await page
        .getByRole("button", { name: "Apply mask 1", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Mask bounds must fit" })
        .waitFor();
      expect((await get()).revision).toBe(beforeInvalid);
      await page.getByLabel("Mask 1 width", { exact: true }).fill(".4");
      await change(() =>
        page.getByRole("button", { name: "Apply mask 1", exact: true }).click(),
      );
      const expected = (await get()).sequences;
      await page
        .getByRole("button", { name: "Build preview", exact: true })
        .click();
      const video = page.locator(".monitor video");
      await video.waitFor({ state: "visible" });
      await expect
        .poll(
          () =>
            video.evaluate((element: HTMLVideoElement) => element.readyState),
          { timeout: 60000 },
        )
        .toBeGreaterThanOrEqual(2);
      const previewUrl = await video.evaluate(
        (element: HTMLVideoElement) => element.currentSrc,
      );
      const frame = await presentedVideoFrame(
        page,
        ".monitor video",
        previewUrl,
        () =>
          page
            .getByRole("button", { name: "Play or pause", exact: true })
            .click(),
        {
          width: 160,
          height: 90,
          points: [
            [80, 45],
            [5, 5],
          ],
        },
      );
      expect(frame.sourcePath).toBe("/preview");
      expect(frame.sourceRevision).toBe(String((await get()).revision));
      expect(frame.presentedFrames).toBeGreaterThan(0);
      expect(frame.mediaTime).toBeGreaterThanOrEqual(0);
      expect(frame.mediaTime).toBeLessThan(1);
      const pixels = { center: frame.pixels[0]!, outside: frame.pixels[1]! };
      expect(pixels.center[3]).toBe(255);
      expect(pixels.outside[3]).toBe(255);
      expect(pixels.outside[2]).toBeGreaterThan(235);
      expect(pixels.center[0]).toBeGreaterThan(135);
      expect(pixels.center[0]).toBeLessThan(170);
      expect(pixels.center[2]).toBeGreaterThan(85);
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      await page.reload();
      await page.getByText("Project loaded", { exact: true }).waitFor();
      await change(() =>
        page.getByRole("button", { name: "Redo", exact: true }).click(),
      );
      expect((await get()).sequences).toEqual(expected);
      await page
        .getByRole("group", { name: "Mask subject", exact: true })
        .press("Enter");
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
      expect(errors).toEqual([]);
      await change(() =>
        page
          .getByRole("button", { name: "Remove mask 1", exact: true })
          .press("Enter"),
      );
      expect((await get()).sequences[0]!.clips[0]!.effects).toEqual([]);
    } finally {
      await browser.close();
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
