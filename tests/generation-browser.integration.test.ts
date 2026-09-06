import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";
import { chromium } from "patchright";
import axe from "axe-core";
import {
  generationFixture,
  generationInput,
  providerSecret,
  uiToken,
  secretFiles,
  until,
} from "./generation-fixture.js";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
const integration =
  process.env.RUN_BROWSER_INTEGRATION === "1" &&
  process.env.RUN_FFMPEG_INTEGRATION === "1"
    ? it
    : it.skip;
integration(
  "human reviews persistent region versions, auditions real A/B audio ranges, views animation/captions, annotates and reverts in an accessible browser",
  async () => {
    const f = await generationFixture(),
      browser = await chromium.launch({
        headless: true,
        env: browserEnvironment(),
      });
    const cli = new Client(
      { name: "generation-browser-cli", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    try {
      const client = await f.client();
      for (const kind of ["narration", "captions", "animation"]) {
        const project = await f.store.read(),
          result = await f.call(client, "generate_" + kind, {
            projectPath: f.projectPath,
            ...generationInput(project, kind, f.sourceMediaId),
          });
        await f.done(result.job.id);
      }
      await client.close();
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
          VIDEO_STUDIO_OPENAI_BASE_URL: f.config.providers.openaiAudio.baseUrl,
          VIDEO_STUDIO_ELEVENLABS_BASE_URL:
            f.config.providers.elevenLabs.baseUrl,
          VIDEO_STUDIO_LANGUAGE_BASE_URL: f.config.providers.language.baseUrl,
          VIDEO_STUDIO_OPENAI_API_KEY: providerSecret,
          VIDEO_STUDIO_ELEVENLABS_API_KEY: providerSecret,
          VIDEO_STUDIO_ELEVENLABS_VOICE_ID: "fixture-voice",
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
      const studioUrl = (opened.structuredContent as { studioUrl: string })
        .studioUrl;
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1100 },
      });
      page.setDefaultTimeout(15000);
      const messages: string[] = [];
      page.on("console", (msg) => messages.push(msg.text()));
      page.on("pageerror", (error) => messages.push(error.message));
      await page.goto(studioUrl);
      await page.getByText("Project loaded", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Generate 3", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Review, revise, and regenerate",
      });
      await dialog.waitFor();
      const narration = page.getByRole("article", {
        name: "Review Fixture narration",
      });
      await narration
        .getByLabel("Revised script or prompt")
        .fill("A revised middle sentence.");
      await narration
        .getByLabel("Range start (seconds)", { exact: true })
        .fill("1");
      await narration
        .getByLabel("Range duration (seconds)", { exact: true })
        .fill("1");
      await narration.getByLabel("Regenerate only this range").check();
      expect(
        await narration
          .getByLabel(
            "Automatically activate this generated version when ready",
          )
          .isChecked(),
      ).toBe(false);
      await narration
        .getByRole("button", { name: "Generate revised draft", exact: true })
        .click();
      await until(async () => {
        const artifact = (await f.store.read()).generatedArtifacts.find(
          (a) => a.kind === "narration",
        )!;
        return (
          artifact.versions.length === 2 &&
          artifact.versions[1]!.status === "draft"
        );
      });
      await narration.getByText(/2 versions/).waitFor();
      let project = await f.store.read(),
        artifact = project.generatedArtifacts.find(
          (a) => a.kind === "narration",
        )!,
        first = artifact.versions[0]!,
        second = artifact.versions[1]!;
      expect(artifact.activeVersionId).toBeUndefined();
      expect(second.output!.segments).toHaveLength(3);
      await narration
        .getByLabel("Compare B", { exact: true })
        .selectOption(second.id);
      await narration
        .getByRole("button", { name: "Compare selected versions", exact: true })
        .click();
      await narration.getByText(/Requests differ/).waitFor();
      const player = narration.locator("audio");
      for (const label of ["A", "B"]) {
        await narration
          .getByRole("button", {
            name: "Audition " + label + " range",
            exact: true,
          })
          .click();
        await until(() =>
          player.evaluate((audio) => !(audio as HTMLAudioElement).paused),
        );
        await until(() =>
          player.evaluate(
            (audio) => (audio as HTMLAudioElement).currentTime > 0.08,
          ),
        );
        await narration
          .getByRole("button", { name: "Stop audition", exact: true })
          .click();
        expect(
          await player.evaluate((audio) => (audio as HTMLAudioElement).paused),
        ).toBe(true);
      }
      await narration
        .getByRole("button", { name: "Audition A range", exact: true })
        .click();
      await until(() =>
        player.evaluate((audio) => !(audio as HTMLAudioElement).paused),
      );
      await narration
        .getByRole("button", { name: "Audition B range", exact: true })
        .click();
      await until(() =>
        player.evaluate((audio) => !(audio as HTMLAudioElement).paused),
      );
      await until(() =>
        player.evaluate(
          (audio) => (audio as HTMLAudioElement).currentTime > 0.15,
        ),
      );
      await until(() =>
        player.evaluate((audio) => (audio as HTMLAudioElement).paused),
      );
      expect(
        await player.evaluate(
          (audio) => (audio as HTMLAudioElement).currentTime,
        ),
      ).toBeGreaterThanOrEqual(0.95);
      expect(
        await player.evaluate(
          (audio) => (audio as HTMLAudioElement).currentTime,
        ),
      ).toBeLessThan(1.4);
      await narration
        .getByLabel("Regenerate from version")
        .selectOption(second.id);
      await narration
        .getByLabel("Version annotation")
        .fill("Human comparison: second take preferred.");
      await narration
        .getByRole("button", {
          name: "Save annotation on selected version",
          exact: true,
        })
        .click();
      await until(
        async () =>
          (await f.store.read()).generatedArtifacts
            .find((a) => a.id === artifact.id)!
            .versions.find((v) => v.id === second.id)!.review?.note ===
          "Human comparison: second take preferred.",
      );
      for (const version of [second, first, second]) {
        const row = narration
          .locator(".version-row")
          .filter({ hasText: version.id.slice(0, 8) });
        await row
          .getByRole("button", {
            name: "Activate / revert to this version",
            exact: true,
          })
          .click();
        await until(
          async () =>
            (await f.store.read()).generatedArtifacts.find(
              (a) => a.id === artifact.id,
            )!.activeVersionId === version.id,
        );
      }
      const captions = page.getByRole("article", {
        name: "Review Fixture captions",
      });
      expect(
        await captions
          .locator('[aria-label^="Caption version"]')
          .first()
          .textContent(),
      ).toContain("Fixture caption.");
      const animation = page.getByRole("article", {
        name: "Review Fixture animation",
      });
      await until(() =>
        animation
          .locator("canvas")
          .first()
          .evaluate((canvas) => {
            const data = (canvas as HTMLCanvasElement)
              .getContext("2d")!
              .getImageData(160, 90, 1, 1).data;
            return data[0] === 255 && data[1] === 0 && data[2] === 68;
          }),
      );
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
      expect(await page.locator("body").innerText()).not.toContain(
        providerSecret,
      );
      expect(messages.join("\n")).not.toContain(providerSecret);
      expect(stderr).not.toContain(providerSecret);
      expect(await secretFiles(f.root)).toEqual([]);
      await page
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await page.reload();
      await page.getByText("Project loaded", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Generate 3", exact: true })
        .click();
      expect(
        await page
          .getByRole("article", { name: "Review Fixture narration" })
          .innerText(),
      ).toContain("Human comparison: second take preferred.");
      project = await f.store.read();
      expect(
        project.generatedArtifacts.find((a) => a.id === artifact.id)!
          .activeVersionId,
      ).toBe(second.id);
    } finally {
      await browser.close();
      await cli.close();
      await f.close();
    }
  },
  120000,
);
