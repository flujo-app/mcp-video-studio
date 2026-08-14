import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultClip, framesToTicks } from "@mcp-video-studio/contracts";
import { ProjectStore } from "@mcp-video-studio/core";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("project transactions", () => {
  it("persists atomic edits and supports revision-safe undo/redo", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-store-")); roots.push(root);
    const store = await ProjectStore.create(root, "Edit test");
    const initial = await store.read();
    const sequence = initial.sequences[0]!;
    const track = sequence.tracks.find((item) => item.type === "video")!;
    const duration = framesToTicks(60, initial.settings.fps);
    const clip = defaultClip(track.id, { type: "color", color: "#336699" }, "Card", duration);

    const added = await store.mutate(0, [{ type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" }]);
    expect(added.revision).toBe(1);
    expect((await store.read()).sequences[0]!.clips).toHaveLength(1);

    const splitAt = framesToTicks(30, initial.settings.fps);
    await store.mutate(1, [{ type: "clip.split", sequenceId: sequence.id, clipId: clip.id, atTick: splitAt, rightClipId: "right-half" }]);
    expect((await store.read()).sequences[0]!.clips.map((item) => item.durationTick)).toEqual([splitAt, splitAt]);

    await store.undo(2);
    expect((await store.read()).sequences[0]!.clips).toHaveLength(1);
    await store.redo(3);
    expect((await store.read()).sequences[0]!.clips).toHaveLength(2);
  });

  it("rejects stale writers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-conflict-")); roots.push(root);
    const store = await ProjectStore.create(root, "Conflict test");
    await store.mutate(0, [{ type: "project.rename", name: "New name" }]);
    await expect(store.mutate(0, [{ type: "project.rename", name: "Stale" }])).rejects.toMatchObject({ name: "StudioException" });
  });
});
