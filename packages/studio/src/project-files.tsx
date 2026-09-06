import React, { useEffect, useRef, useState } from "react";
import type { JobRecord, StudioProject } from "@mcp-video-studio/contracts";
export type StudioRequest = <T>(
  route: string,
  init?: RequestInit,
) => Promise<T>;
export async function waitStudioJob(
  request: StudioRequest,
  id: string,
  onUpdate?: (job: JobRecord) => void,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  for (;;) {
    signal?.throwIfAborted();
    const result = await request<{ jobs: JobRecord[] }>("/api/jobs");
    const job = result.jobs.find((j) => j.id === id);
    if (!job)
      throw new Error(
        "The background job is unavailable. Reopen the job history to inspect recovery.",
      );
    onUpdate?.(job);
    if (job.status === "completed") return job.result ?? {};
    if (job.status === "failed" || job.status === "cancelled")
      throw new Error(
        job.error?.message ?? job.message ?? "Job did not complete.",
      );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 200);
      const abort = () => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
export function ProjectFiles({
  project,
  projectPath,
  request,
  onProject,
  onError,
}: {
  project: StudioProject;
  projectPath: string;
  request: StudioRequest;
  onProject(project: StudioProject): void;
  onError(message: string): void;
}) {
  const [output, setOutput] = useState(
      projectPath.replace(/\\/g, "/") + "/exports/project.mcpstudio",
    ),
    [selected, setSelected] = useState(""),
    [replacement, setReplacement] = useState(""),
    [busy, setBusy] = useState(false),
    [job, setJob] = useState<JobRecord>(),
    [message, setMessage] = useState(""),
    [inspection, setInspection] = useState(""),
    [history, setHistory] = useState<
      Array<{
        id: string;
        type: string;
        status: string;
        error?: string;
        input: Record<string, unknown>;
      }>
    >([]);
  const owned = useRef(new AbortController());
  useEffect(() => () => owned.current.abort(), []);
  const post = <T,>(route: string, fields: Record<string, unknown>) =>
    request<T>(route, {
      method: "POST",
      body: JSON.stringify({
        projectPath,
        expectedRevision: project.revision,
        ...fields,
      }),
    });
  const refresh = () =>
    request<{ operations: typeof history }>("/api/archive/operations").then(
      (result) =>
        setHistory(
          result.operations.filter(
            (op) =>
              op.input.projectPath === projectPath ||
              op.input.destinationPath === projectPath,
          ),
        ),
    );
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [projectPath]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch (error) {
      if (!owned.current.signal.aborted)
        onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!owned.current.signal.aborted) {
        setBusy(false);
        void refresh().catch((error) => onError(String(error)));
      }
    }
  };
  return (
    <fieldset aria-label="Project files and archives">
      <legend>Project files and archives</legend>
      <label>
        Archive output path
        <input
          value={output}
          onChange={(e) => setOutput(e.currentTarget.value)}
        />
      </label>
      <button
        disabled={busy || !output}
        onClick={() =>
          void run(async () => {
            const queued = await post<{ job: JobRecord }>(
              "/api/archive/export",
              { outputPath: output },
            );
            setJob(queued.job);
            const result = await waitStudioJob(
              request,
              queued.job.id,
              setJob,
              owned.current.signal,
            );
            setMessage("Archive saved: " + String(result.outputPath));
          })
        }
      >
        Export project archive
      </button>
      {job && (
        <p role="status">
          {job.status} · {Math.round(job.progress * 100)}% · {job.message}
        </p>
      )}
      {job && !["completed", "failed", "cancelled"].includes(job.status) && (
        <button
          onClick={() =>
            void request("/api/jobs/cancel", {
              method: "POST",
              body: JSON.stringify({ jobId: job.id }),
            })
          }
        >
          Cancel file operation
        </button>
      )}
      <p role="status">{message}</p>
      <label>
        Media to inspect or relink
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.currentTarget.value);
            setInspection("");
          }}
        >
          <option value="">Choose media</option>
          {project.media.map((media) => (
            <option key={media.id} value={media.id}>
              {media.name} · {media.storage.mode}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={busy || !selected}
        onClick={() =>
          void run(async () => {
            const result = await post<{
              media: Array<{
                available: boolean;
                changedOnDisk: boolean;
                actualBytes: number | null;
              }>;
            }>("/api/media/inspect", { mediaIds: [selected] });
            const media = result.media[0];
            setInspection(
              media
                ? (media.available ? "Available" : "Offline") +
                    (media.changedOnDisk ? " · changed on disk" : "") +
                    " · " +
                    String(media.actualBytes ?? 0) +
                    " bytes"
                : "Media not found",
            );
          })
        }
      >
        Inspect selected media
      </button>
      <p role="status">{inspection}</p>
      <label>
        Replacement media file path
        <input
          value={replacement}
          onChange={(e) => setReplacement(e.currentTarget.value)}
        />
      </label>
      <button
        disabled={busy || !selected || !replacement}
        onClick={() =>
          void run(async () => {
            const result = await post<{ project: StudioProject }>(
              "/api/media/relink",
              { mediaId: selected, filePath: replacement },
            );
            onProject(result.project);
            setMessage("Media relinked; clip IDs and edits were preserved.");
          })
        }
      >
        Relink selected media
      </button>
      <button
        disabled={
          busy || !project.media.some((m) => m.storage.mode === "linked")
        }
        onClick={() =>
          void run(async () => {
            const queued = await post<{ job: JobRecord }>(
              "/api/media/consolidate",
              {},
            );
            setJob(queued.job);
            const result = await waitStudioJob(
              request,
              queued.job.id,
              setJob,
              owned.current.signal,
            );
            onProject(result.project as StudioProject);
            setMessage("Linked media copied into the project and verified.");
          })
        }
      >
        Consolidate linked media
      </button>
      <p>
        Archives include managed copies of linked sources and start a fresh undo
        history when imported. Cancellation waits for temporary-file cleanup.
        Once atomic publication begins, cancellation waits for the completed
        result.
      </p>
      <button
        onClick={() => void refresh().catch((error) => onError(String(error)))}
      >
        Refresh archive history
      </button>
      <ul>
        {history.slice(0, 20).map((op) => (
          <li key={op.id}>
            {op.type} · {op.status}
            {op.error && <span> · {op.error}</span>}
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
