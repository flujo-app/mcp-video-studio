import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile, stat, utimes, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { ProjectStore, sha256File } from "@mcp-video-studio/core";
import { inspectMedia } from "@mcp-video-studio/media";
it("inspection detects equal-size changed bytes even when linked timestamps are preserved and continues through offline media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-inspect-source-")),
    source = path.join(root, "linked.bin"),
    store = await ProjectStore.create(
      path.join(root, "project"),
      "Source inspection",
    );
  try {
    await writeFile(source, "original bytes");
    const hash = await sha256File(source),
      info = await stat(source);
    await store.replace(
      0,
      (project) => {
        project.media.push(
          {
            id: "linked",
            name: "Linked",
            kind: "audio",
            storage: {
              mode: "linked",
              path: source,
              mtimeMs: info.mtimeMs,
              ...hash,
            },
            probe: { hasAudio: true, hasVideo: false, durationTick: 1 },
            createdAt: new Date().toISOString(),
          },
          {
            id: "missing",
            name: "Offline",
            kind: "audio",
            storage: {
              mode: "linked",
              path: path.join(root, "absent"),
              mtimeMs: 0,
              ...hash,
            },
            probe: { hasAudio: true, hasVideo: false, durationTick: 1 },
            createdAt: new Date().toISOString(),
          },
        );
      },
      {
        sequences: [],
        tracks: [],
        clips: [],
        media: ["linked", "missing"],
        animations: [],
        generatedArtifacts: [],
      },
    );
    await writeFile(source, "modified bytes");
    await utimes(source, info.atime, info.mtime);
    const result = await inspectMedia(store);
    expect(result[0]).toMatchObject({
      available: true,
      changedOnDisk: true,
      actualBytes: hash.bytes,
    });
    expect(result[0]!.actualSha256).not.toBe(hash.sha256);
    expect(result[1]).toMatchObject({ available: false, actualBytes: null });
    await writeFile(source, "original bytes");
    await utimes(source, new Date(), new Date());
    expect((await inspectMedia(store, ["linked"]))[0]).toMatchObject({
      available: true,
      changedOnDisk: false,
      actualSha256: hash.sha256,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
