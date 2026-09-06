import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { chromium } from "patchright";
import axe from "axe-core";
import { defaultClip, secondsToTicks } from "@mcp-video-studio/contracts";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
import { generationFixture, until, providerSecret } from "./generation-fixture.js";
const integration =
  process.env.RUN_BROWSER_INTEGRATION === "1" &&
  process.env.RUN_FFMPEG_INTEGRATION === "1"
    ? it
    : it.skip;
integration(
  "human exports through built stdio editor, reviews saved provenance and reproduces the old snapshot after edits",
  async () => {
    const f = await generationFixture(),
      browser = await chromium.launch({
        headless: true,
        env: browserEnvironment(),
      }),
      cli = new Client(
        { name: "export-history-browser", version: "1" },
        { versionNegotiation: { mode: "auto" } },
      );
    let childStderr="",failed=false;
    try {
      let project = await f.store.read();
      const seq = project.sequences[0]!,
        clip = defaultClip(
          seq.tracks.find((t) => t.type === "audio")!.id,
          { type: "media", mediaId: f.sourceMediaId },
          "Original audio",
          secondsToTicks(1),
        );
      await f.store.mutate(project.revision, [
        { type: "clip.add", sequenceId: seq.id, clip, mode: "overwrite" },
      ]);
      project = await f.store.read();
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
      transport.stderr?.on("data",chunk=>{childStderr=(childStderr+String(chunk)).slice(-32000);});
      await cli.connect(transport);
      const opened = await cli.callTool({
          name: "open_studio",
          arguments: { projectPath: f.projectPath },
        }),
        page = await browser.newPage();
      await page.goto(
        String((opened.structuredContent as { studioUrl: string }).studioUrl),
      );
      await page.getByText("Project loaded", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Export", exact: true }).click();
      await page
        .getByLabel("Export preset", { exact: true })
        .selectOption(
          project.exportPresets.find((p) => p.container === "wav")!.id,
        );
      const output = path.join(f.root, "browser-original.wav");
      await page.getByLabel("Export output path", { exact: true }).fill(output);
      await page
        .getByRole("button", { name: "Queue render", exact: true })
        .click();
      let id = "";
      await until(async () => {
        const result = await cli.callTool({
            name: "list_export_history",
            arguments: { projectPath: f.projectPath },
          }),
          exports = (
            result.structuredContent as {
              exports: Array<{ id: string; status: string }>;
            }
          ).exports;
        id = exports[0]?.id ?? "";
        return exports[0]?.status === "completed";
      });
      const original = await readFile(output);
      await f.store.mutate(project.revision, [
        {
          type: "clip.update",
          sequenceId: seq.id,
          clipId: clip.id,
          patch: {
            name: "Later human edit",
            audio: { ...clip.audio, gainDb: -24 },
          },
        },
      ]);
      const edited = await f.store.read();
      await page.getByRole("button", { name: "Export", exact: true }).click();
      const history = page.getByRole("group", {
        name: "Export history",
        exact: true,
      });
      await history
        .getByRole("button", { name: "Refresh export history", exact: true })
        .click();
      await history
        .getByLabel("Saved export", { exact: true })
        .selectOption(id);
      await history
        .getByText("Output and source checksums", { exact: true })
        .click();
      await history.getByText(/SHA-256:/).waitFor();
      const downloadPromise = page.waitForEvent("download");
      await history
        .getByRole("button", {
          name: "Download saved export snapshot",
          exact: true,
        })
        .click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe("export-" + id + ".json");
      const snapshot = JSON.parse(
        await readFile((await download.path())!, "utf8"),
      );
      expect(snapshot.export.projectSnapshot.revision).toBe(project.revision);
      const destination = path.join(f.root, "browser-reproduced.wav");
      await history
        .getByLabel("Reproduced output path", { exact: true })
        .fill(destination);
      await history
        .getByRole("button", { name: "Reproduce saved export", exact: true })
        .click();
      await history
        .getByText(
          "Saved revision reproduced: " +
            path.join(
              await realpath(path.dirname(destination)),
              path.basename(destination),
            ),
          { exact: true },
        )
        .waitFor();
      expect(await readFile(destination)).toEqual(original);
      expect(await f.store.read()).toEqual(edited);
      await page.evaluate(axe.source, undefined, false);
      const result = await page.evaluate(
        async () =>
          await (window as unknown as { axe: typeof axe }).axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          }),
        undefined,
        false,
      );
      expect(
        result.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
      ).toEqual([]);
    } catch(error){
      failed=true;
      const redact=(value:string)=>value.replaceAll(providerSecret,"[provider secret redacted]").replace(/Bearer\s+[^\s"']+/gi,"Bearer [redacted]").replace(/([?&]token=)[^&\s"']+/g,"$1[redacted]");
      const diagnostic=redact(childStderr),cause=new Error(redact(String(error)));
      if(error instanceof Error&&error.stack)cause.stack=redact(error.stack);
      throw new Error(cause.message+(diagnostic?"; child stderr: "+diagnostic:"; child stderr was empty"),{cause});
    } finally {
      // Stop browser/CLI access before removing their project and provider fixture.
      const cleanup:unknown[]=[];
      for(const close of [()=>browser.close(),()=>cli.close(),()=>f.close()])try{await close();}catch(error){cleanup.push(error);}
      if(!failed&&cleanup.length)throw cleanup[0];
    }
  },
  120000,
);
