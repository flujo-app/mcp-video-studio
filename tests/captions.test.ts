import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDefaultProject, framesToTicks } from "@mcp-video-studio/contracts";
import { ProjectStore, validateProject } from "@mcp-video-studio/core";

describe("caption cues", () => {
  it("normalizes legacy sequences that predate first-class captions", () => {
    const legacy = createDefaultProject("Legacy");
    delete (legacy.sequences[0] as unknown as { captions?: unknown[] }).captions;
    expect(validateProject(legacy).sequences[0]!.captions).toEqual([]);
  });

  it("adds, updates, and removes a frame-aligned cue transactionally", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-caption-"));
    try {
      const store = await ProjectStore.create(root, "Captions");
      const project = await store.read();
      const sequence = project.sequences[0]!;
      const track = sequence.tracks.find((item) => item.type === "caption")!;
      const cue = { id: "cue-1", trackId: track.id, startTick: 0, durationTick: framesToTicks(60, project.settings.fps), text: "Original", style: { fontFamily: "Arial", fontSize: 54, color: "#ffffff", background: "#000000aa", position: "bottom" as const, align: "center" as const } };
      await store.mutate(project.revision, [{ type: "caption.add", sequenceId: sequence.id, caption: cue }]);
      await store.mutate(1, [{ type: "caption.update", sequenceId: sequence.id, captionId: cue.id, patch: { text: "Updated", style: { ...cue.style, position: "top" } } }]);
      expect((await store.read()).sequences[0]!.captions[0]).toMatchObject({ text: "Updated", style: { position: "top" } });
      await store.mutate(2, [{ type: "caption.remove", sequenceId: sequence.id, captionIds: [cue.id] }]);
      expect((await store.read()).sequences[0]!.captions).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
