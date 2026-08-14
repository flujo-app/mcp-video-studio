import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { asStudioError, StudioException } from "@mcp-video-studio/core";
import type { AnimationDocument, ClipSource, GenerationRequest, ProjectCommand } from "@mcp-video-studio/contracts";
import { createStudioAppHtml } from "./app-view.js";
import type { Gateway } from "./gateway.js";
import type { StudioRuntime } from "./runtime.js";

const APP_URI = "ui://mcp-video-studio/studio-v1.html";

function output(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
}

async function invoke(operation: () => Promise<Record<string, unknown>>) {
  try { return output(await operation()); }
  catch (error) {
    const data = { success: false, error: asStudioError(error) };
    return { ...output(data), isError: true };
  }
}

export function createMcpServer(runtime: StudioRuntime, gateway: Gateway): McpServer {
  const server = new McpServer({ name: "mcp-video-studio", version: "0.1.0" }, { capabilities: { logging: {} } });
  const projectRevision = { projectPath: z.string().min(1), expectedRevision: z.number().int().nonnegative() };
  const captionStyle = z.object({ fontFamily: z.string().min(1), fontSize: z.number().positive(), color: z.string().min(1), background: z.string().min(1), position: z.enum(["top", "center", "bottom"]), align: z.enum(["left", "center", "right"]) });
  const generationScope = { ...projectRevision, sequenceId: z.string(), trackId: z.string(), clipId: z.string().optional(), startTick: z.number().int().nonnegative(), durationTick: z.number().int().positive(), name: z.string().min(1) };
  const requestPatch = z.object({ provider: z.string(), model: z.string(), prompt: z.string(), text: z.string(), voiceId: z.string(), language: z.string(), sourceMediaId: z.string(), seed: z.number().int(), outputFormat: z.string(), parameters: z.record(z.string(), z.unknown()) }).partial();

  registerAppTool(server, "open_studio", {
    title: "Open Video Studio",
    description: "Open the full human video editor. Optionally opens a project path.",
    inputSchema: { projectPath: z.string().optional() },
    _meta: { ui: { resourceUri: APP_URI, visibility: ["model"] }, "openai/outputTemplate": APP_URI },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath }) => invoke(async () => ({ success: true, studioUrl: `${gateway.origin}/?token=${encodeURIComponent(gateway.token)}${projectPath ? `&projectPath=${encodeURIComponent(projectPath)}` : ""}`, ...(projectPath ? await runtime.getProject(projectPath) : await runtime.listProjects()) })));

  registerAppResource(server, "MCP Video Studio", APP_URI, {
    description: "Interactive multi-track video and animation editor.",
    _meta: { ui: { csp: { frameDomains: [gateway.origin] }, prefersBorder: false } }
  }, async () => ({
    contents: [{
      uri: APP_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: createStudioAppHtml(`${gateway.origin}/?token=${encodeURIComponent(gateway.token)}`),
      _meta: { ui: { csp: { frameDomains: [gateway.origin] }, prefersBorder: false } }
    }]
  }));

  server.registerTool("doctor", {
    title: "Diagnose Video Studio",
    description: "Check FFmpeg, ffprobe, storage, runtime, and configuration.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => invoke(() => runtime.doctor()));

  server.registerTool("list_projects", {
    description: "List standalone Studio projects in the configured project directory.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => invoke(() => runtime.listProjects()));

  server.registerTool("create_project", {
    description: "Create a standalone video project with a main sequence, tracks, and export presets.",
    inputSchema: { name: z.string().min(1), projectPath: z.string().optional() },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ name, projectPath }) => invoke(() => runtime.createProject(name, projectPath)));

  server.registerTool("get_project", {
    description: "Read the complete canonical project document and summary.",
    inputSchema: { projectPath: z.string().min(1) },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath }) => invoke(() => runtime.getProject(projectPath)));

  server.registerTool("open_project", {
    description: "Open and validate a standalone project path.",
    inputSchema: { projectPath: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath }) => invoke(() => runtime.getProject(projectPath)));

  server.registerTool("get_project_summary", {
    description: "Get project summary data and revision. The canonical document is included for clients that need it.",
    inputSchema: { projectPath: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath }) => invoke(() => runtime.getProject(projectPath)));

  server.registerTool("get_sequence", {
    description: "Read one sequence including tracks, clips, captions, transitions, automation, and markers.",
    inputSchema: { projectPath: z.string().min(1), sequenceId: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath, sequenceId }) => invoke(() => runtime.getSequence(projectPath, sequenceId)));

  server.registerTool("import_media", {
    description: "Import or link media, probe it, and queue proxy, thumbnail, and waveform jobs.",
    inputSchema: { ...projectRevision, filePath: z.string().min(1), storageMode: z.enum(["managed", "linked"]).default("managed") },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async (input) => invoke(() => runtime.import(input)));

  server.registerTool("relink_media", {
    description: "Relink an offline or changed asset to a local file and refresh its hash/probe metadata.",
    inputSchema: { ...projectRevision, mediaId: z.string(), filePath: z.string() }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async (input) => invoke(() => runtime.relink(input)));

  server.registerTool("consolidate_media", {
    description: "Copy linked assets into the portable project asset store.",
    inputSchema: { ...projectRevision, mediaIds: z.array(z.string()).optional() }, annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, mediaIds }) => invoke(() => runtime.consolidate({ projectPath, expectedRevision, ...(mediaIds ? { mediaIds } : {}) })));

  server.registerTool("inspect_media", {
    description: "Inspect asset availability, linked-file changes, normalized probes, and resolved paths.",
    inputSchema: { projectPath: z.string(), mediaIds: z.array(z.string()).optional() }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath, mediaIds }) => invoke(() => runtime.inspect(projectPath, mediaIds)));

  server.registerTool("get_cache_status", {
    description: "Inspect persistent render-cache usage and the configured byte budget for a project.",
    inputSchema: { projectPath: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath }) => invoke(() => runtime.cacheStatus(projectPath)));

  server.registerTool("create_proxies", {
    description: "Queue proxies, thumbnails, and waveforms for selected media.",
    inputSchema: { projectPath: z.string(), mediaIds: z.array(z.string()).optional() }, annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, mediaIds }) => invoke(() => runtime.createMediaArtifacts(projectPath, mediaIds)));

  server.registerTool("extract_frames", {
    description: "Queue exact-time frame extraction for a media asset.",
    inputSchema: { projectPath: z.string(), mediaId: z.string(), timesTick: z.array(z.number().int().nonnegative()).min(1).max(100) }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath, mediaId, timesTick }) => invoke(() => runtime.extractFrames(projectPath, mediaId, timesTick)));

  server.registerTool("apply_timeline_transaction", {
    description: "Atomically apply ordered timeline commands with optimistic revision checking.",
    inputSchema: { ...projectRevision, commands: z.array(z.unknown()).min(1) },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, commands }) => invoke(() => runtime.apply(projectPath, expectedRevision, commands as ProjectCommand[])));

  server.registerTool("add_track", {
    description: "Add a video, audio, overlay, or caption track.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), trackType: z.enum(["video", "audio", "overlay", "caption"]), name: z.string().optional() },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, trackType, name }) => invoke(() => runtime.addTrack(projectPath, expectedRevision, sequenceId, trackType, name)));

  server.registerTool("update_track", {
    description: "Update track name, order, lock, mute, solo, visibility, gain, or pan.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), trackId: z.string(), patch: z.record(z.string(), z.unknown()) }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, trackId, patch }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "track.update", sequenceId, trackId, patch: patch as never }])));

  server.registerTool("remove_track", {
    description: "Remove a track, optionally removing all clips on it.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), trackId: z.string(), removeClips: z.boolean().default(false) }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, ...command }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "track.remove", ...command }])));

  server.registerTool("add_clip", {
    description: "Add a media, animation, color, or nested-sequence clip to a track.",
    inputSchema: {
      ...projectRevision, sequenceId: z.string(), trackId: z.string(), name: z.string(), startTick: z.number().int().nonnegative(), durationTick: z.number().int().positive(),
      source: z.discriminatedUnion("type", [z.object({ type: z.literal("media"), mediaId: z.string() }), z.object({ type: z.literal("animation"), animationId: z.string() }), z.object({ type: z.literal("color"), color: z.string() }), z.object({ type: z.literal("sequence"), sequenceId: z.string() })]),
      mode: z.enum(["overwrite", "insert", "ripple", "replace"]).default("overwrite")
    },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async (input) => invoke(() => runtime.addClip({ ...input, source: input.source as ClipSource })));

  server.registerTool("move_clips", {
    description: "Move one or more clips while preserving their relative timing.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), clipIds: z.array(z.string()).min(1), targetTrackId: z.string(), startTick: z.number().int().nonnegative(), ripple: z.boolean().default(false) },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, ...command }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "clip.move", ...command }])));

  server.registerTool("trim_clip", {
    description: "Trim a clip at its in or out edge.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), clipId: z.string(), edge: z.enum(["in", "out"]), tick: z.number().int().nonnegative(), ripple: z.boolean().default(false) },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, ...command }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "clip.trim", ...command }])));

  server.registerTool("split_clip", {
    description: "Split a clip at an absolute timeline tick.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), clipId: z.string(), atTick: z.number().int().nonnegative(), rightClipId: z.string().default(() => randomUUID()) },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, ...command }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "clip.split", ...command }])));

  server.registerTool("remove_clips", {
    description: "Remove clips, optionally ripple-closing the removed span.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), clipIds: z.array(z.string()).min(1), ripple: z.boolean().default(false) },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, ...command }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "clip.remove", ...command }])));

  server.registerTool("update_clip", {
    description: "Update clip transforms, crop, playback rate, effects, audio, or metadata.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), clipId: z.string(), patch: z.record(z.string(), z.unknown()) },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, clipId, patch }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "clip.update", sequenceId, clipId, patch: patch as never }])));

  server.registerTool("duplicate_clips", {
    description: "Duplicate clips with fresh IDs and an optional timeline offset.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), clipIds: z.array(z.string()).min(1), offsetTick: z.number().int().default(0) }, annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, clipIds, offsetTick }) => invoke(async () => {
    const snapshot = await runtime.getSequence(projectPath, sequenceId) as { sequence: { clips: Array<Record<string, unknown> & { id: string; startTick: number }> } };
    const commands = clipIds.map((id) => {
      const existing = snapshot.sequence.clips.find((clip) => clip.id === id);
      if (!existing) throw new StudioException("CLIP_NOT_FOUND", `Clip not found: ${id}`, "input");
      return { type: "clip.add" as const, sequenceId, clip: { ...structuredClone(existing), id: randomUUID(), startTick: existing.startTick + offsetTick } as never, mode: "overwrite" as const };
    });
    return runtime.apply(projectPath, expectedRevision, commands);
  }));

  server.registerTool("group_clips", {
    description: "Assign clips to a shared editable group, or clear the group.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), clipIds: z.array(z.string()).min(1), groupId: z.string().nullable().optional() }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, clipIds, groupId }) => invoke(() => runtime.apply(projectPath, expectedRevision, clipIds.map((clipId) => ({ type: "clip.update", sequenceId, clipId, patch: { groupId: groupId ?? undefined } })) as ProjectCommand[])));

  server.registerTool("link_clips", {
    description: "Assign clips to a shared A/V link group, or clear the link.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), clipIds: z.array(z.string()).min(1), linkedGroupId: z.string().nullable().optional() }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, clipIds, linkedGroupId }) => invoke(() => runtime.apply(projectPath, expectedRevision, clipIds.map((clipId) => ({ type: "clip.update", sequenceId, clipId, patch: { linkedGroupId: linkedGroupId ?? undefined } })) as ProjectCommand[])));

  server.registerTool("add_transition", {
    description: "Add a typed transition between two clips.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), transition: z.unknown() }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, transition }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "transition.add", sequenceId, transition: transition as never }])));

  server.registerTool("update_transition", {
    description: "Update transition type, duration, or parameters.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), transitionId: z.string(), patch: z.record(z.string(), z.unknown()) }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, transitionId, patch }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "transition.update", sequenceId, transitionId, patch: patch as never }])));

  server.registerTool("remove_transition", {
    description: "Remove a transition.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), transitionId: z.string() }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, ...command }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "transition.remove", ...command }])));

  server.registerTool("set_automation_lane", {
    description: "Create or replace tick-based property automation.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), lane: z.unknown() }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, lane }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "automation.set", sequenceId, lane: lane as never }])));

  server.registerTool("add_marker", {
    description: "Add a timeline marker.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), marker: z.unknown() }, annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, marker }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "marker.add", sequenceId, marker: marker as never }])));

  server.registerTool("add_caption", {
    description: "Add an editable, frame-aligned caption cue to a caption track.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), trackId: z.string(), captionId: z.string().default(() => randomUUID()), startTick: z.number().int().nonnegative(), durationTick: z.number().int().positive(), text: z.string().min(1), style: captionStyle.optional() },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, trackId, captionId, startTick, durationTick, text, style }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "caption.add", sequenceId, caption: { id: captionId, trackId, startTick, durationTick, text, style: style ?? { fontFamily: "Arial", fontSize: 54, color: "#ffffff", background: "#000000aa", position: "bottom", align: "center" } } }] )));

  server.registerTool("update_caption", {
    description: "Update caption timing, text, track, or visual style.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), captionId: z.string(), patch: z.object({ trackId: z.string(), startTick: z.number().int().nonnegative(), durationTick: z.number().int().positive(), text: z.string().min(1), style: captionStyle }).partial() },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, captionId, patch }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "caption.update", sequenceId, captionId, patch: patch as never }] )));

  server.registerTool("remove_captions", {
    description: "Remove one or more caption cues.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), captionIds: z.array(z.string()).min(1) },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, captionIds }) => invoke(() => runtime.apply(projectPath, expectedRevision, [{ type: "caption.remove", sequenceId, captionIds }] )));

  server.registerTool("get_generation_providers", {
    description: "List redacted direct-generation provider capabilities and configuration status. Credentials are never returned.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => invoke(() => runtime.getProviderStatus()));

  server.registerTool("list_generated_artifacts", {
    description: "List persisted narration, music, caption, and animation artifacts with every version, provenance record, timeline binding, and review status.",
    inputSchema: { projectPath: z.string().min(1) }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath }) => invoke(() => runtime.listGeneratedArtifacts(projectPath)));

  server.registerTool("generate_narration", {
    description: "Queue versioned narration generation and bind the first draft to an audio clip. Later versions preserve the clip's timing, effects, and mix settings until explicitly activated.",
    inputSchema: { ...generationScope, text: z.string().min(1), provider: z.enum(["openai", "elevenlabs"]), model: z.string().optional(), voiceId: z.string().optional(), language: z.string().optional(), seed: z.number().int().optional(), parameters: z.record(z.string(), z.unknown()).optional() },
    annotations: { destructiveHint: true, openWorldHint: true }
  }, async ({ clipId, model, voiceId, language, seed, parameters, ...input }) => invoke(() => runtime.generateNarration({ ...input, ...(clipId ? { clipId } : {}), ...(model ? { model } : {}), ...(voiceId ? { voiceId } : {}), ...(language ? { language } : {}), ...(seed !== undefined ? { seed } : {}), ...(parameters ? { parameters } : {}) })));

  server.registerTool("generate_music", {
    description: "Queue a versioned ElevenLabs music draft for a bounded timeline slot.",
    inputSchema: { ...generationScope, prompt: z.string().min(1), model: z.string().optional(), seed: z.number().int().optional(), parameters: z.record(z.string(), z.unknown()).optional() },
    annotations: { destructiveHint: true, openWorldHint: true }
  }, async ({ clipId, model, seed, parameters, ...input }) => invoke(() => runtime.generateMusic({ ...input, ...(clipId ? { clipId } : {}), ...(model ? { model } : {}), ...(seed !== undefined ? { seed } : {}), ...(parameters ? { parameters } : {}) })));

  server.registerTool("generate_captions", {
    description: "Transcribe a source media asset into editable, frame-aligned caption cues and store the transcript as a reviewable generated version.",
    inputSchema: { ...generationScope, sourceMediaId: z.string(), provider: z.enum(["openai", "elevenlabs"]), model: z.string().optional(), language: z.string().optional(), parameters: z.record(z.string(), z.unknown()).optional() },
    annotations: { destructiveHint: true, openWorldHint: true }
  }, async ({ clipId: _clipId, model, language, parameters, ...input }) => invoke(() => runtime.generateCaptions({ ...input, ...(model ? { model } : {}), ...(language ? { language } : {}), ...(parameters ? { parameters } : {}) })));

  server.registerTool("generate_animation", {
    description: "Use the configured OpenAI-compatible language provider to create a validated declarative animation draft and bind its first version to the timeline.",
    inputSchema: { ...generationScope, prompt: z.string().min(1), model: z.string().optional(), seed: z.number().int().optional(), parameters: z.record(z.string(), z.unknown()).optional() },
    annotations: { destructiveHint: true, openWorldHint: true }
  }, async ({ clipId, model, seed, parameters, ...input }) => invoke(() => runtime.generateAnimation({ ...input, ...(clipId ? { clipId } : {}), ...(model ? { model } : {}), ...(seed !== undefined ? { seed } : {}), ...(parameters ? { parameters } : {}) })));

  server.registerTool("regenerate_generated_artifact", {
    description: "Create a child draft from an existing generated artifact, optionally replacing only prompt/text/voice/provider/model parameters. The active timeline version is unchanged until review.",
    inputSchema: { ...projectRevision, artifactId: z.string(), requestPatch: requestPatch.optional() },
    annotations: { destructiveHint: true, openWorldHint: true }
  }, async ({ requestPatch: patch, ...input }) => invoke(() => runtime.regenerateGeneratedArtifact({ ...input, ...(patch ? { requestPatch: patch as Partial<GenerationRequest> } : {}) })));

  server.registerTool("review_generated_version", {
    description: "Activate, approve, or reject a generated version. Activation swaps the bound source while preserving downstream clip edits; caption activation replaces only artifact-owned cues.",
    inputSchema: { ...projectRevision, artifactId: z.string(), versionId: z.string(), action: z.enum(["activate", "approve", "reject"]), reviewer: z.string().min(1), note: z.string().optional() },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ note, ...input }) => invoke(() => runtime.reviewGeneratedVersion({ ...input, ...(note ? { note } : {}) })));

  server.registerTool("set_animation", {
    description: "Create or replace a deterministic declarative animation document.",
    inputSchema: { ...projectRevision, animation: z.unknown() },
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, animation }) => invoke(() => runtime.setAnimation(projectPath, expectedRevision, animation as AnimationDocument)));

  server.registerTool("get_animation", {
    description: "Read a declarative or HTML animation document.",
    inputSchema: { projectPath: z.string(), animationId: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath, animationId }) => invoke(() => runtime.getAnimation(projectPath, animationId)));

  server.registerTool("validate_animation", {
    description: "Validate an animation against the canonical schema and project references without mutating the project.",
    inputSchema: { projectPath: z.string(), animation: z.unknown() }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ projectPath, animation }) => invoke(() => runtime.validateAnimation(projectPath, animation as AnimationDocument)));

  server.registerTool("create_animation_clip", {
    description: "Atomically store an animation and add it as an ordinary timeline clip.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), trackId: z.string(), startTick: z.number().int().nonnegative(), animation: z.unknown(), mode: z.enum(["overwrite", "insert", "ripple", "replace"]).default("overwrite") }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ animation, ...input }) => invoke(() => runtime.createAnimationClip({ ...input, animation: animation as AnimationDocument })));

  server.registerTool("import_html_animation", {
    description: "Create a self-contained offline HTML5 animation and add it to the timeline. HTML may define window.renderFrame(state).",
    inputSchema: { ...projectRevision, sequenceId: z.string(), trackId: z.string(), name: z.string(), html: z.string().min(1), startTick: z.number().int().nonnegative(), durationTick: z.number().int().positive(), seed: z.number().int().default(1) }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision, sequenceId, trackId, name, html, startTick, durationTick, seed }) => invoke(async () => {
    const result = await runtime.getProject(projectPath) as { project: { settings: { raster: { width: number; height: number } } } };
    const animation: AnimationDocument = { id: randomUUID(), name, html, durationTick, canvas: { ...result.project.settings.raster, background: "transparent" }, seed, mode: "html", nodes: [], operations: [] };
    return runtime.createAnimationClip({ projectPath, expectedRevision, sequenceId, trackId, startTick, animation });
  }));

  server.registerTool("add_title", {
    description: "Add an editable animated title clip.",
    inputSchema: { ...projectRevision, sequenceId: z.string(), trackId: z.string(), text: z.string(), startTick: z.number().int().nonnegative(), durationTick: z.number().int().positive(), fontSize: z.number().positive().optional(), color: z.string().optional() }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ fontSize, color, ...input }) => invoke(() => runtime.addTitle({ ...input, ...(fontSize !== undefined ? { fontSize } : {}), ...(color !== undefined ? { color } : {}) })));

  server.registerTool("render_animation_preview", {
    description: "Queue an exact-frame lossless preview render for an animation document.",
    inputSchema: { projectPath: z.string(), animationId: z.string(), outputPath: z.string() }, annotations: { destructiveHint: false, openWorldHint: false }
  }, async (input) => invoke(() => runtime.renderAnimationPreview(input)));

  server.registerTool("undo", {
    description: "Undo the latest project transaction.", inputSchema: projectRevision,
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision }) => invoke(() => runtime.undo(projectPath, expectedRevision)));

  server.registerTool("redo", {
    description: "Redo the latest undone project transaction.", inputSchema: projectRevision,
    annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ projectPath, expectedRevision }) => invoke(() => runtime.redo(projectPath, expectedRevision)));

  server.registerTool("render_sequence", {
    description: "Queue a deterministic FFmpeg render of a sequence.",
    inputSchema: { projectPath: z.string(), sequenceId: z.string(), presetId: z.string(), outputPath: z.string() },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async (input) => invoke(() => runtime.render(input)));

  server.registerTool("run_qc", {
    description: "Queue full-decode QC with raster, duration, faststart, loudness, peak, and checksum checks.",
    inputSchema: { projectPath: z.string(), sequenceId: z.string(), filePath: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async (input) => invoke(() => runtime.qc(input)));

  server.registerTool("list_jobs", {
    description: "List render, proxy, waveform, animation, and QC jobs.",
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => invoke(async () => ({ success: true, jobs: runtime.jobs.list() })));

  server.registerTool("get_job", {
    description: "Get one background job and its result or structured error.",
    inputSchema: { jobId: z.string() }, annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ jobId }) => invoke(async () => {
    const job = runtime.jobs.get(jobId);
    if (!job) throw new StudioException("JOB_NOT_FOUND", `Job not found: ${jobId}`, "input");
    return { success: true, job };
  }));

  server.registerTool("cancel_job", {
    description: "Cancel a queued or running job and its process tree.",
    inputSchema: { jobId: z.string() }, annotations: { destructiveHint: true, openWorldHint: false }
  }, async ({ jobId }) => invoke(async () => ({ success: true, job: await runtime.jobs.cancel(jobId) })));

  server.registerTool("compose_video", {
    description: "High-level workflow: create a standalone project, import media in order, arrange clips, and optionally queue a render.",
    inputSchema: { name: z.string().min(1), projectPath: z.string().optional(), mediaPaths: z.array(z.string()).min(1), imageDurationSeconds: z.number().positive().default(5), outputPath: z.string().optional() },
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ name, projectPath, mediaPaths, imageDurationSeconds, outputPath }) => invoke(() => runtime.compose({ name, mediaPaths, imageDurationSeconds, ...(projectPath ? { projectPath } : {}), ...(outputPath ? { outputPath } : {}) })));

  return server;
}
