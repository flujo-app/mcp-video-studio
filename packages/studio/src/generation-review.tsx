import React, { useEffect, useRef, useState } from "react";
import "./generation-review.css";
import {
  generatedSegments,
  secondsToTicks,
  ticksToSeconds,
  framesToTicks,
  type GeneratedArtifact,
  type GeneratedArtifactVersion,
  type GenerationRequest,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { evaluateAnimation } from "../../animation/src/evaluate.js";
import { createAnimationPainter } from "../../animation/src/painter.js";
type Request = <T>(route: string, init?: RequestInit) => Promise<T>;
type Props = {
  artifact: GeneratedArtifact;
  project: StudioProject;
  projectPath: string;
  request: Request;
  mediaUrl(id: string): string;
  onProject(project: StudioProject): void;
  onError(message: string): void;
};
function VersionView({
  version,
  artifact,
  project,
  tick,
}: {
  version: GeneratedArtifactVersion;
  artifact: GeneratedArtifact;
  project: StudioProject;
  tick: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    painter = useRef<ReturnType<typeof createAnimationPainter> | null>(null),
    pending = useRef(Promise.resolve()),
    serial = useRef(0);
  const [error, setError] = useState("");
  useEffect(
    () => () => {
      serial.current++;
    },
    [],
  );
  const segment = version.output
    ? generatedSegments(version.output, artifact.scope.durationTick).find(
        (s) => s.offsetTick <= tick && s.offsetTick + s.durationTick > tick,
      )
    : undefined;
  const animation =
    segment?.source.type === "animation"
      ? project.animations.find(
          (a) =>
            segment.source.type === "animation" &&
            a.id === segment.source.animationId,
        )
      : undefined;
  useEffect(() => {
    const id = ++serial.current;
    pending.current = pending.current
      .catch(() => undefined)
      .then(async () => {
        if (id !== serial.current || !canvas.current || !animation || !segment)
          return;
        painter.current ??= createAnimationPainter(canvas.current);
        try {
          const time = segment.sourceInTick + tick - segment.offsetTick;
          await painter.current(evaluateAnimation(animation, time), {
            ...animation.canvas,
            seed: animation.seed,
            time: ticksToSeconds(time),
          });
          setError("");
        } catch (e) {
          setError(e instanceof Error ? e.message : "Preview failed");
        }
      });
  }, [animation, segment?.sourceInTick, segment?.offsetTick, tick]);
  return (
    <div className="generation-version-view">
      {artifact.kind === "animation" && (
        <canvas
          ref={canvas}
          aria-label={"Animation version " + version.id}
          style={{ width: "100%", background: "#222" }}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {artifact.kind === "captions" && (
        <div aria-label={"Caption version " + version.id}>
          {version.output?.captions
            ?.filter(
              (c) =>
                c.startTick <= artifact.scope.startTick + tick &&
                c.startTick + c.durationTick > artifact.scope.startTick + tick,
            )
            .map((c) => (
              <p key={c.id}>{c.text}</p>
            ))}
        </div>
      )}
      <p>
        {version.request.text ??
          version.request.prompt ??
          "Transcript from source media"}
      </p>
      <small>
        {version.provenance.provider} · {version.provenance.model} ·{" "}
        {version.status}
      </small>
      {version.review && (
        <p>
          Review by {version.review.reviewer}:{" "}
          {version.review.note ?? "(no note)"}
        </p>
      )}
    </div>
  );
}
export function GenerationReview({
  artifact,
  project,
  projectPath,
  request,
  mediaUrl,
  onProject,
  onError,
}: Props) {
  const latest = artifact.versions.at(-1)!,
    initial = artifact.activeVersionId ?? latest.id;
  const [parentId, setParentId] = useState(initial),
    [aId, setA] = useState(artifact.versions[0]!.id),
    [bId, setB] = useState(latest.id),
    [text, setText] = useState(""),
    [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [partial, setPartial] = useState(false),
    [autoActivate, setAutoActivate] = useState(false),
    [start, setStart] = useState(0),
    [duration, setDuration] = useState(
      ticksToSeconds(artifact.scope.durationTick),
    ),
    [tick, setTick] = useState(0),
    [playing, setPlaying] = useState(""),
    [comparison, setComparison] = useState("");
  const audio = useRef<HTMLAudioElement>(null),
    playSerial = useRef(0);
  const parent = artifact.versions.find((v) => v.id === parentId) ?? latest,
    a = artifact.versions.find((v) => v.id === aId) ?? latest,
    b = artifact.versions.find((v) => v.id === bId) ?? latest;
  const total = ticksToSeconds(artifact.scope.durationTick),
    frame = framesToTicks(1, project.settings.fps),
    aligned = (seconds: number) =>
      Math.round(secondsToTicks(seconds) / frame) * frame;
  useEffect(
    () => setText(parent.request.text ?? parent.request.prompt ?? ""),
    [parent.id, parent.request.text, parent.request.prompt],
  );
  const stop = () => {
    playSerial.current++;
    audio.current?.pause();
    setPlaying("");
  };
  useEffect(
    () => () => {
      playSerial.current++;
      audio.current?.pause();
    },
    [],
  );
  const act = async (body: Record<string, unknown>, route: string) => {
    setBusy(true);
    try {
      const result = await request<{ project: StudioProject }>(route, {
        method: "POST",
        body: JSON.stringify({
          projectPath,
          expectedRevision: project.revision,
          artifactId: artifact.id,
          ...body,
        }),
      });
      onProject(result.project);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Generation action failed");
    } finally {
      setBusy(false);
    }
  };
  const range = () => {
    const offsetTick = aligned(start),
      durationTick = aligned(duration);
    if (
      !Number.isSafeInteger(offsetTick) ||
      !Number.isSafeInteger(durationTick) ||
      offsetTick < 0 ||
      durationTick <= 0 ||
      offsetTick + durationTick > artifact.scope.durationTick
    )
      throw new Error("Choose a range inside this artifact slot.");
    return { offsetTick, durationTick };
  };
  const regenerate = () => {
    try {
      const patch: Partial<GenerationRequest> =
        parent.request.text !== undefined
          ? { text }
          : parent.request.prompt !== undefined
            ? { prompt: text }
            : {};
      void act(
        {
          parentVersionId: parent.id,
          requestPatch: patch,
          autoActivate,
          ...(partial ? { region: range() } : {}),
        },
        "/api/generated/regenerate",
      );
    } catch (e) {
      onError(String(e));
    }
  };
  const review = (
    versionId: string,
    action: "activate" | "approve" | "reject",
  ) =>
    void act(
      { versionId, action, reviewer: "Studio user", note },
      "/api/generated/review",
    );
  const audition = async (version: GeneratedArtifactVersion, label: string) => {
    stop();
    const id = playSerial.current,
      player = audio.current;
    if (!player || !version.output) return;
    try {
      const region = range(),
        end = region.offsetTick + region.durationTick;
      setPlaying(label);
      for (const segment of generatedSegments(
        version.output,
        artifact.scope.durationTick,
      )) {
        const begin = Math.max(region.offsetTick, segment.offsetTick),
          finish = Math.min(end, segment.offsetTick + segment.durationTick);
        if (finish <= begin || segment.source.type !== "media") continue;
        if (id !== playSerial.current) return;
        const sourceStart = ticksToSeconds(
            segment.sourceInTick + begin - segment.offsetTick,
          ),
          sourceEnd = sourceStart + ticksToSeconds(finish - begin);
        player.src = mediaUrl(segment.source.mediaId);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(
            () => done(new Error("Audio load timed out")),
            10000,
          );
          const loaded = () => done(),
            failed = () => done(new Error("Audio could not be loaded"));
          function done(error?: Error) {
            clearTimeout(timeout);
            player!.removeEventListener("loadedmetadata", loaded);
            player!.removeEventListener("error", failed);
            error ? reject(error) : resolve();
          }
          player.addEventListener("loadedmetadata", loaded, { once: true });
          player.addEventListener("error", failed, { once: true });
          player.load();
        });
        if (id !== playSerial.current) return;
        player.currentTime = sourceStart;
        await player.play();
        await new Promise<void>((resolve) => {
          const poll = () => {
            if (id !== playSerial.current) {
              resolve();
              return;
            }
            if (player.ended || player.currentTime >= sourceEnd) {
              player.pause();
              resolve();
              return;
            }
            setTick(
              Math.min(
                end,
                begin +
                  secondsToTicks(Math.max(0, player.currentTime - sourceStart)),
              ),
            );
            requestAnimationFrame(poll);
          };
          poll();
        });
      }
      if (id === playSerial.current) setPlaying("");
    } catch (e) {
      if (id === playSerial.current) {
        stop();
        onError(e instanceof Error ? e.message : "Audition failed");
      }
    }
  };
  const compare = async () => {
    try {
      const result = await request<{ versions: GeneratedArtifactVersion[] }>(
        "/api/features/compare_generated_versions",
        {
          method: "POST",
          body: JSON.stringify({
            projectPath,
            artifactId: artifact.id,
            firstVersionId: a.id,
            secondVersionId: b.id,
          }),
        },
      );
      const [first, second] = result.versions;
      setComparison(
        JSON.stringify(first?.request) === JSON.stringify(second?.request)
          ? "Requests match; compare generated media, captions and animation at the selected range."
          : "Requests differ. The two panels show their scripts/prompts, models and saved review notes.",
      );
    } catch (e) {
      onError(String(e));
    }
  };
  return (
    <article className="generated-card" aria-label={"Review " + artifact.name}>
      <header>
        <strong>{artifact.name}</strong>
        <span>
          {artifact.kind} · {artifact.versions.length} versions ·{" "}
          {total.toFixed(2)}s slot
        </span>
      </header>
      <label>
        Regenerate from version
        <select
          value={parent.id}
          onChange={(e) => setParentId(e.currentTarget.value)}
        >
          {artifact.versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.id.slice(0, 8)} · {v.status}
              {artifact.activeVersionId === v.id ? " · active" : ""}
            </option>
          ))}
        </select>
      </label>
      {(parent.request.text !== undefined ||
        parent.request.prompt !== undefined) && (
        <label>
          Revised script or prompt
          <textarea
            value={text}
            rows={3}
            onChange={(e) => setText(e.currentTarget.value)}
          />
        </label>
      )}
      <div className="field-pair">
        <label>
          Range start (seconds)
          <input
            type="number"
            min={0}
            max={total}
            step="any"
            value={Number.isFinite(start) ? start : ""}
            onChange={(e) => setStart(e.currentTarget.valueAsNumber)}
          />
        </label>
        <label>
          Range duration (seconds)
          <input
            type="number"
            min={ticksToSeconds(frame)}
            max={total}
            step="any"
            value={Number.isFinite(duration) ? duration : ""}
            onChange={(e) => setDuration(e.currentTarget.valueAsNumber)}
          />
        </label>
      </div>
      <label>
        <input
          type="checkbox"
          checked={partial}
          onChange={(e) => setPartial(e.currentTarget.checked)}
        />
        Regenerate only this range
      </label>
      <label>
        <input
          type="checkbox"
          checked={autoActivate}
          onChange={(e) => setAutoActivate(e.currentTarget.checked)}
        />
        Automatically activate this generated version when ready
      </label>
      <p>
        {artifact.kind === "narration" ? "This voice is AI-generated. " : ""}
        Drafts wait for review by default. Partial regeneration keeps sources
        and edits outside the range. Generated audio is padded or trimmed to its
        slot.
      </p>
      <button disabled={busy || !parent.output} onClick={regenerate}>
        Generate revised draft
      </button>
      <div className="field-pair">
        {[
          ["A", a.id, setA],
          ["B", b.id, setB],
        ].map(([label, value, set]) => (
          <label key={String(label)}>
            Compare {String(label)}
            <select
              aria-label={"Compare " + String(label)}
              value={String(value)}
              onChange={(e) => (set as typeof setA)(e.currentTarget.value)}
            >
              {artifact.versions
                .filter((v) => v.output)
                .map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id.slice(0, 8)} · {v.status}
                  </option>
                ))}
            </select>
          </label>
        ))}
      </div>
      <button onClick={() => void compare()}>Compare selected versions</button>
      {comparison && <p role="status">{comparison}</p>}
      <label>
        Review position (seconds)
        <input
          type="range"
          min={0}
          max={Math.max(0, total - ticksToSeconds(frame))}
          step={ticksToSeconds(frame)}
          value={ticksToSeconds(tick)}
          onChange={(e) => {
            stop();
            setTick(aligned(e.currentTarget.valueAsNumber));
          }}
        />
        <output>{ticksToSeconds(tick).toFixed(2)}</output>
      </label>
      <div className="field-pair">
        <section aria-label="Version A">
          <h4>Version A</h4>
          <VersionView
            version={a}
            artifact={artifact}
            project={project}
            tick={tick}
          />
        </section>
        <section aria-label="Version B">
          <h4>Version B</h4>
          <VersionView
            version={b}
            artifact={artifact}
            project={project}
            tick={tick}
          />
        </section>
      </div>
      {(artifact.kind === "narration" || artifact.kind === "music") && (
        <>
          <button onClick={() => void audition(a, "A")} disabled={!a.output}>
            Audition A range
          </button>
          <button onClick={() => void audition(b, "B")} disabled={!b.output}>
            Audition B range
          </button>
          <button onClick={stop}>Stop audition</button>
          <span role="status">{playing ? "Playing " + playing : ""}</span>
          <audio ref={audio} preload="none" />
        </>
      )}
      <label>
        Version annotation
        <textarea
          value={note}
          maxLength={10000}
          onChange={(e) => setNote(e.currentTarget.value)}
        />
      </label>
      <button
        disabled={busy}
        onClick={() =>
          void act(
            { versionId: parent.id, reviewer: "Studio user", note },
            "/api/features/annotate_generated_version",
          )
        }
      >
        Save annotation on selected version
      </button>
      <div className="version-list">
        {[...artifact.versions].reverse().map((v) => (
          <div key={v.id} className="version-row">
            <strong>
              {v.id.slice(0, 8)} · {v.status}
              {artifact.activeVersionId === v.id ? " · ACTIVE" : ""}
            </strong>
            {v.error && <p role="alert">{v.error.message}</p>}
            {v.review?.note && <p>{v.review.note}</p>}
            {v.output && (
              <>
                <button
                  disabled={busy}
                  onClick={() => review(v.id, "activate")}
                >
                  {artifact.activeVersionId === v.id
                    ? "Active version"
                    : "Activate / revert to this version"}
                </button>
                <button disabled={busy} onClick={() => review(v.id, "approve")}>
                  Approve this version
                </button>
                <button disabled={busy} onClick={() => review(v.id, "reject")}>
                  Reject this version
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}
