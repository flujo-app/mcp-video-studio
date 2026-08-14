import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pruneRenderCache, renderCacheStats } from "@mcp-video-studio/renderer";

describe("persistent render cache", () => {
  it("accounts artifacts and evicts the oldest entries within budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-cache-"));
    try {
      const directory = path.join(root, "cache", "renders");
      await mkdir(directory, { recursive: true });
      const oldArtifact = path.join(directory, "old.mp4");
      const newArtifact = path.join(directory, "new.mp4");
      await Promise.all([writeFile(oldArtifact, "old!"), writeFile(`${oldArtifact}.json`, "{}"), writeFile(newArtifact, "new!"), writeFile(`${newArtifact}.json`, "{}")]);
      await utimes(oldArtifact, new Date(1_000), new Date(1_000));
      await utimes(newArtifact, new Date(2_000), new Date(2_000));
      expect(await renderCacheStats(root)).toMatchObject({ artifactCount: 2, totalBytes: 8 });
      const pruned = await pruneRenderCache(root, 4, newArtifact);
      expect(pruned).toMatchObject({ artifactCount: 1, totalBytes: 4, removedArtifacts: 1, freedBytes: 4 });
      await expect(stat(oldArtifact)).rejects.toBeDefined();
      await expect(stat(`${oldArtifact}.json`)).rejects.toBeDefined();
      expect((await stat(newArtifact)).size).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
