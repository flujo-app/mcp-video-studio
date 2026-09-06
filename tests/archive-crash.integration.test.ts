import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, writeFile, readFile, rm, stat, open } from "node:fs/promises";
import { expect, it } from "vitest";
import { ProjectStore, sha256File } from "@mcp-video-studio/core";
import { exportProjectArchive } from "../packages/server/src/archive.js";
const integration = process.env.RUN_FFMPEG_INTEGRATION === "1" ? it : it.skip;
async function until(check: () => boolean | Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Crash fixture timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}
async function waitForPayloadWrite(
  root: string,
  journal: string,
  jobId: string,
) {
  let temporary = "",
    last: Record<string, unknown> = {};
  try {
    await until(async () => {
      const record = JSON.parse(await readFile(journal, "utf8"));
      const job = JSON.parse(
        await readFile(path.join(root, "jobs", jobId + ".json"), "utf8"),
      );
      temporary = record.temporary ?? "";
      last = {
        operationStatus: record.status,
        jobStatus: job.status,
        progress: job.progress,
        message: job.message,
        error: record.error ?? job.error,
        temporaryExists:
          !!temporary && !!(await stat(temporary).catch(() => undefined)),
      };
      if (
        ["completed", "failed", "cancelled"].includes(record.status) ||
        ["completed", "failed", "cancelled"].includes(job.status)
      )
        throw new Error(
          "Archive passed its crash checkpoint: " + JSON.stringify(last),
        );
      return (
        !!last.temporaryExists && job.status === "running" && job.progress > 0.1
      );
    });
  } catch (error) {
    throw new Error(
      String(error) + "; last durable archive state: " + JSON.stringify(last),
    );
  }
  return temporary;
}
async function session(root: string) {
  const child = spawn(
    process.execPath,
    [path.resolve("dist/index.js"), "--stdio"],
    {
      env: {
        ...process.env,
        VIDEO_STUDIO_DATA_DIR: root,
        VIDEO_STUDIO_GATEWAY_PORT: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let next = 1,
    stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const waiting = new Map<
    number,
    { resolve(value: Record<string, any>): void; reject(error: Error): void }
  >();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const msg = JSON.parse(line);
    const pending = waiting.get(msg.id);
    if (pending) {
      waiting.delete(msg.id);
      msg.error
        ? pending.reject(new Error(JSON.stringify(msg.error)))
        : pending.resolve(msg.result);
    }
  });
  child.on("error", (error) => {
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
  });
  child.on("exit", () => {
    for (const pending of waiting.values())
      pending.reject(new Error("Child exited: " + stderr));
    waiting.clear();
  });
  const rpc = (method: string, params: Record<string, unknown>) => {
    const id = next++;
    return new Promise<Record<string, any>>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  };
  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "archive-crash-fixture", version: "1" },
    capabilities: {},
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  return {
    child,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await rpc("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(JSON.stringify(result));
      return result.structuredContent as Record<string, any>;
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.stdin.end();
      });
    },
    async kill() {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    },
  };
}
integration(
  "actual stdio process hard-stop during export and import is reconciled on restart without deleting published data",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-archive-crash-")),
      store = await ProjectStore.create(
        path.join(root, "project"),
        "Crash acceptance",
      ),
      source = path.join(root, "large-source.bin");
    let running: Awaited<ReturnType<typeof session>> | undefined;
    try {
      const writer = await open(source, "wx");
      try {
        const chunk = Buffer.alloc(1024 * 1024, 73);
        for (let i = 0; i < 128; i++) await writer.writeFile(chunk);
        await writer.sync();
      } finally {
        await writer.close();
      }
      const hash = await sha256File(source);
      await store.replace(
        0,
        (project) => {
          project.media.push({
            id: "large-linked-source",
            name: "Owned fixture",
            kind: "audio",
            storage: { mode: "linked", path: source, mtimeMs: 0, ...hash },
            probe: { hasAudio: true, hasVideo: false, durationTick: 35280000 },
            createdAt: new Date().toISOString(),
          });
        },
        {
          sequences: [],
          tracks: [],
          clips: [],
          media: ["large-linked-source"],
          animations: [],
          generatedArtifacts: [],
        },
      );
      const output = path.join(root, "portable.mcpstudio");
      await writeFile(output, "prior completed export");
      running = await session(root);
      const exported = await running.call("export_project_archive", {
        projectPath: store.root,
        outputPath: output,
        expectedRevision: 1,
      });
      const journal = path.join(
        root,
        "archive-operations",
        exported.operationId + ".json",
      );
      // NTFS may not expose a writer's updated file size until the handle closes.
      // A durable progress update follows an actual awaited payload write on every OS.
      const temporary = await waitForPayloadWrite(
        root,
        journal,
        exported.job.id,
      );
      await running.kill();
      running = undefined;
      expect(await readFile(output, "utf8")).toBe("prior completed export");
      running = await session(root);
      const after = await running.call("list_archive_operations");
      expect(
        after.operations.find(
          (op: { id: string }) => op.id === exported.operationId,
        ).status,
      ).toBe("interrupted");
      await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
      await running.close();
      running = undefined;
      await exportProjectArchive(store.root, output, 1);
      const destination = path.join(root, "restored");
      running = await session(root);
      const imported = await running.call("import_project_archive", {
        filePath: output,
        destinationPath: destination,
      });
      const importJournal = path.join(
        root,
        "archive-operations",
        imported.operationId + ".json",
      );
      const staging = await waitForPayloadWrite(
        root,
        importJournal,
        imported.job.id,
      );
      await running.kill();
      running = undefined;
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      running = await session(root);
      const restored = await running.call("list_archive_operations");
      expect(
        restored.operations.find(
          (op: { id: string }) => op.id === imported.operationId,
        ).status,
      ).toBe("interrupted");
      await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await sha256File(source)).toEqual(hash);
      expect((await stat(output)).size).toBeGreaterThan(128 * 1024 * 1024);
    } finally {
      await running?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
