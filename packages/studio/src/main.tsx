import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  TICKS_PER_SECOND,
  framesToTicks,
  formatTimecode,
  secondsToTicks,
  ticksToFrames,
  ticksToSeconds,
  type AnimationDocument,
  type CaptionCue,
  type Clip,
  type EffectInstance,
  type GeneratedArtifact,
  type GenerationRequest,
  type JobRecord,
  type MediaAsset,
  type ProjectCommand,
  type Sequence,
  type StudioProject,
  type Track,
  type Transform
} from "@mcp-video-studio/contracts";
import "./styles.css";
import "./layout-fixes.css";

const token = new URLSearchParams(location.search).get("token") || document.body.dataset.token || "";

function defaultTransform(): Transform {
  return { position: [0.5, 0.5], scale: [1, 1], rotation: 0, anchor: [0.5, 0.5], opacity: 1 };
}

function defaultClip(trackId: string, source: Clip["source"], name: string, durationTick: number): Clip {
  return {
    id: crypto.randomUUID(), trackId, source, name, startTick: 0, durationTick, sourceInTick: 0,
    playbackRate: { numerator: 1, denominator: 1 }, enabled: true, transform: defaultTransform(),
    crop: { left: 0, top: 0, right: 0, bottom: 0 }, blendMode: "normal", effects: [],
    audio: { gainDb: 0, pan: 0, muted: false, fadeInTick: 0, fadeOutTick: 0, effects: [] }
  };
}

