import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultProject, defaultClip, framesToTicks, type GeneratedArtifact, type MediaAsset } from "@mcp-video-studio/contracts";
import { ProjectStore, validateProject } from "@mcp-video-studio/core";
import { loadConfig } from "@mcp-video-studio/media";
import { GenerationProviders } from "../packages/server/src/generation.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function artifactHash(character: string): string { return character.repeat(64); }

describe("generated artifact lifecycle", () => {
  it("normalizes projects created before generated artifacts were introduced", () => {
    const legacy = createDefaultProject("Legacy");
    delete (legacy as unknown as { generatedArtifacts?: unknown[] }).generatedArtifacts;
    expect(validateProject(legacy).generatedArtifacts).toEqual([]);
  });

  it("activates an audio version without replacing clip-level edits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-generation-")); roots.push(root);
    const store = await ProjectStore.create(root, "Generated lifecycle");
    const initial = await store.read();
    const sequence = initial.sequences[0]!;
    const track = sequence.tracks.find((item) => item.type === "audio")!;
    const durationTick = framesToTicks(90, initial.settings.fps);
    const media = ["a", "b"].map((character, index): MediaAsset => ({
      id: `media-${character}`, name: `take-${index + 1}.wav`, kind: "audio", mimeType: "audio/wav",
      storage: { mode: "managed", sha256: artifactHash(character), relativePath: `assets/${character}.wav`, bytes: 1 },
      probe: { durationTick, hasVideo: false, hasAudio: true, sampleRate: 48000, channels: 2 }, createdAt: new Date().toISOString()
    }));
    const clip = defaultClip(track.id, { type: "media", mediaId: media[0]!.id }, "Narration", durationTick);
    clip.id = "narration-clip"; clip.audio.gainDb = -4; clip.effects.push({ id: "filter", type: "brightness", enabled: true, parameters: { value: 0.2 }, version: 1 });
    await store.replace(initial.revision, (project) => { project.media.push(...media); project.sequences[0]!.clips.push(clip); }, { sequences: [sequence.id], tracks: [], clips: [clip.id], media: media.map((item) => item.id), animations: [], generatedArtifacts: [] });
    const request = { provider: "elevenlabs", text: "Take one" };
    const generated: GeneratedArtifact = {
      id: "artifact", kind: "narration", name: "Narration", scope: { sequenceId: sequence.id, trackId: track.id, clipId: clip.id, startTick: 0, durationTick }, activeVersionId: "v1",
      versions: [
        { id: "v1", status: "draft", request, provenance: { provider: "elevenlabs", model: "voice", requestHash: artifactHash("c"), sourceRevision: 1 }, createdAt: new Date().toISOString(), output: { mediaId: media[0]!.id } },
        { id: "v2", parentVersionId: "v1", status: "draft", request: { ...request, text: "Take two" }, provenance: { provider: "elevenlabs", model: "voice", requestHash: artifactHash("d"), sourceRevision: 1 }, createdAt: new Date().toISOString(), output: { mediaId: media[1]!.id } }
      ]
    };
    await store.mutate(1, [{ type: "generation.create", artifact: generated }]);
    await store.mutate(2, [{ type: "generation.version.activate", artifactId: generated.id, versionId: "v2" }]);
    const result = await store.read();
    const edited = result.sequences[0]!.clips.find((item) => item.id === clip.id)!;
    expect(edited.source).toEqual({ type: "media", mediaId: "media-b" });
    expect(edited.audio.gainDb).toBe(-4);
    expect(edited.effects).toEqual(clip.effects);
    expect(result.generatedArtifacts[0]!.activeVersionId).toBe("v2");
  });

  it("replaces only cues owned by the activated caption version", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-caption-generation-")); roots.push(root);
    const store = await ProjectStore.create(root, "Caption lifecycle");
    const project = await store.read();
    const sequence = project.sequences[0]!;
    const track = sequence.tracks.find((item) => item.type === "caption")!;
    const durationTick = framesToTicks(60, project.settings.fps);
    const style = { fontFamily: "Arial", fontSize: 54, color: "#fff", background: "#000a", position: "bottom" as const, align: "center" as const };
    const artifact: GeneratedArtifact = {
      id: "captions", kind: "captions", name: "Transcript", scope: { sequenceId: sequence.id, trackId: track.id, startTick: 0, durationTick }, activeVersionId: "old",
      versions: [
        { id: "old", status: "draft", request: { provider: "openai", sourceMediaId: "source" }, provenance: { provider: "openai", model: "whisper", requestHash: artifactHash("e"), sourceRevision: 0 }, createdAt: new Date().toISOString(), output: { captions: [{ id: "old-cue", trackId: track.id, startTick: 0, durationTick, text: "Old", style }] } },
        { id: "new", status: "draft", request: { provider: "openai", sourceMediaId: "source" }, provenance: { provider: "openai", model: "whisper", requestHash: artifactHash("f"), sourceRevision: 0 }, createdAt: new Date().toISOString(), output: { captions: [{ id: "new-cue", trackId: track.id, startTick: 0, durationTick, text: "New", style }] } }
      ]
    };
    await store.replace(0, (draft) => { draft.generatedArtifacts.push(artifact); draft.sequences[0]!.captions.push(artifact.versions[0]!.output!.captions![0]!); }, { sequences: [sequence.id], tracks: [], clips: [], media: [], animations: [], generatedArtifacts: [artifact.id] });
    await store.mutate(1, [{ type: "generation.version.activate", artifactId: artifact.id, versionId: "new" }]);
    await store.mutate(2, [{ type: "caption.update", sequenceId: sequence.id, captionId: "new-cue", patch: { text: "Human revision" } }]);
    const result = await store.read();
    expect(result.sequences[0]!.captions.map((caption) => caption.text)).toEqual(["Human revision"]);
    expect(result.generatedArtifacts[0]!.versions.find((version) => version.id === "new")!.output!.captions![0]!.text).toBe("Human revision");
  });
});

describe("direct provider adapters", () => {
  it("supports an OpenAI-compatible custom base URL without requiring MCP sampling", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      requests.push({ url: request.url ?? "", body });
      response.writeHead(200, { "content-type": "application/json", "x-request-id": "req-local" });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ id: "ignored", name: "Ignored", durationTick: 1, canvas: { width: 1, height: 1, background: "transparent" }, seed: 1, mode: "declarative", nodes: [], operations: [] }) } }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock provider did not start");
    try {
      const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-provider-")); roots.push(root);
      const config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root, VIDEO_STUDIO_LANGUAGE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, VIDEO_STUDIO_LANGUAGE_PROTOCOL: "chat_completions", VIDEO_STUDIO_LANGUAGE_MODEL: "local-model", OPENAI_API_KEY: "" });
      const providers = new GenerationProviders(config);
      const result = await providers.generateAnimation({ provider: "language", prompt: "A simple title" }, { name: "Generated", durationTick: 35_280_000, canvas: { width: 320, height: 180 }, fps: { numerator: 30, denominator: 1 } });
      expect(result.animation).toMatchObject({ name: "Generated", durationTick: 35_280_000, canvas: { width: 320, height: 180 }, mode: "declarative" });
      expect(result.model).toBe("local-model");
      expect(requests[0]!.url).toBe("/v1/chat/completions");
      expect(requests[0]!.body).toMatchObject({ model: "local-model" });
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
