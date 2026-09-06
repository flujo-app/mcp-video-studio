import React, { useEffect, useRef, useState } from "react";
import type { JobRecord } from "@mcp-video-studio/contracts";
import { waitStudioJob, type StudioRequest } from "./project-files.js";
type ExportItem = {
  id: string;
  status: string;
  createdAt: string;
  revision: number;
  presetId: string;
  outputPath: string;
  error?: string;
  result?: { sha256?: string; bytes?: number };
  engine?: { node: string; platform: string; ffmpeg: string };
  sourceHashes?: Record<string, string>;
};
export function ExportHistory({
  projectPath,
  request,
  onError,
}: {
  projectPath: string;
  request: StudioRequest;
  onError(message: string): void;
}) {
  const [history, setHistory] = useState<ExportItem[]>([]),
    [selected, setSelected] = useState(""),
    [output, setOutput] = useState(""),
    [job, setJob] = useState<JobRecord>(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const observer = useRef(new AbortController());
  useEffect(() => () => observer.current.abort(), []);
  const post = <T,>(route: string, input: Record<string, unknown>) =>
    request<T>(route, {
      method: "POST",
      body: JSON.stringify({ projectPath, ...input }),
    });
  const refresh = async () => {
    const result = await post<{ exports: ExportItem[] }>(
      "/api/exports/history",
      {},
    );
    setHistory(result.exports);
  };
  useEffect(() => {
    void refresh().catch((error) => onError(String(error)));
  }, [projectPath]);
  const chosen = history.find((item) => item.id === selected);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      if (!observer.current.signal.aborted)
        onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!observer.current.signal.aborted) {
        setBusy(false);
        void refresh().catch((error) => onError(String(error)));
      }
    }
  };
  return (
    <fieldset aria-label="Export history">
      <legend>Export history</legend>
      <button disabled={busy} onClick={() => void run(refresh)}>
        Refresh export history
      </button>
      <label>
        Saved export
        <select
          aria-label="Saved export"
          value={selected}
          onChange={(event) => {
            const id = event.currentTarget.value;
            setSelected(id);
            const item = history.find((item) => item.id === id);
            if (item)
              setOutput(
                item.outputPath.replace(/(\.[^./\\]+)$/, "-reproduced$1"),
              );
          }}
        >
          <option value="">Choose an export</option>
          {history.map((item) => (
            <option value={item.id} key={item.id}>
              {item.createdAt} · revision {item.revision} · {item.status}
            </option>
          ))}
        </select>
      </label>
      {chosen && (
        <>
          <p role="status">
            {chosen.status} · revision {chosen.revision}
          </p>
          <p className="hint">{chosen.outputPath}</p>
          {chosen.error && <p role="alert">{chosen.error}</p>}
          <details>
            <summary>Output and source checksums</summary>
            <p>SHA-256: {chosen.result?.sha256 ?? "No verified output"}</p>
            <ul>
              {Object.entries(chosen.sourceHashes ?? {}).map(([id, hash]) => (
                <li key={id}>
                  {id}: {hash}
                </li>
              ))}
            </ul>
          </details>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const detail = await post("/api/exports/detail", {
                    exportId: chosen.id,
                  }),
                  url = URL.createObjectURL(
                    new Blob([JSON.stringify(detail, null, 2)], {
                      type: "application/json",
                    }),
                  );
                const link = document.createElement("a");
                link.href = url;
                link.download = "export-" + chosen.id + ".json";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setMessage("Saved snapshot and provenance downloaded.");
              })
            }
          >
            Download saved export snapshot
          </button>
        </>
      )}
      <label>
        Reproduced output path
        <input
          value={output}
          onChange={(event) => setOutput(event.currentTarget.value)}
        />
      </label>
      <button
        disabled={busy || chosen?.status !== "completed" || !output}
        onClick={() =>
          void run(async () => {
            const queued = await post<{ job: JobRecord }>(
              "/api/exports/reproduce",
              { exportId: selected, outputPath: output },
            );
            setJob(queued.job);
            const result = await waitStudioJob(
              request,
              queued.job.id,
              setJob,
              observer.current.signal,
            );
            setMessage(
              "Saved revision reproduced: " + String(result.outputPath),
            );
          })
        }
      >
        Reproduce saved export
      </button>
      {job && (
        <p role="status">
          {job.status} · {Math.round(job.progress * 100)}% · {job.message}
        </p>
      )}
      {job && !["completed", "cancelled", "failed"].includes(job.status) && (
        <button
          onClick={() =>
            void run(async () => {
              await post("/api/jobs/cancel", { jobId: job.id });
            })
          }
        >
          Cancel reproduced export
        </button>
      )}
      <p role="status">{message}</p>
      <p className="hint">
        Reproduction uses the saved project revision and verifies source files
        and the recorded application/FFmpeg environment. The current project
        stays open. History shows the latest100exports and is stored with this
        Studio installation.
      </p>
    </fieldset>
  );
}