async function api<T>(route: string, init?: RequestInit): Promise<T> {
  const url = `${route}${route.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const value = await response.json() as T & { success?: boolean; error?: { message?: string } };
  if (!response.ok || value.success === false) throw new Error(value.error?.message || `Request failed (${response.status})`);
  return value;
}

function secondsLabel(tick: number): string { return `${ticksToSeconds(tick).toFixed(2)}s`; }

function mediaArtifactUrl(projectPath: string, mediaId: string, kind: "thumbnail" | "waveform" | "proxy" | "source", version = 0): string {
  return `/media?token=${encodeURIComponent(token)}&projectPath=${encodeURIComponent(projectPath)}&mediaId=${encodeURIComponent(mediaId)}&kind=${kind}${version ? `&v=${version}` : ""}`;
}

function clipColor(clip: Clip, media?: MediaAsset): string {
  if (clip.source.type === "color") return clip.source.color;
  if (clip.source.type === "animation") return "#7c5cff";
  if (media?.kind === "audio") return "#28b487";
  if (media?.kind === "image") return "#e68a3a";
  return "#2979d8";
}

function App() {
  const [projects, setProjects] = useState<Array<{ path: string; name: string; projectId: string; revision: number }>>([]);
  const [projectPath, setProjectPath] = useState(new URLSearchParams(location.search).get("projectPath") || localStorage.getItem("mcp-video-studio:lastProject") || "");
  const [project, setProject] = useState<StudioProject>();
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [selectedCaptionId, setSelectedCaptionId] = useState<string>();
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(72);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [cachedPreviewRevision, setCachedPreviewRevision] = useState<number>();
  const [notice, setNotice] = useState("Ready");
  const [error, setError] = useState("");
  const [showProjects, setShowProjects] = useState(!projectPath);
  const [showGeneration, setShowGeneration] = useState(false);
  const projectPathRef = useRef(projectPath);
  useEffect(() => { projectPathRef.current = projectPath; }, [projectPath]);

  const sequence = project?.sequences.find((item) => item.id === project.activeSequenceId);
  const selectedClip = sequence?.clips.find((clip) => clip.id === selectedClipId);
  const selectedCaption = sequence?.captions.find((caption) => caption.id === selectedCaptionId);
  const selectedMediaId = selectedClip?.source.type === "media" ? selectedClip.source.mediaId : undefined;
  const selectedMedia = selectedMediaId ? project?.media.find((media) => media.id === selectedMediaId) : undefined;
  const completedPreview = jobs.find((job) => job.type === "preview" && job.status === "completed" && job.result?.projectId === project?.projectId && job.result?.sequenceId === sequence?.id && job.result?.revision === project?.revision);
  const previewReady = Boolean(project && (cachedPreviewRevision === project.revision || completedPreview));
  const previewBusy = jobs.some((job) => job.type === "preview" && (job.status === "queued" || job.status === "running"));
  const artifactVersion = jobs.filter((job) => job.status === "completed" && (job.type === "thumbnail" || job.type === "waveform")).length;

  const refreshProjects = useCallback(async () => {
    const result = await api<{ projects: typeof projects }>("/api/projects");
    setProjects(result.projects);
  }, []);

  const openProject = useCallback(async (nextPath: string) => {
    if (!nextPath) return;
    try {
      setError(""); setNotice("Opening project…");
      const result = await api<{ project: StudioProject }>(`/api/project?projectPath=${encodeURIComponent(nextPath)}`);
      setProject(result.project); setProjectPath(nextPath); setSelectedClipId(undefined); setSelectedCaptionId(undefined); setShowProjects(false); setCachedPreviewRevision(undefined);
      localStorage.setItem("mcp-video-studio:lastProject", nextPath); setNotice("Project loaded");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setShowProjects(true); }
  }, []);

  useEffect(() => { void refreshProjects(); if (projectPath) void openProject(projectPath); }, []);
  useEffect(() => {
    const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    events.addEventListener("job", (event) => {
      const job = JSON.parse((event as MessageEvent).data) as JobRecord;
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].slice(0, 30));
      if (job.type === "generation" && ["completed", "failed", "cancelled"].includes(job.status) && projectPathRef.current) {
        void api<{ project: StudioProject }>(`/api/project?projectPath=${encodeURIComponent(projectPathRef.current)}`).then((result) => setProject(result.project)).catch(() => undefined);
      }
    });
    void api<{ jobs: JobRecord[] }>("/api/jobs").then((result) => setJobs(result.jobs));
    return () => events.close();
  }, []);
  useEffect(() => { if (completedPreview) setNotice("Program preview ready"); }, [completedPreview?.id]);

  const mutate = useCallback(async (commands: ProjectCommand[]) => {
    if (!project) return;
    try {
      setError(""); setNotice("Saving…");
      const result = await api<{ project: StudioProject }>("/api/commands", { method: "POST", body: JSON.stringify({ projectPath, expectedRevision: project.revision, commands }) });
      setProject(result.project); setNotice(`Saved revision ${result.project.revision}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setNotice("Edit rejected"); }
  }, [project, projectPath]);

  const undoRedo = async (kind: "undo" | "redo") => {
    if (!project) return;
    try {
      const result = await api<{ project: StudioProject }>(`/api/${kind}`, { method: "POST", body: JSON.stringify({ projectPath, expectedRevision: project.revision }) });
      setProject(result.project); setNotice(kind === "undo" ? "Undone" : "Redone");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const addMediaClip = async (media: MediaAsset) => {
    if (!project || !sequence) return;
    const track = sequence.tracks.find((item) => media.kind === "audio" ? item.type === "audio" : item.type === "video" || item.type === "overlay");
    if (!track) { setError(`Add a ${media.kind === "audio" ? "audio" : "video"} track first.`); return; }
    const rawDuration = media.kind === "image" ? secondsToTicks(5) : Math.max(media.probe.durationTick, secondsToTicks(1));
    const duration = track.type === "audio" ? rawDuration : framesToTicks(ticksToFrames(rawDuration, project.settings.fps, "ceil"), project.settings.fps);
    const clip = defaultClip(track.id, { type: "media", mediaId: media.id }, media.name, duration);
    clip.startTick = framesToTicks(ticksToFrames(playhead, project.settings.fps, "round"), project.settings.fps);
    setSelectedClipId(clip.id);
    await mutate([{ type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" }]);
  };

  const addColor = async () => {
    if (!project || !sequence) return;
    const track = sequence.tracks.find((item) => item.type === "video" || item.type === "overlay");
    if (!track) return;
    const clip = defaultClip(track.id, { type: "color", color: "#243b69" }, "Color card", secondsToTicks(5));
    clip.startTick = framesToTicks(ticksToFrames(playhead, project.settings.fps, "round"), project.settings.fps);
    setSelectedClipId(clip.id);
    await mutate([{ type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" }]);
  };

  const addTitleAnimation = async () => {
    if (!project || !sequence) return;
    const track = sequence.tracks.find((item) => item.type === "overlay") ?? sequence.tracks.find((item) => item.type === "video");
    if (!track) return;
    const durationTick = secondsToTicks(4);
    const animation: AnimationDocument = {
      id: crypto.randomUUID(), name: "Animated title", durationTick,
      canvas: { ...project.settings.raster, background: "transparent" }, seed: 1, mode: "declarative",
      nodes: [{ id: crypto.randomUUID(), type: "text", name: "Your title", properties: { text: "Your title", fontSize: 112, fontWeight: 700, fill: "#ffffff" }, transform: { ...defaultTransform(), position: [project.settings.raster.width / 2, project.settings.raster.height / 2] } }],
      operations: []
    };
    const node = animation.nodes[0]!;
    animation.operations.push(
      { id: crypto.randomUUID(), type: "write", targetId: node.id, startTick: 0, durationTick: secondsToTicks(1.1), easing: "easeOut", parameters: {} },
      { id: crypto.randomUUID(), type: "fade", targetId: node.id, startTick: secondsToTicks(3.2), durationTick: secondsToTicks(0.8), easing: "easeIn", parameters: { from: 1, to: 0 } }
    );
    const clip = defaultClip(track.id, { type: "animation", animationId: animation.id }, animation.name, durationTick);
    clip.startTick = framesToTicks(ticksToFrames(playhead, project.settings.fps, "round"), project.settings.fps);
    setSelectedClipId(clip.id);
    await mutate([{ type: "animation.set", animation }, { type: "clip.add", sequenceId: sequence.id, clip, mode: "overwrite" }]);
  };

  const addCaption = async () => {
    if (!project || !sequence) return;
    const track = sequence.tracks.find((item) => item.type === "caption");
    if (!track) { setError("Add a caption track first."); return; }
    const caption: CaptionCue = {
      id: crypto.randomUUID(), trackId: track.id,
      startTick: framesToTicks(ticksToFrames(playhead, project.settings.fps, "round"), project.settings.fps),
      durationTick: framesToTicks(Math.max(1, ticksToFrames(secondsToTicks(3), project.settings.fps, "round")), project.settings.fps),
      text: "New caption",
      style: { fontFamily: "Arial", fontSize: Math.round(54 * project.settings.raster.height / 1080), color: "#ffffff", background: "#000000aa", position: "bottom", align: "center" }
    };
    setSelectedClipId(undefined); setSelectedCaptionId(caption.id);
    await mutate([{ type: "caption.add", sequenceId: sequence.id, caption }]);
  };

  const splitSelected = async () => {
    if (!sequence || !selectedClip || playhead <= selectedClip.startTick || playhead >= selectedClip.startTick + selectedClip.durationTick) return;
    await mutate([{ type: "clip.split", sequenceId: sequence.id, clipId: selectedClip.id, atTick: framesToTicks(ticksToFrames(playhead, project!.settings.fps, "round"), project!.settings.fps), rightClipId: crypto.randomUUID() }]);
  };

  const removeSelected = async () => {
    if (!sequence) return;
    if (selectedClip) {
      setSelectedClipId(undefined);
      await mutate([{ type: "clip.remove", sequenceId: sequence.id, clipIds: [selectedClip.id], ripple: false }]);
    } else if (selectedCaption) {
      setSelectedCaptionId(undefined);
      await mutate([{ type: "caption.remove", sequenceId: sequence.id, captionIds: [selectedCaption.id] }]);
    }
  };

  const updateSelected = (patch: ProjectCommand & { type: "clip.update" }) => mutate([patch]);

  const moveClip = async (clipId: string, track: Track, tick: number) => {
    if (!sequence || !project) return;
    const aligned = track.type === "audio" ? Math.max(0, tick) : framesToTicks(ticksToFrames(Math.max(0, tick), project.settings.fps, "round"), project.settings.fps);
    await mutate([{ type: "clip.move", sequenceId: sequence.id, clipIds: [clipId], targetTrackId: track.id, startTick: aligned, ripple: false }]);
  };

  const buildPreview = async () => {
    if (!project || !sequence) return;
    try {
      setError(""); setNotice("Building program preview…");
      const result = await api<{ cached: boolean; revision: number; job?: JobRecord }>("/api/preview", { method: "POST", body: JSON.stringify({ projectPath, sequenceId: sequence.id }) });
      if (result.cached) setCachedPreviewRevision(result.revision);
      if (result.job) setJobs((current) => [result.job!, ...current.filter((item) => item.id !== result.job!.id)].slice(0, 30));
      setNotice(result.cached ? "Program preview ready" : "Program preview queued");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setNotice("Preview failed"); }
  };

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={() => setShowProjects(true)}><span className="brand-mark">▶</span><span>MCP Video Studio</span></button>
      <div className="project-title"><span>{project?.name ?? "No project"}</span>{project && <small>rev {project.revision}</small>}</div>
      <div className="toolbar">
        <button onClick={() => void undoRedo("undo")} disabled={!project} title="Undo">↶</button>
        <button onClick={() => void undoRedo("redo")} disabled={!project} title="Redo">↷</button>
        <span className="separator" />
        <button onClick={() => void addColor()} disabled={!project}>Color</button>
        <button onClick={() => void addTitleAnimation()} disabled={!project}>Animated title</button>
        <button onClick={() => void addCaption()} disabled={!project}>Caption</button>
        <button onClick={() => setShowGeneration(true)} disabled={!project}>Generate{project?.generatedArtifacts.length ? ` ${project.generatedArtifacts.length}` : ""}</button>
        <button onClick={() => void splitSelected()} disabled={!selectedClip}>Split</button>
        <button className="danger" onClick={() => void removeSelected()} disabled={!selectedClip && !selectedCaption}>Delete</button>
      </div>
      <div className="status"><span className="status-dot" />{notice}</div>
    </header>

    {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>×</button></div>}

    <main className="workspace">
      <MediaBin project={project} projectPath={projectPath} artifactVersion={artifactVersion} onProject={setProject} onImportError={setError} onAdd={addMediaClip} />
      <section className="center-stage">
        <Preview project={project} projectPath={projectPath} sequence={sequence} selectedClip={selectedClip} selectedMedia={selectedMedia} playhead={playhead} ready={previewReady} busy={previewBusy} onBuild={buildPreview} onPlayhead={setPlayhead} />
        <Timeline project={project} projectPath={projectPath} artifactVersion={artifactVersion} sequence={sequence} selectedClipId={selectedClipId} selectedCaptionId={selectedCaptionId} playhead={playhead} zoom={zoom} onZoom={setZoom} onPlayhead={setPlayhead} onSelect={(id) => { setSelectedClipId(id); setSelectedCaptionId(undefined); }} onSelectCaption={(id) => { setSelectedCaptionId(id); setSelectedClipId(undefined); }} onMove={moveClip} onMutate={mutate} />
      </section>
      {selectedCaption && project && sequence ? <CaptionInspector project={project} sequence={sequence} caption={selectedCaption} onMutate={mutate} /> : <Inspector project={project} sequence={sequence} clip={selectedClip} jobs={jobs} projectPath={projectPath} onUpdate={updateSelected} onMutate={mutate} onError={setError} />}
    </main>

    {showProjects && <ProjectChooser projects={projects} initialPath={projectPath} onRefresh={refreshProjects} onOpen={openProject} onClose={() => project && setShowProjects(false)} />}
    {showGeneration && project && sequence && <GenerationCenter project={project} projectPath={projectPath} sequence={sequence} playhead={playhead} onProject={setProject} onClose={() => setShowGeneration(false)} onError={setError} />}
  </div>;
}

function ProjectChooser({ projects, initialPath, onRefresh, onOpen, onClose }: { projects: Array<{ path: string; name: string; revision: number }>; initialPath: string; onRefresh(): Promise<void>; onOpen(path: string): Promise<void>; onClose(): void }) {
  const [name, setName] = useState("Untitled video");
  const [customPath, setCustomPath] = useState(initialPath);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const result = await api<{ projectPath: string }>("/api/project/create", { method: "POST", body: JSON.stringify({ name, ...(customPath ? { projectPath: customPath } : {}) }) });
      await onRefresh(); await onOpen(result.projectPath);
    } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><div className="project-modal">
    <div className="modal-head"><div><p className="eyebrow">STANDALONE WORKSPACE</p><h1>Choose a project</h1></div><button className="close" onClick={onClose}>×</button></div>
    <div className="project-grid">
      <section><h3>Recent projects</h3><div className="recent-list">{projects.length ? projects.map((item) => <button key={item.path} className="recent-card" onClick={() => void onOpen(item.path)}><span className="recent-icon">▶</span><span><strong>{item.name}</strong><small>{item.path}</small></span><em>rev {item.revision}</em></button>) : <p className="empty">No projects yet.</p>}</div></section>
      <section className="new-project"><h3>New project</h3><label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Location <small>(optional)</small><input value={customPath} onChange={(event) => setCustomPath(event.target.value)} placeholder="Uses configured projects folder" /></label><button className="primary large" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? "Creating…" : "Create project"}</button></section>
    </div>
  </div></div>;
}

function MediaBin({ project, projectPath, artifactVersion, onProject, onImportError, onAdd }: { project: StudioProject | undefined; projectPath: string; artifactVersion: number; onProject(project: StudioProject): void; onImportError(error: string): void; onAdd(media: MediaAsset): void }) {
  const [filePath, setFilePath] = useState("");
  const [linked, setLinked] = useState(false);
  const [busy, setBusy] = useState(false);
  const importFile = async () => {
    if (!project || !filePath) return;
    setBusy(true);
    try {
      const result = await api<{ project: StudioProject }>("/api/import", { method: "POST", body: JSON.stringify({ projectPath, filePath, storageMode: linked ? "linked" : "managed", expectedRevision: project.revision }) });
      onProject(result.project); setFilePath("");
    } catch (caught) { onImportError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <aside className="panel media-bin"><div className="panel-title"><span>Media</span><small>{project?.media.length ?? 0}</small></div>
    <div className="import-box"><input value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="Absolute media file path" /><label className="check"><input type="checkbox" checked={linked} onChange={(event) => setLinked(event.target.checked)} /> Link source</label><button className="primary" onClick={() => void importFile()} disabled={!project || !filePath || busy}>{busy ? "Importing…" : "Import media"}</button></div>
    <p className="hint">Double-click an asset to add it at the playhead.</p>
    <div className="asset-list">{project?.media.map((media) => <button key={media.id} className="asset" onDoubleClick={() => onAdd(media)}><span className={`asset-type ${media.kind}`}><img src={mediaArtifactUrl(projectPath, media.id, media.probe.hasVideo ? "thumbnail" : "waveform", artifactVersion)} loading="lazy" onLoad={(event) => { event.currentTarget.hidden = false; }} onError={(event) => { event.currentTarget.hidden = true; }} /><i>{media.kind === "audio" ? "♫" : media.kind === "image" ? "▧" : "▶"}</i></span><span><strong>{media.name}</strong><small>{media.kind} · {secondsLabel(media.probe.durationTick)}</small></span></button>)}</div>
  </aside>;
}

function Preview({ project, projectPath, sequence, selectedClip, selectedMedia, playhead, ready, busy, onBuild, onPlayhead }: { project: StudioProject | undefined; projectPath: string; sequence: Sequence | undefined; selectedClip: Clip | undefined; selectedMedia: MediaAsset | undefined; playhead: number; ready: boolean; busy: boolean; onBuild(): Promise<void>; onPlayhead(tick: number): void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const mediaUrl = selectedMedia ? mediaArtifactUrl(projectPath, selectedMedia.id, "source") : "";
  const previewUrl = ready && project && sequence ? `/preview?token=${encodeURIComponent(token)}&projectPath=${encodeURIComponent(projectPath)}&sequenceId=${encodeURIComponent(sequence.id)}&revision=${project.revision}` : "";
  const seekToPlayhead = useCallback(() => {
    const video = videoRef.current;
    if (video && Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, Math.max(0, ticksToSeconds(playhead)));
  }, [playhead]);
  useEffect(() => {
    const video = videoRef.current;
    if (video?.paused && Math.abs(video.currentTime - ticksToSeconds(playhead)) > 0.04) seekToPlayhead();
  }, [playhead, previewUrl, seekToPlayhead]);
  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) { await onBuild(); return; }
    if (video.paused) await video.play(); else video.pause();
  };
  const step = (direction: -1 | 1) => {
    if (!project) return;
    videoRef.current?.pause();
    onPlayhead(Math.max(0, playhead + direction * framesToTicks(1, project.settings.fps)));
  };
  return <section className="preview-area"><div className="monitor" style={{ aspectRatio: project ? `${project.settings.raster.width}/${project.settings.raster.height}` : "16/9" }}>
    {previewUrl ? <video ref={videoRef} key={previewUrl} src={previewUrl} preload="metadata" onLoadedMetadata={seekToPlayhead} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => project && onPlayhead(framesToTicks(Math.round(event.currentTarget.currentTime * project.settings.fps.numerator / project.settings.fps.denominator), project.settings.fps))} /> : selectedMedia?.kind === "image" ? <img src={mediaUrl} /> : selectedMedia ? <video key={mediaUrl} src={mediaUrl} preload="metadata" /> : selectedClip?.source.type === "color" ? <div className="color-preview" style={{ background: selectedClip.source.color }} /> : selectedClip?.source.type === "animation" ? <div className="animation-preview"><span>◇</span><strong>{selectedClip.name}</strong><small>Deterministic animation clip</small></div> : <div className="empty-monitor"><span>▶</span><strong>{project ? "Build a program preview" : "Open or create a project"}</strong></div>}
    {project && !previewUrl && <div className="preview-callout"><span>{busy ? "Rendering the current revision…" : "Source fallback · program preview is stale"}</span><button className="primary" disabled={busy || !(sequence?.clips.length || sequence?.captions.length)} onClick={() => void onBuild()}>{busy ? "Building…" : "Build preview"}</button></div>}
  </div><div className="transport"><button aria-label="Previous frame" title="Previous frame" disabled={!ready} onClick={() => step(-1)}>◀</button><button aria-label="Play or pause" title="Play or pause" disabled={!project || busy} onClick={() => void togglePlayback()}>{busy ? "…" : playing ? "Ⅱ" : "▶"}</button><button aria-label="Next frame" title="Next frame" disabled={!ready} onClick={() => step(1)}>▶|</button><code>{project ? formatTimecode(playhead, project.settings.fps) : "00:00:00:00"}</code><span>{sequence?.name ?? "No sequence"}</span></div></section>;
}

function Timeline({ project, projectPath, artifactVersion, sequence, selectedClipId, selectedCaptionId, playhead, zoom, onZoom, onPlayhead, onSelect, onSelectCaption, onMove, onMutate }: { project: StudioProject | undefined; projectPath: string; artifactVersion: number; sequence: Sequence | undefined; selectedClipId: string | undefined; selectedCaptionId: string | undefined; playhead: number; zoom: number; onZoom(value: number): void; onPlayhead(value: number): void; onSelect(id: string): void; onSelectCaption(id: string): void; onMove(id: string, track: Track, tick: number): Promise<void>; onMutate(commands: ProjectCommand[]): Promise<void> }) {
  const [dragId, setDragId] = useState<string>();
  const [snapping, setSnapping] = useState(true);
  const [trimEdit, setTrimEdit] = useState<{ clipId: string; edge: "in" | "out"; originalTick: number; currentTick: number }>();
  const durationSeconds = Math.max(60, ...(sequence ? [...sequence.clips.map((clip) => ticksToSeconds(clip.startTick + clip.durationTick) + 5), ...sequence.captions.map((caption) => ticksToSeconds(caption.startTick + caption.durationTick) + 5)] : [60]));
  const width = durationSeconds * zoom;
  const frameTick = project ? framesToTicks(1, project.settings.fps) : secondsToTicks(1 / 30);
  const snapTick = useCallback((tick: number, ignoreClipId?: string) => {
    const aligned = project ? framesToTicks(ticksToFrames(Math.max(0, tick), project.settings.fps, "round"), project.settings.fps) : Math.max(0, tick);
    if (!snapping || !sequence) return aligned;
    const candidates = [0, playhead, ...sequence.clips.filter((clip) => clip.id !== ignoreClipId).flatMap((clip) => [clip.startTick, clip.startTick + clip.durationTick]), ...sequence.captions.filter((caption) => caption.id !== ignoreClipId).flatMap((caption) => [caption.startTick, caption.startTick + caption.durationTick])];
    const threshold = secondsToTicks(10 / zoom);
    let closest = aligned;
    let distance = threshold + 1;
    for (const candidate of candidates) {
      const nextDistance = Math.abs(candidate - aligned);
      if (nextDistance <= threshold && nextDistance < distance) { closest = candidate; distance = nextDistance; }
    }
    return closest;
  }, [playhead, project, sequence, snapping, zoom]);
  const beginTrim = (event: React.PointerEvent, clip: Clip, edge: "in" | "out") => {
    event.preventDefault(); event.stopPropagation(); onSelect(clip.id);
    const startClientX = event.clientX;
    const originalTick = edge === "in" ? clip.startTick : clip.startTick + clip.durationTick;
    let currentTick = originalTick;
    setTrimEdit({ clipId: clip.id, edge, originalTick, currentTick });
    const move = (pointer: PointerEvent) => {
      const raw = originalTick + secondsToTicks((pointer.clientX - startClientX) / zoom);
      const bounded = edge === "in" ? Math.max(0, Math.min(raw, clip.startTick + clip.durationTick - frameTick)) : Math.max(clip.startTick + frameTick, raw);
      currentTick = snapTick(bounded, clip.id);
      setTrimEdit({ clipId: clip.id, edge, originalTick, currentTick });
    };
    const finish = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      setTrimEdit(undefined);
      if (sequence && currentTick !== originalTick) void onMutate([{ type: "clip.trim", sequenceId: sequence.id, clipId: clip.id, edge, tick: currentTick, ripple: false }]);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish, { once: true });
  };
  const keyboardTrim = (event: React.KeyboardEvent, clip: Clip, edge: "in" | "out") => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" || !sequence) return;
    event.preventDefault(); event.stopPropagation();
    const original = edge === "in" ? clip.startTick : clip.startTick + clip.durationTick;
    const raw = original + (event.key === "ArrowLeft" ? -frameTick : frameTick) * (event.shiftKey ? 10 : 1);
    const bounded = edge === "in" ? Math.max(0, Math.min(raw, clip.startTick + clip.durationTick - frameTick)) : Math.max(clip.startTick + frameTick, raw);
    void onMutate([{ type: "clip.trim", sequenceId: sequence.id, clipId: clip.id, edge, tick: bounded, ripple: false }]);
  };
  const addTrack = async (type: Track["type"]) => {
    if (!project || !sequence) return;
    const same = sequence.tracks.filter((track) => track.type === type);
    const id = crypto.randomUUID();
    const order = Math.max(-1, ...sequence.tracks.map((track) => track.order)) + 1;
    await onMutate([{ type: "track.add", sequenceId: sequence.id, track: { id, type, name: `${type[0]!.toUpperCase()}${type.slice(1)} ${same.length + 1}`, order, locked: false, muted: false, solo: false, hidden: false, gainDb: 0, pan: 0 } }]);
  };
  return <section className="timeline-section"><div className="timeline-toolbar"><div><strong>Timeline</strong><button onClick={() => void addTrack("video")}>+ Video</button><button onClick={() => void addTrack("audio")}>+ Audio</button><button onClick={() => void addTrack("overlay")}>+ Overlay</button><button className={snapping ? "active" : ""} aria-pressed={snapping} onClick={() => setSnapping((value) => !value)}>⌁ Snap</button></div><label>Zoom<input type="range" min="24" max="220" value={zoom} onChange={(event) => onZoom(Number(event.target.value))} /></label></div>
    <div className="timeline-scroll"><div className="track-labels"><div className="ruler-spacer" />{sequence?.tracks.map((track) => <div className="track-label" key={track.id}><span className={`track-dot ${track.type}`} /><span><strong>{track.name}</strong><small>{track.type}</small></span><button title="Mute" onClick={() => project && onMutate([{ type: "track.update", sequenceId: sequence.id, trackId: track.id, patch: { muted: !track.muted } }])} className={track.muted ? "active" : ""}>M</button></div>)}</div>
      <div className="lanes" style={{ width }}><div className="ruler" onMouseDown={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onPlayhead(secondsToTicks((event.clientX - rect.left) / zoom)); }}>{Array.from({ length: Math.ceil(durationSeconds / 5) + 1 }, (_, index) => <span key={index} style={{ left: index * 5 * zoom }}>{index * 5}s</span>)}</div>
        {sequence?.tracks.map((track) => <div key={track.id} className={`lane ${track.type}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!dragId) return; const rect = event.currentTarget.getBoundingClientRect(); void onMove(dragId, track, snapTick(secondsToTicks((event.clientX - rect.left) / zoom), dragId)); setDragId(undefined); }} onMouseDown={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); onPlayhead(snapTick(secondsToTicks((event.clientX - rect.left) / zoom))); } }}>
          {sequence.clips.filter((clip) => clip.trackId === track.id).map((clip) => {
            const mediaId = clip.source.type === "media" ? clip.source.mediaId : undefined;
            const media = mediaId ? project?.media.find((item) => item.id === mediaId) : undefined;
            const editing = trimEdit?.clipId === clip.id ? trimEdit : undefined;
            const displayStart = editing?.edge === "in" ? editing.currentTick : clip.startTick;
            const displayEnd = editing?.edge === "out" ? editing.currentTick : clip.startTick + clip.durationTick;
            const artifact = media ? mediaArtifactUrl(projectPath, media.id, media.kind === "audio" ? "waveform" : "thumbnail", artifactVersion) : "";
            return <div role="button" tabIndex={0} aria-selected={selectedClipId === clip.id} draggable key={clip.id} className={`timeline-clip ${selectedClipId === clip.id ? "selected" : ""}`} style={{ left: ticksToSeconds(displayStart) * zoom, width: Math.max(16, ticksToSeconds(displayEnd - displayStart) * zoom), "--clip-color": clipColor(clip, media) } as React.CSSProperties} onClick={(event) => { event.stopPropagation(); onSelect(clip.id); }} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const next = Math.max(0, clip.startTick + (event.key === "ArrowLeft" ? -frameTick : frameTick) * (event.shiftKey ? 10 : 1)); void onMove(clip.id, track, next); }} onDragStart={() => setDragId(clip.id)} title={`${clip.name}\n${secondsLabel(clip.startTick)} — ${secondsLabel(clip.startTick + clip.durationTick)}`}><span className="trim-handle trim-in" role="slider" tabIndex={0} aria-label={`Trim start of ${clip.name}`} aria-valuenow={ticksToSeconds(clip.startTick)} onPointerDown={(event) => beginTrim(event, clip, "in")} onKeyDown={(event) => keyboardTrim(event, clip, "in")} /><span className="clip-art" style={artifact ? { backgroundImage: `url(${artifact})` } : undefined}>{clip.source.type === "animation" ? "◇" : media?.kind === "audio" ? "♫" : "▶"}</span><strong>{clip.name}</strong><small>{secondsLabel(displayEnd - displayStart)}</small><span className="trim-handle trim-out" role="slider" tabIndex={0} aria-label={`Trim end of ${clip.name}`} aria-valuenow={ticksToSeconds(clip.startTick + clip.durationTick)} onPointerDown={(event) => beginTrim(event, clip, "out")} onKeyDown={(event) => keyboardTrim(event, clip, "out")} /></div>;
          })}
          {sequence.captions.filter((caption) => caption.trackId === track.id).map((caption) => <div role="button" tabIndex={0} key={caption.id} aria-selected={selectedCaptionId === caption.id} className={`caption-block ${selectedCaptionId === caption.id ? "selected" : ""}`} style={{ left: ticksToSeconds(caption.startTick) * zoom, width: Math.max(24, ticksToSeconds(caption.durationTick) * zoom) }} title={`${caption.text}\n${secondsLabel(caption.startTick)} — ${secondsLabel(caption.startTick + caption.durationTick)}`} onClick={(event) => { event.stopPropagation(); onSelectCaption(caption.id); }} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const startTick = Math.max(0, caption.startTick + (event.key === "ArrowLeft" ? -frameTick : frameTick) * (event.shiftKey ? 10 : 1)); void onMutate([{ type: "caption.update", sequenceId: sequence.id, captionId: caption.id, patch: { startTick } }]); }}><span>CC</span><strong>{caption.text}</strong></div>)}
        </div>)}
        <div className="playhead" style={{ left: ticksToSeconds(playhead) * zoom }}><span /></div>
      </div>
    </div>
  </section>;
}

function GenerationCenter({ project, projectPath, sequence, playhead, onProject, onClose, onError }: { project: StudioProject; projectPath: string; sequence: Sequence; playhead: number; onProject(project: StudioProject): void; onClose(): void; onError(message: string): void }) {
  const [kind, setKind] = useState<GeneratedArtifact["kind"]>("narration");
  const [name, setName] = useState("Narration");
  const [prompt, setPrompt] = useState("");
  const [duration, setDuration] = useState(5);
  const [provider, setProvider] = useState<"openai" | "elevenlabs">("elevenlabs");
  const [voiceId, setVoiceId] = useState("");
  const [sourceMediaId, setSourceMediaId] = useState(project.media.find((media) => media.probe.hasAudio)?.id ?? "");
  const [providers, setProviders] = useState<Record<string, { configured?: boolean; model?: string; capabilities?: string[] }>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api<{ providers: typeof providers }>("/api/providers").then((result) => setProviders(result.providers)); }, []);
  useEffect(() => { setName(kind === "narration" ? "Narration" : kind === "music" ? "Music bed" : kind === "captions" ? "Captions" : "Generated animation"); }, [kind]);
  const generate = async () => {
    const track = sequence.tracks.find((item) => kind === "captions" ? item.type === "caption" : kind === "animation" ? item.type === "overlay" || item.type === "video" : item.type === "audio");
    if (!track) { onError(`Add a ${kind === "animation" ? "video or overlay" : kind === "captions" ? "caption" : "audio"} track first.`); return; }
    const durationTick = kind === "narration" || kind === "music" ? secondsToTicks(Math.max(0.1, duration)) : framesToTicks(Math.max(1, ticksToFrames(secondsToTicks(Math.max(0.1, duration)), project.settings.fps, "round")), project.settings.fps);
    const body = { projectPath, expectedRevision: project.revision, kind, sequenceId: sequence.id, trackId: track.id, startTick: playhead, durationTick, name, prompt, text: prompt, provider, voiceId, sourceMediaId };
    setBusy(true);
    try {
      const result = await api<{ project: StudioProject }>("/api/generate", { method: "POST", body: JSON.stringify(body) });
      onProject(result.project);
    } catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop generation-backdrop"><div className="generation-modal">
    <div className="modal-head"><div><p className="eyebrow">GENERATED CONTENT</p><h1>Review, revise, and regenerate</h1><p className="generation-subtitle">Every request becomes a persistent version. Activating a new version preserves timeline timing, effects, and mix edits.</p></div><button className="close" onClick={onClose}>×</button></div>
    <div className="provider-strip">{Object.entries(providers).map(([id, status]) => <span key={id} className={status.configured ? "configured" : "missing"}><i />{id} · {status.configured ? "ready" : "not configured"}</span>)}</div>
    <div className="generation-layout">
      <section className="generation-create"><h3>New draft at {formatTimecode(playhead, project.settings.fps)}</h3>
        <label>Type<select value={kind} onChange={(event) => setKind(event.currentTarget.value as GeneratedArtifact["kind"])}><option value="narration">Narration</option><option value="music">Music</option><option value="captions">Captions from media</option><option value="animation">Animation</option></select></label>
        <label>Name<input value={name} onChange={(event) => setName(event.currentTarget.value)} /></label>
        {kind !== "captions" && <label>{kind === "narration" ? "Script" : "Prompt"}<textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} placeholder={kind === "narration" ? "Text to narrate…" : kind === "music" ? "Instrumental mood, structure, energy…" : "Describe the scene and motion…"} /></label>}
        {kind === "captions" && <label>Source media<select value={sourceMediaId} onChange={(event) => setSourceMediaId(event.currentTarget.value)}>{project.media.filter((media) => media.probe.hasAudio).map((media) => <option key={media.id} value={media.id}>{media.name}</option>)}</select></label>}
        {kind !== "music" && kind !== "animation" && <label>Provider<select value={provider} onChange={(event) => setProvider(event.currentTarget.value as "openai" | "elevenlabs")}><option value="elevenlabs">ElevenLabs</option><option value="openai">OpenAI-compatible</option></select></label>}
        {kind === "narration" && <label>Voice ID <small>(optional/default)</small><input value={voiceId} onChange={(event) => setVoiceId(event.currentTarget.value)} /></label>}
        <label>Timeline slot <output>{duration.toFixed(1)}s</output><input type="range" min="1" max="60" step="0.5" value={duration} onChange={(event) => setDuration(Number(event.currentTarget.value))} /></label>
        <button className="primary large" disabled={busy || !name.trim() || (kind !== "captions" && !prompt.trim()) || (kind === "captions" && !sourceMediaId)} onClick={() => void generate()}>{busy ? "Queueing…" : "Generate draft"}</button>
      </section>
      <section className="generation-library"><div className="generation-heading"><h3>Project artifacts</h3><span>{project.generatedArtifacts.length}</span></div>{project.generatedArtifacts.length ? project.generatedArtifacts.map((artifact) => <GeneratedArtifactCard key={artifact.id} artifact={artifact} project={project} projectPath={projectPath} onProject={onProject} onError={onError} />) : <div className="empty-panel"><span>✦</span><p>No generated artifacts yet. Imported recordings remain supported as normal media.</p></div>}</section>
    </div>
  </div></div>;
}

function GeneratedArtifactCard({ artifact, project, projectPath, onProject, onError }: { artifact: GeneratedArtifact; project: StudioProject; projectPath: string; onProject(project: StudioProject): void; onError(message: string): void }) {
  const active = artifact.versions.find((version) => version.id === artifact.activeVersionId) ?? artifact.versions.at(-1)!;
  const source = active.request.text ?? active.request.prompt ?? "";
  const [revisionText, setRevisionText] = useState(source);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRevisionText(source); }, [active.id, source]);
  const regenerate = async () => {
    setBusy(true);
    try {
      const requestPatch: Partial<GenerationRequest> = active.request.text !== undefined ? { text: revisionText } : active.request.prompt !== undefined ? { prompt: revisionText } : {};
      const result = await api<{ project: StudioProject }>("/api/generated/regenerate", { method: "POST", body: JSON.stringify({ projectPath, expectedRevision: project.revision, artifactId: artifact.id, requestPatch }) });
      onProject(result.project);
    } catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const review = async (versionId: string, action: "activate" | "approve" | "reject") => {
    setBusy(true);
    try {
      const result = await api<{ project: StudioProject }>("/api/generated/review", { method: "POST", body: JSON.stringify({ projectPath, expectedRevision: project.revision, artifactId: artifact.id, versionId, action, reviewer: "Studio user", note }) });
      onProject(result.project); setNote("");
    } catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <article className="generated-card"><header><span className={`kind-badge ${artifact.kind}`}>{artifact.kind}</span><div><strong>{artifact.name}</strong><small>{secondsLabel(artifact.scope.startTick)} · {secondsLabel(artifact.scope.durationTick)} slot</small></div><em>{artifact.versions.length} version{artifact.versions.length === 1 ? "" : "s"}</em></header>
    {(active.request.text !== undefined || active.request.prompt !== undefined) && <label>Revise and regenerate<textarea rows={3} value={revisionText} onChange={(event) => setRevisionText(event.currentTarget.value)} /></label>}
    <div className="generated-actions"><button onClick={() => void regenerate()} disabled={busy}>↻ Regenerate</button><input value={note} onChange={(event) => setNote(event.currentTarget.value)} placeholder="Review note (optional)" /></div>
    <div className="version-list">{[...artifact.versions].reverse().map((version) => {
      const mediaId = version.output?.mediaId;
      return <div className={`version-row ${version.status}`} key={version.id}><div className="version-meta"><strong>{version.status}</strong><span>{version.provenance.provider} · {version.provenance.model}</span><small>{new Date(version.createdAt).toLocaleString()} · {version.id.slice(0, 8)}{artifact.activeVersionId === version.id ? " · ACTIVE" : ""}{artifact.approvedVersionId === version.id ? " · APPROVED" : ""}</small></div>{mediaId && <audio controls preload="none" src={mediaArtifactUrl(projectPath, mediaId, "source")} />}{version.error && <p className="version-error">{version.error.message}</p>}<div className="version-buttons">{version.output && artifact.activeVersionId !== version.id && <button disabled={busy} onClick={() => void review(version.id, "activate")}>Activate</button>}{version.output && artifact.approvedVersionId !== version.id && <button disabled={busy} onClick={() => void review(version.id, "approve")}>Approve</button>}{version.status !== "rejected" && version.status !== "failed" && <button disabled={busy} onClick={() => void review(version.id, "reject")}>Reject</button>}</div></div>;
    })}</div>
  </article>;
}

function Inspector({ project, sequence, clip, jobs, projectPath, onUpdate, onMutate, onError }: { project: StudioProject | undefined; sequence: Sequence | undefined; clip: Clip | undefined; jobs: JobRecord[]; projectPath: string; onUpdate(command: ProjectCommand & { type: "clip.update" }): void; onMutate(commands: ProjectCommand[]): Promise<void>; onError(error: string): void }) {
  const [tab, setTab] = useState<"clip" | "export" | "jobs">("clip");
  const [outputPath, setOutputPath] = useState("");
  useEffect(() => { if (projectPath) setOutputPath(`${projectPath}\\exports\\export.mp4`); }, [projectPath]);
  const patch = (value: Partial<Clip>) => { if (project && sequence && clip) onUpdate({ type: "clip.update", sequenceId: sequence.id, clipId: clip.id, patch: value }); };
  const addEffect = (kind: "blur" | "brightness" | "equalizer") => {
    if (!clip) return;
    const effect: EffectInstance = { id: crypto.randomUUID(), type: kind, enabled: true, version: 1, parameters: kind === "blur" ? { radius: 8 } : kind === "brightness" ? { value: 0.1 } : { bands: [{ frequency: 100, q: 1, gainDb: 0 }, { frequency: 1000, q: 1, gainDb: 0 }, { frequency: 8000, q: 1, gainDb: 0 }] } };
    if (kind === "equalizer") patch({ audio: { ...clip.audio, effects: [...clip.audio.effects, effect] } });
    else patch({ effects: [...clip.effects, effect] });
  };
  const render = async () => {
    if (!project || !sequence || !outputPath) return;
    try { await api("/api/render", { method: "POST", body: JSON.stringify({ projectPath, sequenceId: sequence.id, presetId: project.exportPresets[0]?.id, outputPath }) }); setTab("jobs"); }
    catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
  };
  return <aside className="panel inspector"><div className="tabs"><button className={tab === "clip" ? "active" : ""} onClick={() => setTab("clip")}>Inspector</button><button className={tab === "export" ? "active" : ""} onClick={() => setTab("export")}>Export</button><button className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>Jobs</button></div>
    {tab === "clip" && (clip ? <div className="inspector-body"><h3>{clip.name}</h3><small>{clip.source.type} clip · {secondsLabel(clip.durationTick)}</small><fieldset><legend>Timing</legend><label>Start (seconds)<input key={`${clip.id}-start-${clip.startTick}`} type="number" min="0" step="0.033" defaultValue={ticksToSeconds(clip.startTick)} onBlur={(event) => { if (!sequence || !project || !Number.isFinite(event.currentTarget.valueAsNumber)) return; const tick = framesToTicks(ticksToFrames(secondsToTicks(Math.max(0, event.currentTarget.valueAsNumber)), project.settings.fps, "round"), project.settings.fps); void onMutate([{ type: "clip.move", sequenceId: sequence.id, clipIds: [clip.id], targetTrackId: clip.trackId, startTick: tick, ripple: false }]); }} /></label><label>Duration (seconds)<input key={`${clip.id}-duration-${clip.durationTick}`} type="number" min={ticksToSeconds(framesToTicks(1, project!.settings.fps))} step="0.033" defaultValue={ticksToSeconds(clip.durationTick)} onBlur={(event) => { if (!sequence || !project || !Number.isFinite(event.currentTarget.valueAsNumber)) return; const duration = framesToTicks(Math.max(1, ticksToFrames(secondsToTicks(event.currentTarget.valueAsNumber), project.settings.fps, "round")), project.settings.fps); void onMutate([{ type: "clip.trim", sequenceId: sequence.id, clipId: clip.id, edge: "out", tick: clip.startTick + duration, ripple: false }]); }} /></label></fieldset><fieldset><legend>Transform</legend><div className="field-pair"><label>X<input type="number" step="0.01" defaultValue={clip.transform.position[0]} onBlur={(event) => patch({ transform: { ...clip.transform, position: [Number(event.target.value), clip.transform.position[1]] } })} /></label><label>Y<input type="number" step="0.01" defaultValue={clip.transform.position[1]} onBlur={(event) => patch({ transform: { ...clip.transform, position: [clip.transform.position[0], Number(event.target.value)] } })} /></label></div><label>Opacity<input type="range" min="0" max="1" step="0.01" value={clip.transform.opacity} onChange={(event) => patch({ transform: { ...clip.transform, opacity: Number(event.target.value) } })} /></label><label>Rotation<input type="number" value={clip.transform.rotation} onChange={(event) => patch({ transform: { ...clip.transform, rotation: Number(event.target.value) } })} /></label></fieldset><fieldset><legend>Audio</legend><label>Gain <output>{clip.audio.gainDb} dB</output><input type="range" min="-60" max="12" step="0.5" value={clip.audio.gainDb} onChange={(event) => patch({ audio: { ...clip.audio, gainDb: Number(event.target.value) } })} /></label><label className="check"><input type="checkbox" checked={clip.audio.muted} onChange={(event) => patch({ audio: { ...clip.audio, muted: event.target.checked } })} /> Muted</label></fieldset><fieldset><legend>Effects</legend><div className="effect-buttons"><button onClick={() => addEffect("blur")}>+ Blur</button><button onClick={() => addEffect("brightness")}>+ Exposure</button><button onClick={() => addEffect("equalizer")}>+ EQ</button></div>{[...clip.effects, ...clip.audio.effects].map((effect) => <div className="effect-row" key={effect.id}><span>{effect.type}</span><em>{effect.enabled ? "on" : "off"}</em></div>)}</fieldset></div> : <div className="empty-panel"><span>◇</span><p>Select a clip to edit timing, transform, audio, and effects.</p></div>)}
    {tab === "export" && <div className="inspector-body"><h3>Export sequence</h3><label>Preset<select>{project?.exportPresets.map((preset) => <option key={preset.id}>{preset.name}</option>)}</select></label><label>Output path<textarea rows={3} value={outputPath} onChange={(event) => setOutputPath(event.target.value)} /></label><button className="primary large" onClick={() => void render()} disabled={!project || !sequence}>Queue render</button><p className="hint">Rendering uses a generated FFmpeg filter graph and verifies the artifact before completing.</p></div>}
    {tab === "jobs" && <div className="job-list">{jobs.length ? jobs.map((job) => <div className={`job ${job.status}`} key={job.id}><div><strong>{job.type}</strong><span>{job.status}</span></div><p>{job.message}</p><div className="progress"><span style={{ width: `${job.progress * 100}%` }} /></div>{job.error && <small>{job.error.message}</small>}</div>) : <div className="empty-panel"><p>No background jobs yet.</p></div>}</div>}
  </aside>;
}

function CaptionInspector({ project, sequence, caption, onMutate }: { project: StudioProject; sequence: Sequence; caption: CaptionCue; onMutate(commands: ProjectCommand[]): Promise<void> }) {
  const update = (patch: Extract<ProjectCommand, { type: "caption.update" }>["patch"]) => void onMutate([{ type: "caption.update", sequenceId: sequence.id, captionId: caption.id, patch }]);
  const alignedTick = (seconds: number) => framesToTicks(ticksToFrames(secondsToTicks(Math.max(0, seconds)), project.settings.fps, "round"), project.settings.fps);
  return <aside className="panel inspector"><div className="tabs"><button className="active">Caption</button></div><div className="inspector-body caption-inspector">
    <h3>Caption</h3><small>{secondsLabel(caption.durationTick)} · {caption.style.position}</small>
    <fieldset><legend>Text</legend><label>Caption text<textarea key={`${caption.id}-text-${caption.text}`} rows={4} defaultValue={caption.text} onBlur={(event) => event.currentTarget.value.trim() && update({ text: event.currentTarget.value.trim() })} /></label></fieldset>
    <fieldset><legend>Timing</legend><label>Start (seconds)<input key={`${caption.id}-start-${caption.startTick}`} type="number" min="0" step="0.033" defaultValue={ticksToSeconds(caption.startTick)} onBlur={(event) => Number.isFinite(event.currentTarget.valueAsNumber) && update({ startTick: alignedTick(event.currentTarget.valueAsNumber) })} /></label><label>Duration (seconds)<input key={`${caption.id}-duration-${caption.durationTick}`} type="number" min={ticksToSeconds(framesToTicks(1, project.settings.fps))} step="0.033" defaultValue={ticksToSeconds(caption.durationTick)} onBlur={(event) => Number.isFinite(event.currentTarget.valueAsNumber) && update({ durationTick: Math.max(framesToTicks(1, project.settings.fps), alignedTick(event.currentTarget.valueAsNumber)) })} /></label></fieldset>
    <fieldset><legend>Style</legend><label>Position<select value={caption.style.position} onChange={(event) => update({ style: { ...caption.style, position: event.currentTarget.value as CaptionCue["style"]["position"] } })}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label><label>Alignment<select value={caption.style.align} onChange={(event) => update({ style: { ...caption.style, align: event.currentTarget.value as CaptionCue["style"]["align"] } })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label><label>Font size<input type="number" min="8" max="500" value={caption.style.fontSize} onChange={(event) => update({ style: { ...caption.style, fontSize: Number(event.currentTarget.value) } })} /></label><div className="field-pair"><label>Text color<input type="color" value={caption.style.color.slice(0, 7)} onChange={(event) => update({ style: { ...caption.style, color: event.currentTarget.value } })} /></label><label>Background<input type="color" value={caption.style.background.slice(0, 7)} onChange={(event) => update({ style: { ...caption.style, background: `${event.currentTarget.value}aa` } })} /></label></div></fieldset>
  </div></aside>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
