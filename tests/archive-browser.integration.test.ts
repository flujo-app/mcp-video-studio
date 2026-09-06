import path from "node:path";
import { writeFile, rename, readFile, stat } from "node:fs/promises";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "patchright";
import axe from "axe-core";
import { defaultClip, secondsToTicks } from "@mcp-video-studio/contracts";
import { ProjectStore } from "@mcp-video-studio/core";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
import { generationFixture, wav, until } from "./generation-fixture.js";
const integration =
  process.env.RUN_BROWSER_INTEGRATION === "1" &&
  process.env.RUN_FFMPEG_INTEGRATION === "1"
    ? it
    : it.skip;
integration(
  "human inspects offline media, relinks and consolidates it, then exports/imports a portable project and reopens it after browser reload",
  async () => {
    const f = await generationFixture(),
      browser = await chromium.launch({
        headless: true,
        env: browserEnvironment(),
      }),
      cli = new Client(
        { name: "archive-browser", version: "1" },
        { versionNegotiation: { mode: "auto" } },
      );
    try {
      const original = path.join(f.root, "relocatable.wav"),
        replacement = path.join(f.root, "relocated.wav");
      await writeFile(original, wav());
      let project = await f.store.read();
      await f.runtime.relink({
        projectPath: f.projectPath,
        mediaId: f.sourceMediaId,
        filePath: original,
        expectedRevision: project.revision,
      });
      project = await f.store.read();
      const sequence = project.sequences[0]!,
        clip = defaultClip(
          sequence.tracks.find((t) => t.type === "audio")!.id,
          { type: "media", mediaId: f.sourceMediaId },
          "Retain my audio edit",
          secondsToTicks(1),
        );
      clip.audio.gainDb = -7;
      await f.store.mutate(project.revision, [
        { type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" },
      ]);
      await rename(original, replacement);
      await f.runtime.jobs.close();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist/index.js"), "--stdio"],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (p): p is [string, string] => typeof p[1] === "string",
            ),
          ),
          VIDEO_STUDIO_DATA_DIR: f.root,
          VIDEO_STUDIO_GATEWAY_PORT: "0",
        },
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (data) => (stderr += String(data)));
      await cli.connect(transport);
      const opened = await cli.callTool({
        name: "open_studio",
        arguments: { projectPath: f.projectPath },
      });
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1100 },
      });
      page.setDefaultTimeout(15000);
      await page.goto(
        (opened.structuredContent as { studioUrl: string }).studioUrl,
      );
      await page.getByText("Project loaded", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Editing workflows", exact: true })
        .click();
      const panel = page.getByRole("group", {
        name: "Project files and archives",
        exact: true,
      });
      await panel
        .getByLabel("Media to inspect or relink")
        .selectOption(f.sourceMediaId);
      await panel
        .getByRole("button", { name: "Inspect selected media", exact: true })
        .click();
      await panel.getByText(/Offline/).waitFor();
      await panel.getByLabel("Replacement media file path").fill(replacement);
      await panel
        .getByRole("button", { name: "Relink selected media", exact: true })
        .click();
      await panel
        .getByText("Media relinked; clip IDs and edits were preserved.", {
          exact: true,
        })
        .waitFor();
      project = await f.store.read();
      expect(project.sequences[0]!.clips[0]).toEqual(clip);
      expect(project.media[0]!.storage.mode).toBe("linked");
      await panel
        .getByRole("button", { name: "Consolidate linked media", exact: true })
        .click();
      await panel
        .getByText("Linked media copied into the project and verified.", {
          exact: true,
        })
        .waitFor();
      project = await f.store.read();
      expect(project.media[0]!.storage.mode).toBe("managed");
      const archive = path.join(f.root, "portable.mcpstudio");
      await panel.getByLabel("Archive output path").fill(archive);
      await panel
        .getByRole("button", { name: "Export project archive", exact: true })
        .click();
      await panel
        .getByText("Archive saved: " + archive, { exact: true })
        .waitFor();
      expect((await stat(archive)).size).toBeGreaterThan(300000);
      await panel
        .getByRole("button", { name: "Refresh archive history", exact: true })
        .click();
      await panel.getByText("export · completed", { exact: true }).waitFor();
      await page.evaluate(axe.source, undefined, false);
      const a11y = await page.evaluate(
        async () =>
          await (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          }),
        undefined,
        false,
      );
      expect(
        a11y.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
      ).toEqual([]);
      await page
        .getByRole("button", { name: "Close editing workflows", exact: true })
        .click();
      await page.getByRole("button", { name: /MCP Video Studio/ }).click();
      const destination = path.join(f.root, "restored-outside-projects");
      await page.getByLabel("Location").fill(destination);
      await page.getByLabel("Archive file path", { exact: true }).fill(archive);
      await page
        .getByRole("button", { name: "Import project archive", exact: true })
        .click();
      await until(() =>
        Promise.resolve(
          new URL(page.url()).searchParams.get("projectPath") === destination,
        ),
      );
      const restored = await new ProjectStore(destination).read();
      expect(restored.sequences[0]!.clips[0]).toEqual(clip);
      expect(restored.media[0]!.storage.mode).toBe("managed");
      await page.reload();
      await page.getByText("Project loaded", { exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("projectPath")).toBe(
        destination,
      );
      const fresh = new Client(
        { name: "archive-legacy-reopen", version: "1" },
        { versionNegotiation: { mode: "legacy" } },
      );
      const secondTransport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist/index.js"), "--stdio"],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (p): p is [string, string] => typeof p[1] === "string",
            ),
          ),
          VIDEO_STUDIO_DATA_DIR: path.join(f.root, "fresh-runtime"),
          VIDEO_STUDIO_GATEWAY_PORT: "0",
        },
        stderr: "pipe",
      });
      try {
        await fresh.connect(secondTransport);
        const result = await fresh.callTool({
          name: "get_project",
          arguments: { projectPath: destination },
        });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).toContain("Retain my audio edit");
      } finally {
        await fresh.close();
      }
      expect(stderr).not.toContain("Unhandled");
    } finally {
      await browser.close();
      await cli.close();
      await f.close();
    }
  },
  120000,
);
