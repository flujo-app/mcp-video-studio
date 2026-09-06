import {
  saveRetimeOperation,
  type RetimeOperation,
} from "./retiming-recovery.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  secondsToTicks,
  type Clip,
  type MediaAsset,
} from "@mcp-video-studio/contracts";
import {
  confinedPath,
  copyFileAtomic,
  prepareTransitionTimeline,
  sha256File,
  StudioException,
  validateProject,
} from "@mcp-video-studio/core";
import { mediaPath, probeMedia } from "@mcp-video-studio/media";
import { retimePlan, type RetimeOptions } from "../../media/src/retime-plan.js";
import { renderRetimedInput } from "../../media/src/retime-render.js";
import type { StudioRuntime } from "./runtime.js";
export const retimeClipSchema = z.object({
  projectPath: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  sequenceId: z.string().min(1),
  clipId: z.string().min(1),
  mode: z.enum(["freeze", "reverse", "linear-ramp"]),
  freezeAtTick: z.number().int().nonnegative().optional(),
  startRate: z.number().finite().min(0.25).max(4).optional(),
  endRate: z.number().finite().min(0.25).max(4).optional(),
  includeLinked: z.boolean().default(true),
});
export async function queueRetimeClip(
  runtime: StudioRuntime,
  value: unknown,
): Promise<Record<string, unknown>> {
  const input = retimeClipSchema.parse(value),
    store = runtime.store(input.projectPath),
    project = await store.read();
  if (project.revision !== input.expectedRevision)
    throw new StudioException(
      "REVISION_CONFLICT",
      "Project changed before retiming.",
      "conflict",
    );
  const sequence = project.sequences.find(
      (item) => item.id === input.sequenceId,
    ),
    selected = sequence?.clips.find((item) => item.id === input.clipId);
  if (!sequence || !selected)
    throw new StudioException(
      "CLIP_NOT_FOUND",
      "Choose a clip to retime.",
      "input",
    );
  const targets = sequence.clips.filter(
    (clip) =>
      clip.id === selected.id ||
      (input.includeLinked &&
        selected.linkedGroupId &&
        clip.linkedGroupId === selected.linkedGroupId),
  );
  if (targets.length > 8)
    throw new StudioException(
      "RETIMING_LINK_LIMIT",
      "Retime at most eight linked clips together.",
      "policy",
    );
  const prepared = prepareTransitionTimeline(project, sequence),
    settings: RetimeOptions = {
      mode: input.mode,
      ...(input.freezeAtTick !== undefined
        ? { freezeAtTick: input.freezeAtTick }
        : {}),
      ...(input.startRate !== undefined ? { startRate: input.startRate } : {}),
      ...(input.endRate !== undefined ? { endRate: input.endRate } : {}),
    };
  const plans = targets.map((clip) => {
    const track = sequence.tracks.find((track) => track.id === clip.trackId),
      media =
        clip.source.type === "media"
          ? project.media.find(
              (media) =>
                clip.source.type === "media" &&
                media.id === clip.source.mediaId,
            )
          : undefined;
    if (
      !track ||
      track.locked ||
      !clip.enabled ||
      !media ||
      !["video", "audio"].includes(media.kind)
    )
      throw new StudioException(
        "RETIMING_SOURCE",
        "Retiming requires enabled media clips on unlocked tracks. Render animation/nested sequences to managed media first.",
        "input",
      );
    const expanded = prepared.clips.find((item) => item.id === clip.id)!,
      leftTick = clip.startTick - expanded.startTick,
      rightTick =
        expanded.startTick +
        expanded.durationTick -
        clip.startTick -
        clip.durationTick;
    return {
      clip,
      media,
      leftTick,
      plan: retimePlan(project, clip, media, settings, { leftTick, rightTick }),
    };
  });
  const operation: RetimeOperation = {
    id: randomUUID(),
    ownerPid: process.pid,
    projectPath: store.root,
    sourceRevision: project.revision,
    projectId: project.projectId,
    mode: input.mode,
    status: "queued",
    mediaIds: [],
    clipIds: plans.map((item) => item.clip.id),
    sequenceId: sequence.id,
  };
  await saveRetimeOperation(runtime.config, operation);
  let registrationError: unknown;
  let release!: () => void;
  const registered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = await runtime.jobs.enqueue(
    "media",
    "Retiming selected media",
    async (context) => {
      await registered;
      if (registrationError) throw registrationError;
      const bounded = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(60 * 60_000),
      ]);
      await mkdir(runtime.config.scratchDir, { recursive: true });
      const scratch = path.join(
        runtime.config.scratchDir,
        "retiming-" + operation.id,
      );
      operation.scratch = scratch;
      operation.status = "running";
      await saveRetimeOperation(runtime.config, operation);
      await mkdir(scratch);
      let published = false;
      try {
        const assets: MediaAsset[] = [],
          updates: Array<{
            clipId: string;
            source: Clip["source"];
            sourceInTick: number;
          }> = [];
        for (const [index, item] of plans.entries()) {
          bounded.throwIfAborted();
          const directory = path.join(scratch, String(index));
          await mkdir(directory);
          const original = mediaPath(store, item.media),
            pinned = path.join(
              directory,
              "source" + (path.extname(original) || ".bin"),
            );
          await copyFileAtomic(original, pinned, {
            signal: bounded,
            expected: {
              sha256: item.media.storage.sha256,
              bytes: item.media.storage.bytes,
            },
          });
          const extension = item.media.probe.hasVideo ? ".mkv" : ".wav";
          const output = path.join(directory, "retimed" + extension);
          await renderRetimedInput(
            pinned,
            item.media,
            project,
            item.plan,
            runtime.config,
            directory,
            output,
            bounded,
            (value, message) =>
              context.progress((index + value) / plans.length, message),
          );
          const [hash, probe] = await Promise.all([
              sha256File(output, bounded),
              probeMedia(output, runtime.config, bounded),
            ]),
            id = randomUUID(),
            relativePath = path.posix.join(
              "assets",
              hash.sha256.slice(0, 2),
              hash.sha256.slice(2, 4),
              hash.sha256 + extension,
            ),
            target = confinedPath(
              store.root,
              path.join(store.root, relativePath),
            );
          await mkdir(path.dirname(target), { recursive: true });
          await copyFileAtomic(output, target, {
            signal: bounded,
            expected: hash,
          });
          const media: MediaAsset = {
            id,
            name: item.clip.name + " (" + input.mode + ")",
            kind: item.media.kind,
            probe: { ...probe, durationTick: item.plan.durationTick },
            storage: { mode: "managed", relativePath, ...hash },
            createdAt: new Date().toISOString(),
            retiming: {
              version: 1,
              operationId: operation.id,
              mode: input.mode,
              sourceMediaId: item.media.id,
              sourceSha256: item.media.storage.sha256,
              sourceStartTick: secondsToTicks(item.plan.sourceStart),
              sourceEndTick: secondsToTicks(item.plan.sourceEnd),
              durationTick: item.plan.durationTick,
              clipSourceInTick: item.leftTick,
              startRate: item.plan.startRate,
              endRate: item.plan.endRate,
              ...(input.freezeAtTick !== undefined
                ? { freezeAtTick: input.freezeAtTick }
                : {}),
            },
          };
          assets.push(media);
          updates.push({
            clipId: item.clip.id,
            source: { type: "media", mediaId: id },
            sourceInTick: item.leftTick,
          });
        }
        for (const item of plans) {
          const actual = await sha256File(
            mediaPath(store, item.media),
            bounded,
          );
          if (
            actual.sha256 !== item.media.storage.sha256 ||
            actual.bytes !== item.media.storage.bytes
          )
            throw new StudioException(
              "SOURCE_CHANGED",
              "A source changed while retiming; reload and review it before retrying.",
              "conflict",
            );
        }
        const apply = (draft: typeof project) => {
          draft.media.push(...assets);
          const owner = draft.sequences.find(
            (item) => item.id === sequence.id,
          )!;
          for (const update of updates) {
            const clip = owner.clips.find((item) => item.id === update.clipId)!;
            clip.source = update.source;
            clip.sourceInTick = update.sourceInTick;
            clip.playbackRate = { numerator: 1, denominator: 1 };
          }
        };
        const proposed = structuredClone(project);
        apply(proposed);
        validateProject(proposed);
        bounded.throwIfAborted();
        operation.status = "ready";
        operation.mediaIds = assets.map((item) => item.id);
        await saveRetimeOperation(runtime.config, operation);
        const mutation = await store.replace(
          input.expectedRevision,
          (draft) => {
            bounded.throwIfAborted();
            context.commit();
            apply(draft);
          },
          {
            sequences: [sequence.id],
            tracks: [],
            clips: updates.map((item) => item.clipId),
            media: assets.map((item) => item.id),
            animations: [],
            generatedArtifacts: [],
          },
        );
        published = true;
        const result: Record<string, unknown> = {
          ...mutation,
          mediaIds: assets.map((item) => item.id),
          clipIds: updates.map((item) => item.clipId),
          mode: input.mode,
          projectPath: store.root,
          operationId: operation.id,
        };
        operation.status = "completed";
        operation.result = result;
        await saveRetimeOperation(runtime.config, operation).catch(
          () => undefined,
        );
        try {
          const artifacts = await runtime.createMediaArtifacts(
            store.root,
            assets.map((item) => item.id),
          );
          result.artifactJobs = (artifacts.jobs as Array<{ id: string }>).map(
            (job) => job.id,
          );
        } catch {
          result.artifactWarning =
            "The edit committed, but some preview artifacts could not be queued. Use create_proxies to retry.";
        }
        operation.result = result;
        await saveRetimeOperation(runtime.config, operation).catch(
          () => undefined,
        );
        return result;
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch((error) => {
          if (!published) throw error;
        });
      }
    },
  );
  operation.jobId = job.id;
  try {
    await saveRetimeOperation(runtime.config, operation);
  } catch (error) {
    registrationError = error;
    release();
    await runtime.jobs.cancel(job.id);
    throw error;
  } finally {
    release();
  }
  return {
    success: true,
    job,
    operationId: operation.id,
    projectId: project.projectId,
    sourceRevision: project.revision,
  };
}
