import React, { useEffect, useRef, useState } from "react";
import {
  secondsToTicks,
  ticksToSeconds,
  type Clip,
  type JobRecord,
  type Sequence,
  type StudioProject,
} from "@mcp-video-studio/contracts";
import { waitStudioJob, type StudioRequest } from "./project-files.js";
export function RetimeTools({
  project,
  sequence,
  clip,
  projectPath,
  request,
  onError,
  onChanged,
}: {
  project: StudioProject;
  sequence: Sequence;
  clip: Clip;
  projectPath: string;
  request: StudioRequest;
  onError(message: string): void;
  onChanged(project: StudioProject): void;
}) {
  const [mode, setMode] = useState<"reverse" | "freeze" | "linear-ramp">(
      "reverse",
    ),
    [freeze, setFreeze] = useState(0),
    [start, setStart] = useState(0.5),
    [end, setEnd] = useState(1.5),
    [linked, setLinked] = useState(true),
    [busy, setBusy] = useState(false),
    [job, setJob] = useState<JobRecord>(),
    [message, setMessage] = useState("");
  const alive = useRef(new AbortController());
  useEffect(() => () => alive.current.abort(), []);
  const apply = async () => {
    setBusy(true);
    setMessage("");
    try {
      const queued = await request<{ job: JobRecord }>(
        "/api/features/retime_clip",
        {
          method: "POST",
          body: JSON.stringify({
            projectPath,
            expectedRevision: project.revision,
            sequenceId: sequence.id,
            clipId: clip.id,
            mode,
            includeLinked: linked,
            ...(mode === "freeze"
              ? { freezeAtTick: secondsToTicks(freeze) }
              : {}),
            ...(mode === "linear-ramp"
              ? { startRate: start, endRate: end }
              : {}),
          }),
        },
      );
      setJob(queued.job);
      const result = await waitStudioJob(
        request,
        queued.job.id,
        setJob,
        alive.current.signal,
      );
      if (!alive.current.signal.aborted) {
        try {
          const loaded = await request<{ project: StudioProject }>(
            "/api/project?projectPath=" + encodeURIComponent(projectPath),
          );
          if (!alive.current.signal.aborted) {
            onChanged(loaded.project);
            setMessage(
              "Retimed at revision " +
                result.revision +
                ". Undo restores the original clips.",
            );
          }
        } catch (error) {
          setMessage(
            "Retiming committed at revision " +
              result.revision +
              ". Reload the project to see it.",
          );
          onError(error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      if (!alive.current.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        setMessage(message);
        onError(message);
      }
    } finally {
      if (!alive.current.signal.aborted) setBusy(false);
    }
  };
  return (
    <fieldset>
      <legend>Retime media</legend>
      <p>
        Create managed media while preserving clip placement, effects and source
        files. Changes commit together and support Undo.
      </p>
      <label>
        Retiming mode
        <select
          aria-label="Retiming mode"
          value={mode}
          disabled={busy}
          onChange={(event) =>
            setMode(event.currentTarget.value as typeof mode)
          }
        >
          <option value="reverse">Reverse</option>
          <option value="freeze">Freeze frame</option>
          <option value="linear-ramp">Linear speed ramp</option>
        </select>
      </label>
      {mode === "freeze" && (
        <>
          <label>
            Freeze position in clip (seconds)
            <input
              type="number"
              min="0"
              max={Math.max(0, ticksToSeconds(clip.durationTick) - 0.001)}
              step=".01"
              value={freeze}
              onChange={(event) => setFreeze(event.currentTarget.valueAsNumber)}
            />
          </label>
          <p>The selected frame is held; its audio becomes silence.</p>
        </>
      )}
      {mode === "linear-ramp" && (
        <>
          <label>
            Ramp start speed
            <input
              type="number"
              min=".25"
              max="4"
              step=".05"
              value={start}
              onChange={(event) => setStart(event.currentTarget.valueAsNumber)}
            />
          </label>
          <label>
            Ramp end speed
            <input
              type="number"
              min=".25"
              max="4"
              step=".05"
              value={end}
              onChange={(event) => setEnd(event.currentTarget.valueAsNumber)}
            />
          </label>
          <p>
            Speed changes linearly over the clip. Audio pitch follows speed;
            source frames and samples follow the same time curve.
          </p>
        </>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={linked}
          disabled={busy}
          onChange={(event) => setLinked(event.currentTarget.checked)}
        />
        Include linked clips
      </label>
      <button
        disabled={
          busy ||
          clip.source.type !== "media" ||
          (mode === "freeze" &&
            (!Number.isFinite(freeze) ||
              freeze < 0 ||
              freeze >= ticksToSeconds(clip.durationTick))) ||
          (mode === "linear-ramp" &&
            ![start, end].every(
              (value) => Number.isFinite(value) && value >= 0.25 && value <= 4,
            ))
        }
        onClick={() => void apply()}
      >
        Apply retiming
      </button>
      {busy && job && (
        <button
          onClick={() =>
            void request("/api/jobs/cancel", {
              method: "POST",
              body: JSON.stringify({ jobId: job.id }),
            }).catch((error) =>
              onError(error instanceof Error ? error.message : String(error)),
            )
          }
        >
          Cancel retiming
        </button>
      )}
      {job && busy && (
        <p role="status">
          {job.message} · {Math.round(job.progress * 100)}%
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </fieldset>
  );
}
