import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { chromium } from "patchright";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { StudioProject } from "@mcp-video-studio/contracts";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
const integration = process.env.RUN_BROWSER_INTEGRATION === "1" ? it : it.skip;
integration(
  "unchanged audio blur cannot submit a competing save when a human normalizes the mix",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-audio-focus-"));
    const client = new Client(
      { name: "audio-focus-bootstrap", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    const browser = await chromium.launch({
      headless: true,
      env: browserEnvironment(),
    });
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1200 },
    });
    page.setDefaultTimeout(12000);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false,
      unrequestedBlurSaves = 0;
    const responses: Array<{ status: number; body: string }> = [];
    page.on("response", (response) => {
      if (new URL(response.url()).pathname === "/api/commands")
        void response
          .text()
          .then((body) => responses.push({ status: response.status(), body }));
    });
    const project = async () =>
      page.evaluate(async () => {
        const headers = {
          authorization:
            "Bearer " + sessionStorage.getItem("mcp-video-studio:access"),
        };
        const list = (await fetch("/api/projects", { headers }).then((r) =>
          r.json(),
        )) as { projects: Array<{ path: string }> };
        return (
          (await fetch(
            "/api/project?projectPath=" +
              encodeURIComponent(list.projects[0]!.path),
            { headers },
          ).then((r) => r.json())) as { project: StudioProject }
        ).project;
      });
    try {
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
                (p): p is [string, string] => typeof p[1] === "string",
              ),
            ),
            VIDEO_STUDIO_DATA_DIR: root,
            VIDEO_STUDIO_GATEWAY_PORT: "0",
          },
          stderr: "pipe",
        }),
      );
      const opened = await client.callTool({
        name: "open_studio",
        arguments: {},
      });
      await page.goto(
        (opened.structuredContent as { studioUrl: string }).studioUrl,
      );
      await page.getByLabel("Name", { exact: true }).fill("Audio focus");
      await page
        .getByRole("button", { name: "Create project", exact: true })
        .click();
      await page.getByText("Project loaded", { exact: true }).waitFor();
      const change = async (action: () => Promise<unknown>) => {
        const revision = (await project()).revision;
        await action();
        await expect
          .poll(async () => (await project()).revision)
          .toBe(revision + 1);
        await page.waitForFunction(
          (revision) => document.body.textContent?.includes("rev " + revision),
          revision + 1,
        );
      };
      await change(() =>
        page.getByRole("button", { name: "Color", exact: true }).click(),
      );
      await change(() =>
        page
          .getByRole("button", { name: "Add Clip audio effect", exact: true })
          .click(),
      );
      await change(async () => {
        const input = page.getByLabel("Clip audio EQ band 1 gainDb", {
          exact: true,
        });
        await input.fill("-3");
        await input.press("Tab");
      });
      // Keep any unexpected unchanged-blur write pending until Normalize completes.
      // The regression fails old controls without relying on machine/network speed.
      await page.route("**/api/commands", async (route) => {
        const data = route.request().postDataJSON() as {
          commands: Array<{ type: string }>;
        };
        if (armed && data.commands.some((c) => c.type === "clip.update")) {
          unrequestedBlurSaves++;
          await held;
        }
        await route.continue();
      });
      armed = true;
      await page
        .getByText("Audio mixer and track processing", { exact: true })
        .click();
      const normalizedResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/commands" &&
          response
            .request()
            .postDataJSON()
            .commands.some(
              (c: { type: string }) => c.type === "audio.master.set",
            ),
      );
      await page
        .getByRole("button", {
          name: "Normalize final mix to -16 LUFS",
          exact: true,
        })
        .click();
      expect((await normalizedResponse).status()).toBe(200);
      await expect
        .poll(
          async () => (await project()).sequences[0]!.audioMaster?.effects[0],
        )
        .toMatchObject({
          type: "loudness",
          enabled: true,
          parameters: { targetLufs: -16, truePeakDb: -1.5, rangeLu: 7 },
        });
      release();
      expect(
        unrequestedBlurSaves,
        "Focusing an unchanged EQ field must not race the Normalize save",
      ).toBe(0);
      armed = false;
      // Keyboard/focus traversal through mixer values is also read-only.
      const audioTrackName = (await project()).sequences[0]!.tracks.find(
        (track) => track.type === "audio",
      )!.name;
      for (const label of [
        "Track gain " + audioTrackName,
        "Track pan " + audioTrackName,
        "Master gain dB",
      ]) {
        const revision = (await project()).revision;
        await page.getByLabel(label, { exact: true }).focus();
        await change(() =>
          page
            .getByRole("button", {
              name: "Normalize final mix to -16 LUFS",
              exact: true,
            })
            .click(),
        );
        expect((await project()).revision).toBe(revision + 1);
      }
      expect(responses.filter((r) => r.status !== 200)).toEqual([]);
      expect(await page.getByRole("alert").allTextContents()).toEqual([]);
    } finally {
      release();
      await browser.close();
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  45000,
);
