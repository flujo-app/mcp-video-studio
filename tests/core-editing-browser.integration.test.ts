import { mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { chromium, type Page } from "patchright";
import axe from "axe-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  secondsToTicks,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
import {
  coreEditingFixture,
  verifyMinuteDelivery,
} from "./core-editing-fixture.js";
const integration = process.env.RUN_BROWSER_INTEGRATION === "1" ? it : it.skip;
async function read(page: Page) {
  return page.evaluate(async () => {
    const headers = {
      authorization:
        "Bearer " + sessionStorage.getItem("mcp-video-studio:access"),
    };
    const projects = (await fetch("/api/projects", { headers }).then((r) =>
      r.json(),
    )) as { projects: Array<{ path: string }> };
    const projectPath =
      new URL(location.href).searchParams.get("projectPath") ??
      projects.projects[0]!.path;
    return (
      (await fetch(
        "/api/project?projectPath=" + encodeURIComponent(projectPath),
        { headers },
      ).then((r) => r.json())) as { project: StudioProject }
    ).project;
  });
}
integration(
  "a browser-only one-minute mixed-media edit covers core pointer/keyboard controls and durable revisions",
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "studio-core-production-"),
    );
    const media = await coreEditingFixture(root);
    const client = new Client(
      { name: "human-core-editor-bootstrap", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StdioClientTransport({
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
    });
    const page = await browser.newPage({
      viewport: { width: 1600, height: 1200 },
    });
    page.setDefaultTimeout(12000);
    const errors: string[] = [],
      requests: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (response) => {
      if (
        response.url().includes("/api/") &&
        response.request().method() === "POST"
      )
        void response
          .text()
          .then((body) =>
            requests.push(
              response.status() +
                " " +
                response.url().split("/api/")[1] +
                " " +
                body.slice(0, 1200),
            ),
          )
          .catch(() => undefined);
    });
    try {
      await client.connect(transport);
      const response = await client.callTool({
        name: "open_studio",
        arguments: {},
      });
      await page.goto(
        (response.structuredContent as { studioUrl: string }).studioUrl,
      );
      await page
        .getByLabel("Name", { exact: true })
        .fill("One minute human edit");
      await page
        .getByRole("button", { name: "Create project", exact: true })
        .click();
      await page.getByText("Project loaded", { exact: true }).waitFor();
      const change = async (action: () => Promise<unknown>) => {
        const revision = (await read(page)).revision;
        await action();
        try {
          await expect
            .poll(async () => (await read(page)).revision, { timeout: 12000 })
            .toBeGreaterThan(revision);
        } catch (error) {
          throw new Error(
            "Edit did not advance revision " +
              revision +
              "; alerts=" +
              JSON.stringify(await page.getByRole("alert").allTextContents()) +
              "; requests=" +
              JSON.stringify(requests.slice(-3)),
            { cause: error },
          );
        }
        const next = (await read(page)).revision;
        await page.waitForFunction(
          (revision) => document.body.textContent?.includes("rev " + revision),
          next,
        );
      };
      const seek = async (seconds: number) => {
        const summary = page.locator(".playback-review");
        if ((await summary.getAttribute("open")) === null)
          await summary.locator("summary").click();
        const input = page.getByLabel("Playhead (seconds)", { exact: true });
        await input.fill(String(seconds));
        await input.press("Tab");
      };
      for (const file of [media.video, media.audio, media.image]) {
        await page
          .getByLabel("Absolute media file path", { exact: true })
          .fill(file);
        await change(() =>
          page
            .getByRole("button", { name: "Import media", exact: true })
            .click(),
        );
      }
      await change(() =>
        page
          .locator(".asset")
          .filter({ hasText: "Provided video.mp4" })
          .press("Enter"),
      );
      await change(async () => {
        const duration = page.getByLabel("Duration (seconds)", { exact: true });
        await duration.fill("30");
        await duration.press("Tab");
      });
      await change(() =>
        page.getByRole("button", { name: "Duplicate", exact: true }).click(),
      );
      expect(
        await page.getByLabel("Frames to adjust", { exact: true }).count(),
      ).toBe(1);
      await page.getByLabel("Frames to adjust", { exact: true }).fill("30");
      await change(() =>
        page.getByRole("button", { name: "Slip source", exact: true }).click(),
      );
      await seek(0);
      await change(() =>
        page
          .locator(".asset")
          .filter({ hasText: "Provided music.wav" })
          .press("Enter"),
      );
      await change(() =>
        page.getByRole("button", { name: "+ Overlay", exact: true }).click(),
      );
      let project = await read(page),
        sequence = project.sequences[0]!,
        overlay = sequence.tracks.find((t) => t.type === "overlay")!;
      await page
        .getByLabel("Target media track", { exact: true })
        .selectOption(overlay.id);
      await seek(15);
      await change(() =>
        page
          .locator(".asset")
          .filter({ hasText: "Provided still.png" })
          .press("Enter"),
      );
      await change(async () => {
        const opacity = page.getByLabel("Opacity", { exact: true });
        await opacity.press("ArrowLeft");
      });
      // Selection can be made without reaching a virtualized clip with a pointer.
      await page.getByLabel("Range start (s)", { exact: true }).fill("0");
      await page.getByLabel("Range end (s)", { exact: true }).fill("60");
      await page
        .getByRole("button", { name: "Select range", exact: true })
        .click();
      await change(() =>
        page.getByRole("button", { name: "Group", exact: true }).click(),
      );
      await change(() =>
        page.getByRole("button", { name: "Ungroup", exact: true }).click(),
      );
      // Real rectangular pointer selection across multiple tracks.
      await seek(0);
      await page.getByLabel("Zoom", { exact: true }).press("Home");
      const lane = page.locator(".lane").first(),
        box = await lane.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box!.x + 20, box!.y + box!.height - 4);
      await page.mouse.down();
      await page.mouse.move(box!.x + 450, box!.y + box!.height * 2 - 4, {
        steps: 8,
      });
      await page.mouse.up();
      expect(
        Number(
          (await page.locator(".selection-tools output").textContent())?.split(
            " ",
          )[0],
        ),
      ).toBeGreaterThanOrEqual(2);
      await page
        .getByRole("button", { name: "Clear selection", exact: true })
        .click();
      // Split creates a middle clip for slide/roll; keyboard and pointer trims
      // share the same source handles and can be undone without drifting any track.
      const beforeCuts = (await read(page)).sequences;
      await page
        .locator(".timeline-clip")
        .filter({ hasText: "Provided video.mp4" })
        .first()
        .press("Enter");
      await seek(15);
      await change(() =>
        page.getByRole("button", { name: "Split", exact: true }).press("Enter"),
      );
      let videoClips = page
        .locator(".timeline-clip")
        .filter({ hasText: "Provided video.mp4" });
      await videoClips.nth(1).press("Enter");
      await page.getByLabel("Frames to adjust", { exact: true }).fill("1");
      await change(() =>
        page
          .getByRole("button", { name: "Slide clip", exact: true })
          .press("Enter"),
      );
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      await videoClips.nth(1).press("Enter");
      await change(() =>
        page
          .getByRole("button", { name: "Roll outgoing cut", exact: true })
          .click(),
      );
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      const trim = videoClips.first().getByRole("slider", { name: /Trim end/ });
      await change(() => trim.press("ArrowLeft"));
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      const trimBox = await trim.boundingBox();
      expect(trimBox).not.toBeNull();
      await change(async () => {
        await page.mouse.move(
          trimBox!.x + trimBox!.width / 2,
          trimBox!.y + trimBox!.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          trimBox!.x - 25,
          trimBox!.y + trimBox!.height / 2,
          { steps: 5 },
        );
        await page.mouse.up();
      });
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      expect((await read(page)).sequences).toEqual(beforeCuts);
      // A centered transition uses the source handles prepared by the slip edit.
      const first = page
        .locator(".timeline-clip")
        .filter({ hasText: "Provided video.mp4" })
        .first();
      await first.press("Enter");
      await page.locator(".editing-review summary").click();
      await page
        .getByLabel("Transition duration (frames)", { exact: true })
        .fill("12");
      await change(() =>
        page
          .getByRole("button", { name: "Add transition", exact: true })
          .click(),
      );
      await page
        .getByLabel("Visual transition duration", { exact: true })
        .press("ArrowRight");
      await change(() =>
        page
          .getByRole("button", { name: "Update transition", exact: true })
          .click(),
      );
      expect(
        (await read(page)).sequences[0]!.transitions[0]!.durationTick,
      ).toBe(secondsToTicks(13 / 30));
      await seek(15);
      await page
        .getByLabel("Marker label", { exact: true })
        .fill("Overlay review");
      await change(() =>
        page.getByRole("button", { name: "Add marker", exact: true }).click(),
      );
      await page
        .getByLabel("Selected marker", { exact: true })
        .selectOption({ label: "Overlay review" });
      await change(async () => {
        const field = page.getByLabel("Edit marker label", { exact: true });
        await field.fill("Approved overlay");
        await field.press("Tab");
      });
      // Frame stepping, in/out, and loop/jog controls work via keyboard and native inputs.
      await page
        .getByRole("button", { name: "Mark in (I)", exact: true })
        .click();
      await seek(16);
      await page
        .getByRole("button", { name: "Mark out (O)", exact: true })
        .click();
      await page.getByLabel("Loop review range", { exact: true }).check();
      await page
        .getByRole("button", { name: "Forward shuttle (L)", exact: true })
        .click();
      await page.waitForTimeout(250);
      await page
        .getByRole("button", { name: "Stop shuttle (K)", exact: true })
        .click();
      expect(
        Number(
          await page
            .getByLabel("Playhead (seconds)", { exact: true })
            .inputValue(),
        ),
      ).toBeLessThanOrEqual(16.04);
      await page.getByRole("button", { name: "Go to in", exact: true }).click();
      await page
        .getByRole("button", { name: "Jog next frame", exact: true })
        .click();
      expect(
        Number(
          await page
            .getByLabel("Playhead (seconds)", { exact: true })
            .inputValue(),
        ),
      ).toBeCloseTo(15 + 1 / 30, 3);
      // Move the whole selection with the keyboard, then close its real global gap.
      const beforeGap = (await read(page)).sequences;
      await page
        .getByRole("button", { name: "Select all", exact: true })
        .click();
      await change(() =>
        page.locator(".timeline-clip").first().press("ArrowRight"),
      );
      await page
        .getByRole("button", { name: "Editing workflows", exact: true })
        .click();
      await page.getByLabel("Gap start (seconds)", { exact: true }).fill("0");
      await page
        .getByLabel("Gap end (seconds)", { exact: true })
        .fill(String(1 / 30));
      await change(() =>
        page
          .getByRole("button", { name: "Remove empty range", exact: true })
          .press("Enter"),
      );
      await page.keyboard.press("Escape");
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      expect((await read(page)).sequences).toEqual(beforeGap);
      // Ripple deletion and trim use the declared selection and can restore it.
      await page
        .getByRole("button", { name: "Select all", exact: true })
        .click();
      await page.getByLabel("Ripple", { exact: true }).check();
      await change(() =>
        page
          .getByRole("button", { name: "Ripple delete", exact: true })
          .press("Enter"),
      );
      expect((await read(page)).sequences[0]!.clips).toHaveLength(0);
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      await page.getByLabel("Ripple", { exact: true }).uncheck();
      // Every insertion mode is available without JSON, and undo restores all tracks.
      const originalSequences = (await read(page)).sequences;
      await seek(0);
      for (const mode of ["insert", "ripple", "overwrite"]) {
        await page
          .getByLabel("New clip edit mode", { exact: true })
          .selectOption(mode);
        await change(() =>
          page
            .getByRole("button", { name: "Color", exact: true })
            .press("Enter"),
        );
        await change(() =>
          page.getByRole("button", { name: "Undo", exact: true }).click(),
        );
        expect((await read(page)).sequences).toEqual(originalSequences);
      }
      await page
        .getByLabel("New clip edit mode", { exact: true })
        .selectOption("overwrite");
      // Track controls and reordering expose native keyboard-accessible controls.
      const audioTrack = (await read(page)).sequences[0]!.tracks.find(
        (t) => t.type === "audio",
      )!;
      for (const field of ["muted", "solo", "hidden", "locked"]) {
        const control = page.getByRole("button", {
          name: field + " " + audioTrack.name,
          exact: true,
        });
        await change(() => control.press("Space"));
        await change(() => control.press("Space"));
      }
      await change(() =>
        page
          .getByRole("button", {
            name: "Move " + audioTrack.name + " down",
            exact: true,
          })
          .press("Enter"),
      );
      await change(() =>
        page
          .getByRole("button", {
            name: "Move " + audioTrack.name + " up",
            exact: true,
          })
          .press("Enter"),
      );
      await page.getByLabel("Track height", { exact: true }).press("End");
      expect(
        await page
          .locator(".lane")
          .first()
          .evaluate((e) => e.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(159);
      await page.getByLabel("Track height", { exact: true }).press("Home");
      await page.getByLabel("Range start (s)", { exact: true }).fill("0");
      await page.getByLabel("Range end (s)", { exact: true }).fill("5");
      await page
        .getByRole("button", { name: "Select range", exact: true })
        .click();
      await change(() =>
        page.getByRole("button", { name: "Link", exact: true }).press("Enter"),
      );
      await change(() =>
        page
          .getByRole("button", { name: "Unlink", exact: true })
          .press("Enter"),
      );
      await page
        .getByRole("button", { name: "Copy", exact: true })
        .press("Enter");
      await seek(60);
      await change(() =>
        page
          .getByRole("button", { name: "Paste at playhead", exact: true })
          .press("Enter"),
      );
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      await seek(15);
      await page
        .locator(".timeline-clip")
        .filter({ hasText: "Provided video.mp4" })
        .first()
        .press("Enter");
      await page
        .getByRole("button", { name: "Compare source / program", exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .getByLabel("Source preview", { exact: true })
            .evaluate((e: HTMLVideoElement) => e.currentTime),
        )
        .toBeCloseTo(15, 2);
      await expect
        .poll(() =>
          page
            .locator(".timeline-tiles img")
            .evaluateAll(
              (images) =>
                images.filter(
                  (e) => (e as HTMLImageElement).naturalWidth === 320,
                ).length,
            ),
        )
        .toBeGreaterThan(1);
      const initialSpan = await page
        .locator(".timeline-tiles img")
        .first()
        .getAttribute("data-tile-span");
      await page.getByLabel("Zoom", { exact: true }).press("End");
      await expect
        .poll(() =>
          page
            .locator(".timeline-tiles img")
            .first()
            .getAttribute("data-tile-span"),
        )
        .not.toBe(initialSpan);
      await expect
        .poll(() =>
          page
            .locator(".timeline-tiles img")
            .evaluateAll(
              (images) =>
                images.filter(
                  (e) => (e as HTMLImageElement).naturalWidth === 320,
                ).length,
            ),
        )
        .toBeGreaterThan(0);
      await page.getByLabel("Zoom", { exact: true }).press("Home");
      // Timeline undo/redo is persisted; reloading does not create a private UI history.
      project = await read(page);
      const before = structuredClone(project.sequences);
      await change(() =>
        page.getByRole("button", { name: "Undo", exact: true }).click(),
      );
      await page.reload();
      await page.getByText("Project loaded", { exact: true }).waitFor();
      await change(() =>
        page.getByRole("button", { name: "Redo", exact: true }).click(),
      );
      project = await read(page);
      expect(project.sequences).toEqual(before);
      sequence = project.sequences[0]!;
      expect(
        Math.max(...sequence.clips.map((c) => c.startTick + c.durationTick)),
      ).toBe(secondsToTicks(60));
      expect(new Set(sequence.clips.map((c) => c.trackId)).size).toBe(3);
      expect(sequence.clips).toHaveLength(4);
      expect(sequence.markers[0]!.label).toBe("Approved overlay");

      // The minute benchmark continues through the public human controls to a
      // delivered file. API use below only inspects project/job state.
      await seek(0);
      await change(() =>
        page
          .getByRole("button", { name: "Animated title", exact: true })
          .click(),
      );
      await page
        .getByRole("treeitem", { name: "Your title (text)", exact: true })
        .click();
      await change(async () => {
        const text = page.getByRole("textbox", { name: /^Object text/ });
        await text.fill("One minute production");
        await text.press("Tab");
      });
      await change(async () => {
        const size = page.getByLabel("Object font size", { exact: true });
        await size.fill("90");
        await size.press("Tab");
      });
      await seek(5);
      await change(() =>
        page.getByRole("button", { name: "Caption", exact: true }).click(),
      );
      await change(async () => {
        const text = page.getByLabel("Caption text", { exact: true });
        await text.fill("One minute production reviewed");
        await text.press("Tab");
      });
      await change(() =>
        page.getByLabel("Font size", { exact: true }).fill("500"),
      );
      await page
        .getByRole("button", { name: "Measure caption layout", exact: true })
        .click();
      await page.getByText(/Caption (is clipped|extends outside)/).waitFor();
      await change(() =>
        page.getByLabel("Font size", { exact: true }).fill("54"),
      );
      await page
        .getByRole("button", { name: "Measure caption layout", exact: true })
        .click();
      await page
        .getByText("Caption fits the frame and safe-area guide.", {
          exact: true,
        })
        .waitFor();
      await seek(0);
      await page
        .locator(".timeline-clip")
        .filter({ hasText: "Provided music.wav" })
        .first()
        .press("Enter");
      await page
        .getByLabel("New Clip audio effect", { exact: true })
        .selectOption("equalizer");
      await change(() =>
        page
          .getByRole("button", { name: "Add Clip audio effect", exact: true })
          .click(),
      );
      await change(async () => {
        const gain = page.getByLabel("Clip audio EQ band 1 gainDb", {
          exact: true,
        });
        await gain.fill("-3");
        await gain.press("Tab");
      });
      await page
        .getByText("Audio mixer and track processing", { exact: true })
        .click();
      await change(() =>
        page
          .getByRole("button", {
            name: "Normalize final mix to -16 LUFS",
            exact: true,
          })
          .click(),
      );
      const output = path.join(root, "human-minute.mp4");
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page.getByLabel("Export output path", { exact: true }).fill(output);
      const queuedResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/render" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Queue render", exact: true })
        .click();
      const queued = (await (await queuedResponse).json()) as {
        job: { id: string };
      };
      const done = async (id: string) => {
        const deadline = Date.now() + 600000;
        while (Date.now() < deadline) {
          const response = await client.callTool({
              name: "get_job",
              arguments: { jobId: id },
            }),
            body = response.structuredContent as {
              job: { status: string; result: any; error?: unknown };
            };
          expect(response.isError, JSON.stringify(body)).not.toBe(true);
          if (body.job.status === "completed") return body.job.result;
          if (["failed", "cancelled"].includes(body.job.status))
            throw new Error(JSON.stringify(body.job));
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        throw new Error(
          "Human minute production job exceeded ten-minute deadline",
        );
      };
      const rendered = await done(queued.job.id);
      expect(rendered.frameCount).toBe(1800);
      expect(await realpath(rendered.outputPath)).toBe(await realpath(output));
      await expect
        .poll(() =>
          page
            .locator("section[aria-label='Quality control'] input")
            .first()
            .inputValue(),
        )
        .toBe(rendered.outputPath);
      const qcResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/qc" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Analyze export", exact: true })
        .click();
      const qcQueued = (await (await qcResponse).json()) as {
        job: { id: string };
      };
      let qc = await done(qcQueued.job.id);
      // The supplied still intentionally holds the screen from 15 to 20 seconds.
      // Review the measured finding explicitly; other warnings may not be waived.
      const hold = qc.checks.find(
        (item: any) =>
          item.checkId === "video.freeze" && item.status === "WARN",
      );
      if (hold) {
        expect(hold.observed).toMatchObject({
          startSeconds: 15,
          endSeconds: 20,
          durationSeconds: 5,
        });
        const finding = page.locator('[data-qc-check="video.freeze"]');
        await finding.getByRole("button", { name: /^Jump to/ }).click();
        expect(await page.locator(".transport code").textContent()).toBe(
          "00:00:15:00",
        );
        await page
          .getByLabel("Intentional range reason", { exact: true })
          .fill(
            "Provided five-second still overlay is an intentional held image",
          );
        await change(() =>
          finding
            .getByRole("button", {
              name: "Mark intentional video.freeze",
              exact: true,
            })
            .click(),
        );
        const reviewedResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/qc" &&
            response.request().method() === "POST",
        );
        await page
          .getByRole("button", { name: "Analyze export", exact: true })
          .click();
        const reviewed = (await (await reviewedResponse).json()) as {
          job: { id: string };
        };
        qc = await done(reviewed.job.id);
      }
      expect(
        qc.checks.find((item: any) => item.id === "video.frames"),
      ).toMatchObject({ status: "PASS", observed: { frames: 1800 } });
      expect(qc.passed, JSON.stringify(qc)).toBe(true);
      expect(
        qc.checks.filter((item: any) => item.status !== "PASS"),
        JSON.stringify(qc.checks),
      ).toEqual([]);
      const delivery = await verifyMinuteDelivery(root, output);
      project = await read(page);
      expect(project.animations[0]!.nodes[0]!.properties.text).toBe(
        "One minute production",
      );
      expect(project.sequences[0]!.captions[0]!.text).toBe(
        "One minute production reviewed",
      );
      const delivered = structuredClone(project);
      await page.reload();
      await page.getByText("Project loaded", { exact: true }).waitFor();
      expect(await read(page)).toEqual(delivered);
      const report = {
        workflow: "human-core-one-minute-delivery",
        output: rendered.outputPath,
        revision: project.revision,
        delivery,
        checks: qc.checks,
        captionDefectRepaired: true,
        titleAndAnimation: true,
        mutations: "browser controls only",
        externalUnfamiliarHuman: "not claimed",
      };
      if (process.env.MINUTE_ACCEPTANCE_EVIDENCE)
        await writeFile(
          path.join(
            process.env.MINUTE_ACCEPTANCE_EVIDENCE,
            "human-minute.json",
          ),
          JSON.stringify(report, null, 2),
        );
      console.log("HUMAN_MINUTE_ACCEPTANCE", JSON.stringify(report));
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
    } finally {
      await browser.close();
      await client.close();
      if (!process.env.MINUTE_ACCEPTANCE_KEEP)
        await rm(root, { recursive: true, force: true });
    }
  },
  900000,
);
