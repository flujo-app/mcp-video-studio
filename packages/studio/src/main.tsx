import {RetimeTools} from "./retime-tools.js";
import {ExportOptions,type ExportSelection} from "./export-options.js";
import {availableExportPresets} from "@mcp-video-studio/contracts";
import {TimelineTileStrip,SourceFrame} from "./timeline-tiles.js";
import {ExportHistory} from './export-history.js';
import {PlaybackControls,TimelineReviewControls,useTimelineMarquee} from "./editing-controls.js";
import "./editing-controls.css";
import {ProjectFiles,waitStudioJob} from './project-files.js';
import {CaptionLayoutFeedback} from "./caption-layout-feedback.js";
import {CaptionStyleControls} from "./caption-style-controls.js";
import {SequenceTools} from "./sequence-tools.js";
import {GenerationReview} from "./generation-review.js";
import {AnimationEditor} from "./animation-editor.js";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import { SelectionTools, useModalFocus } from "./timeline-tools.js";
import {ProgramAudioMeter} from "./audio-meters.js";
import {AudioMixer,ClipAudioTools} from "./audio-tools.js";
import {QualityControl} from "./qc-tools.js";
import {ClipFinishing} from "./finishing-tools.js";
import "./styles.css";
import "./layout-fixes.css";
import {
  STUDIO_DISPLAY_MODES,
  getStudioDisplayState,
  requestStudioDisplayMode,
  subscribeToStudioDisplayState,
  type McpUiDisplayMode,
} from "./mcp-app.js";

const suppliedToken = new URLSearchParams(location.search).get("token") || document.body.dataset.token;
if (suppliedToken) sessionStorage.setItem("mcp-video-studio:access", suppliedToken);
const token = suppliedToken || sessionStorage.getItem("mcp-video-studio:access") || "";
delete document.body.dataset.token;
const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete("token"); history.replaceState(null, "", cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);

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

class ApiError extends Error { constructor(message:string,readonly code?:string){super(message);} }

async function api<T>(route: string, init?: RequestInit): Promise<T> {
  const url = route;
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init?.headers } });
  const value = await response.json() as T & { success?: boolean; error?: { message?: string;code?:string } };
  if (!response.ok || value.success === false) throw new ApiError(value.error?.message || "Request failed ("+response.status+")",value.error?.code);
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
  const [insertMode,setInsertMode]=useState<"overwrite"|"insert"|"ripple">("overwrite");
  const display = useSyncExternalStore(subscribeToStudioDisplayState, getStudioDisplayState, getStudioDisplayState);
  const [projects, setProjects] = useState<Array<{ path: string; name: string; projectId: string; revision: number }>>([]);
  const [projectPath, setProjectPath] = useState(new URLSearchParams(location.search).get("projectPath") || localStorage.getItem("mcp-video-studio:lastProject") || "");
  const [project,setProjectState]=useState<StudioProject>();
  const openSerial=useRef(0);
  // Delayed refresh/mutation responses must not replace a newer revision or a newly opened location.
  const setProject=useCallback((next:StudioProject)=>{if(projectPathRef.current!==projectPath)return;setProjectState(previous=>previous&&(previous.projectId!==next.projectId||previous.revision>next.revision)?previous:next);},[projectPath]);
  const [selectedClipId, setSelectedClipId] = useState<string>();
  const [selectedClipIds,setSelectedClipIds]=useState<string[]>([]);
  const selectClips=(ids:string[])=>{setSelectedClipIds(ids);setSelectedClipId(ids.at(-1));setSelectedCaptionId(undefined);};
  const [selectedCaptionId, setSelectedCaptionId] = useState<string>();
  const [playhead, setPlayhead] = useState(0);
  const [zoom, setZoom] = useState(72);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [cachedPreviewRevision, setCachedPreviewRevision] = useState<number>();
  const [notice, setNotice] = useState("Ready");
  const [error, setError] = useState("");
  const [showProjects, setShowProjects] = useState(!projectPath);
  const [showWorkflow, setShowWorkflow] = useState(false);
  const [pendingReviewed,setPendingReviewed]=useState(false);
  const [pendingCommands, setPendingCommands] = useState<ProjectCommand[]>([]);
  const [showGeneration, setShowGeneration] = useState(false);
  useModalFocus(showProjects||showWorkflow||showGeneration);
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
  const artifactVersion = jobs.filter((job) => job.status === "completed" && (job.type === "thumbnail" || job.type === "waveform" || job.type === "proxy")).length;

  const refreshProjects = useCallback(async () => {
    const result = await api<{ projects: typeof projects }>("/api/projects");
    setProjects(result.projects);
  }, []);

  const openProject = useCallback(async (nextPath: string) => {
    if (!nextPath) return;
    const serial=++openSerial.current;
    try {
      setError(""); setNotice("Opening project…");
      const result = await api<{ project: StudioProject }>(`/api/project?projectPath=${encodeURIComponent(nextPath)}`);
      if(serial!==openSerial.current)return;
      const openedUrl=new URL(location.href);openedUrl.searchParams.set("projectPath",nextPath);history.replaceState(null,"",openedUrl.pathname+openedUrl.search+openedUrl.hash);
      projectPathRef.current=nextPath;setProjectState(result.project); setProjectPath(nextPath); setSelectedClipIds([]);setSelectedClipId(undefined); setSelectedCaptionId(undefined); setShowProjects(false); setCachedPreviewRevision(undefined);
      localStorage.setItem("mcp-video-studio:lastProject", nextPath); setNotice("Project loaded");
    } catch (caught) { if(serial===openSerial.current){setError(caught instanceof Error ? caught.message : String(caught));setShowProjects(true);} }
  }, []);

  useEffect(() => { void refreshProjects(); if (projectPath) void openProject(projectPath); }, []);
  useEffect(() => {
    const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
    events.addEventListener("job", (event) => {
      const job = JSON.parse((event as MessageEvent).data) as JobRecord;
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].slice(0, 30));
      if ((job.type === "generation" || (job.type === "media" && job.result?.operationId)) && ["completed", "failed", "cancelled"].includes(job.status) && projectPathRef.current) {
        const requestedPath=projectPathRef.current;void api<{project:StudioProject}>(`/api/project?projectPath=${encodeURIComponent(requestedPath)}`).then(result=>{if(projectPathRef.current===requestedPath)setProjectState(previous=>previous&&(previous.projectId!==result.project.projectId||previous.revision>result.project.revision)?previous:result.project);}).catch(()=>undefined);
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
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); setNotice("Edit rejected"); if(caught instanceof ApiError&&caught.code==="REVISION_CONFLICT"){setPendingCommands(commands);setPendingReviewed(false);} }
  }, [project, projectPath]);

  const undoRedo = async (kind: "undo" | "redo") => {
    if (!project) return;
    try {
      const result = await api<{ project: StudioProject }>(`/api/${kind}`, { method: "POST", body: JSON.stringify({ projectPath, expectedRevision: project.revision }) });
      setProject(result.project); setNotice(kind === "undo" ? "Undone" : "Redone");
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const addMediaClip = async (media: MediaAsset, targetTrackId?:string, atTick=playhead) => {
    if (!project || !sequence) return;
    const track = sequence.tracks.find((item) => (!targetTrackId||item.id===targetTrackId)&&(media.kind === "audio" ? item.type === "audio" : item.type === "video" || item.type === "overlay"));
    if (!track) { setError(`Add a ${media.kind === "audio" ? "audio" : "video"} track first.`); return; }
    const rawDuration = media.kind === "image" ? secondsToTicks(5) : media.probe.durationTick;
    const duration = track.type === "audio" ? rawDuration : framesToTicks(Math.max(1,ticksToFrames(rawDuration, project.settings.fps, "floor")), project.settings.fps);
    const clip = defaultClip(track.id, { type: "media", mediaId: media.id }, media.name, duration);
    clip.startTick = framesToTicks(ticksToFrames(atTick, project.settings.fps, "round"), project.settings.fps);
    selectClips([clip.id]);
    await mutate([{ type: "clip.add", sequenceId: sequence.id, clip, mode: insertMode }]);
  };

  const addColor = async () => {
    if (!project || !sequence) return;
    const track = sequence.tracks.find((item) => item.type === "video" || item.type === "overlay");
    if (!track) return;
    const clip = defaultClip(track.id, { type: "color", color: "#243b69" }, "Color card", secondsToTicks(5));
    clip.startTick = framesToTicks(ticksToFrames(playhead, project.settings.fps, "round"), project.settings.fps);
    selectClips([clip.id]);
    await mutate([{ type: "clip.add", sequenceId: sequence.id, clip, mode: insertMode }]);
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
    selectClips([clip.id]);
    await mutate([{ type: "animation.set", animation }, { type: "clip.add", sequenceId: sequence.id, clip, mode: insertMode }]);
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
      setSelectedClipId(undefined);setSelectedClipIds([]);
      await mutate([{ type: "clip.remove", sequenceId: sequence.id, clipIds: selectedClipIds.length?selectedClipIds:[selectedClip.id], ripple: false }]);
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

  const switchDisplayMode = async (mode: McpUiDisplayMode) => {
    try {
      setError(""); setNotice(`Switching to ${mode} view…`);
      const actualMode = await requestStudioDisplayMode(mode);
      setNotice(`Using ${actualMode} view`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setNotice("View change rejected");
    }
  };

  return <div className={`app-shell display-${display.mode}`}>
    <header className="topbar">
      <button className="brand" onClick={() => setShowProjects(true)}><span className="brand-mark">▶</span><span>MCP Video Studio</span></button>
      <div className="project-title"><span>{project?.name ?? "No project"}</span>{project && <small>rev {project.revision}</small>}</div>
      <div className="toolbar">
        <button onClick={() => void undoRedo("undo")} disabled={!project} title="Undo" aria-label="Undo">↶</button>
        <button onClick={() => void undoRedo("redo")} disabled={!project} title="Redo" aria-label="Redo">↷</button>
        <span className="separator" />
        <button onClick={() => setShowWorkflow(true)} disabled={!project}>Editing workflows</button><button onClick={() => {sessionStorage.removeItem("mcp-video-studio:access");location.reload();}}>Lock editor</button>
        <button onClick={() => void addColor()} disabled={!project}>Color</button><label className="insertion-mode">New clip edit mode<select aria-label="New clip edit mode" value={insertMode} onChange={e=>setInsertMode(e.target.value as typeof insertMode)}><option value="overwrite">Overwrite</option><option value="insert">Insert on track</option><option value="ripple">Ripple all tracks</option></select></label>
        <button onClick={() => void addTitleAnimation()} disabled={!project}>Animated title</button>
        <button onClick={() => void addCaption()} disabled={!project}>Caption</button>
        <button onClick={() => setShowGeneration(true)} disabled={!project}>Generate{project?.generatedArtifacts.length ? ` ${project.generatedArtifacts.length}` : ""}</button>
        <button onClick={() => void splitSelected()} disabled={!selectedClip}>Split</button>
        <button className="danger" onClick={() => void removeSelected()} disabled={!selectedClip && !selectedCaption}>Delete</button>
      </div>
      {display.embedded && <div className="display-modes" role="group" aria-label="Studio view mode">
        {STUDIO_DISPLAY_MODES.map((mode) => {
          const available = display.connected && display.availableDisplayModes.includes(mode);
          const label = mode === "pip" ? "PiP" : mode[0]!.toUpperCase() + mode.slice(1);
          return <button key={mode} type="button" className={display.mode === mode ? "active" : ""} aria-pressed={display.mode === mode} disabled={!available} title={available ? `Use ${label} view` : `${label} view is unavailable in this host`} onClick={() => void switchDisplayMode(mode)}>{label}</button>;
        })}
      </div>}
      <div className="status" title={display.error ?? notice}><span className={`status-dot ${display.error ? "error" : ""}`} />{notice}</div>
    </header>

    {pendingCommands.length > 0 && <div role="alert"><p>The edit was not saved. Reload the latest project before reviewing and reapplying it.</p><button onClick={()=>void api<{project:StudioProject}>("/api/project?projectPath="+encodeURIComponent(projectPath)).then(result=>{setProject(result.project);setPendingReviewed(true);setError("");}).catch(error=>setError(error.message))}>Reload latest</button><button disabled={!pendingReviewed} onClick={() => { const commands=pendingCommands; setPendingCommands([]); void mutate(commands); }}>Reapply edit to current revision</button><button onClick={() => setPendingCommands([])}>Discard edit</button></div>}
    {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}

    <main className="workspace">
      <MediaBin project={project} projectPath={projectPath} artifactVersion={artifactVersion} onProject={setProject} onImportError={setError} onAdd={addMediaClip} />
      <section className="center-stage">
        <Preview artifactVersion={artifactVersion} project={project} projectPath={projectPath} sequence={sequence} selectedClip={selectedClip} selectedMedia={selectedMedia} playhead={playhead} ready={previewReady} busy={previewBusy} onBuild={buildPreview} onPlayhead={setPlayhead} />
        <Timeline onAddMedia={addMediaClip} project={project} projectPath={projectPath} artifactVersion={artifactVersion} sequence={sequence} selectedClipId={selectedClipId} selectedClipIds={selectedClipIds} onSelectClips={selectClips} selectedCaptionId={selectedCaptionId} playhead={playhead} zoom={zoom} onZoom={setZoom} onPlayhead={setPlayhead} onSelect={(id) => { selectClips([id]); }} onSelectCaption={(id) => { setSelectedCaptionId(id); setSelectedClipId(undefined);setSelectedClipIds([]); }} onMove={moveClip} onMutate={mutate} />
      </section>
      {selectedCaption && project && sequence ? <CaptionInspector project={project} projectPath={projectPath} sequence={sequence} caption={selectedCaption} onMutate={mutate} /> : <Inspector onProjectChange={setProject} project={project} sequence={sequence} clip={selectedClip} jobs={jobs} projectPath={projectPath} onUpdate={updateSelected} onMutate={mutate} onError={setError} onNavigate={(tick,ids,captionIds)=>{setPlayhead(tick);selectClips(ids);if(captionIds?.[0])setSelectedCaptionId(captionIds[0]);}} />}
    </main>

    {showProjects && <ProjectChooser projects={projects} initialPath={projectPath} onRefresh={refreshProjects} onOpen={openProject} onClose={() => project && setShowProjects(false)} />}
    {showWorkflow && project && sequence && <WorkflowTools project={project} sequence={sequence} projectPath={projectPath} selectedClip={selectedClip} playhead={playhead} onProject={setProject} onMutate={mutate} onClose={()=>setShowWorkflow(false)} onError={setError}/> }
    {showGeneration && project && sequence && <GenerationCenter project={project} projectPath={projectPath} sequence={sequence} playhead={playhead} onProject={setProject} onClose={() => setShowGeneration(false)} onError={setError} />}
  </div>;
}

function ProjectChooser({ projects, initialPath, onRefresh, onOpen, onClose }: { projects: Array<{ path: string; name: string; revision: number }>; initialPath: string; onRefresh(): Promise<void>; onOpen(path: string): Promise<void>; onClose(): void }) {
  const [name, setName] = useState("Untitled video");
  const [customPath, setCustomPath] = useState(initialPath);
  const [archivePath,setArchivePath]=useState("");
  const [archiveError,setArchiveError]=useState("");
  const [archiveJob,setArchiveJob]=useState<JobRecord>();
  const archiveObserver=useRef(new AbortController());useEffect(()=>()=>archiveObserver.current.abort(),[]);
  const importArchive=async()=>{setBusy(true);try{const queued=await api<{job:JobRecord}>("/api/archive/import",{method:"POST",body:JSON.stringify({filePath:archivePath,destinationPath:customPath})});setArchiveJob(queued.job);const result=await waitStudioJob(api,queued.job.id,setArchiveJob,archiveObserver.current.signal);await onRefresh();if(!archiveObserver.current.signal.aborted)await onOpen(String(result.projectPath));}catch(error){if(!archiveObserver.current.signal.aborted)setArchiveError(error instanceof Error?error.message:String(error));}finally{if(!archiveObserver.current.signal.aborted)setBusy(false);}};
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const result = await api<{ projectPath: string }>("/api/project/create", { method: "POST", body: JSON.stringify({ name, ...(customPath ? { projectPath: customPath } : {}) }) });
      await onRefresh(); await onOpen(result.projectPath);
    } finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><div className="project-modal">
    <div className="modal-head"><div><p className="eyebrow">STANDALONE WORKSPACE</p><h1>Choose a project</h1></div><button className="close" aria-label="Close dialog" onClick={onClose}>×</button></div>
    <div className="project-grid">
      <section><h3>Recent projects</h3><div className="recent-list">{projects.length ? projects.map((item) => <button key={item.path} className="recent-card" onClick={() => void onOpen(item.path)}><span className="recent-icon">▶</span><span><strong>{item.name}</strong><small>{item.path}</small></span><em>rev {item.revision}</em></button>) : <p className="empty">No projects yet.</p>}</div></section>
      <section className="new-project"><h3>New project</h3><label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>Location <small>(optional)</small><input value={customPath} onChange={(event) => setCustomPath(event.target.value)} placeholder="Uses configured projects folder" /></label><button className="primary large" disabled={busy || !name.trim()} onClick={() => void create()}>{busy ? "Creating…" : "Create project"}</button><button disabled={busy||!customPath} onClick={()=>void onOpen(customPath)}>Open existing project at Location</button><fieldset><legend>Import portable project</legend><label>Archive file path<input value={archivePath} onChange={event=>setArchivePath(event.currentTarget.value)}/></label><p className="hint">Use Location above for a new destination directory.</p><button disabled={busy||!archivePath||!customPath} onClick={()=>void importArchive()}>Import project archive</button>{archiveJob&&<p role="status">{archiveJob.status} · {archiveJob.message}</p>}{archiveJob&&!['completed','failed','cancelled'].includes(archiveJob.status)&&<button onClick={()=>void api("/api/jobs/cancel",{method:"POST",body:JSON.stringify({jobId:archiveJob.id})})}>Cancel archive import</button>}{archiveError&&<p role="alert">{archiveError}</p>}</fieldset></section>
    </div>
  </div></div>;
}

function MediaBin({ project, projectPath, artifactVersion, onProject, onImportError, onAdd }: { project: StudioProject | undefined; projectPath: string; artifactVersion: number; onProject(project: StudioProject): void; onImportError(error: string): void; onAdd(media: MediaAsset,trackId?:string): void }) {
  const [filePath, setFilePath] = useState("");
  const [targetTrack,setTargetTrack]=useState("");
  const tracks=project?.sequences.find(s=>s.id===project.activeSequenceId)?.tracks??project?.sequences[0]?.tracks??[];
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
    <div className="import-box"><input aria-label="Absolute media file path" value={filePath} onChange={(event) => setFilePath(event.target.value)} placeholder="Absolute media file path" /><label className="check"><input type="checkbox" checked={linked} onChange={(event) => setLinked(event.target.checked)} /> Link source</label><button className="primary" onClick={() => void importFile()} disabled={!project || !filePath || busy}>{busy ? "Importing…" : "Import media"}</button></div>
    <label className="media-target">Target media track<select aria-label="Target media track" value={targetTrack} onChange={e=>setTargetTrack(e.target.value)}><option value="">First compatible track</option>{tracks.filter(t=>t.type!=="caption").map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><p className="hint">Double-click, press Enter, or drag an asset onto a timeline track.</p>
    <div className="asset-list">{project?.media.map((media) => <button key={media.id} className="asset" draggable onDragStart={event=>event.dataTransfer.setData("application/x-studio-media",media.id)} onKeyDown={event=>{if((event.key==="Enter"||event.key===" ")&&["audio","video","image"].includes(media.kind)){event.preventDefault();onAdd(media,targetTrack||undefined);}}} title={media.kind==="font"?"Choose this font in caption styles":media.name} onDoubleClick={() => {if(["audio","video","image"].includes(media.kind))onAdd(media,targetTrack||undefined);}}><span className={`asset-type ${media.kind}`}><img alt="" src={mediaArtifactUrl(projectPath, media.id, media.probe.hasVideo ? "thumbnail" : "waveform", artifactVersion)} loading="lazy" onLoad={(event) => { event.currentTarget.hidden = false; }} onError={(event) => { event.currentTarget.hidden = true; }} /><i>{media.kind === "audio" ? "♫" : media.kind === "image" ? "▧" : "▶"}</i></span><span><strong>{media.name}</strong><small>{media.kind} · {secondsLabel(media.probe.durationTick)}</small></span></button>)}</div>
  </aside>;
}

function Preview({ artifactVersion, project, projectPath, sequence, selectedClip, selectedMedia, playhead, ready, busy, onBuild, onPlayhead }: { artifactVersion:number; project: StudioProject | undefined; projectPath: string; sequence: Sequence | undefined; selectedClip: Clip | undefined; selectedMedia: MediaAsset | undefined; playhead: number; ready: boolean; busy: boolean; onBuild(): Promise<void>; onPlayhead(tick: number): void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [safeGuides,setSafeGuides]=useState(false);
  const [sourceView,setSourceView]=useState(false);
  const mediaUrl = selectedMedia ? mediaArtifactUrl(projectPath, selectedMedia.id, selectedMedia.retiming&&selectedMedia.probe.hasVideo ? "proxy" : "source", artifactVersion) : "";
  const previewUrl = !sourceView && ready && project && sequence ? `/preview?token=${encodeURIComponent(token)}&projectPath=${encodeURIComponent(projectPath)}&sequenceId=${encodeURIComponent(sequence.id)}&revision=${project.revision}` : "";
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
    {previewUrl ? <video ref={videoRef} key={previewUrl} src={previewUrl} preload="metadata" onLoadedMetadata={seekToPlayhead} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={(event) => project && onPlayhead(framesToTicks(Math.round(event.currentTarget.currentTime * project.settings.fps.numerator / project.settings.fps.denominator), project.settings.fps))} /> : selectedMedia?.kind === "image" ? <img src={mediaUrl} /> : selectedMedia ? <SourceFrame url={mediaUrl} clip={selectedClip} playhead={playhead}/> : selectedClip?.source.type === "color" ? <div className="color-preview" style={{ background: selectedClip.source.color }} /> : selectedClip?.source.type === "animation" ? <div className="animation-preview"><span>◇</span><strong>{selectedClip.name}</strong><small>Deterministic animation clip</small></div> : <div className="empty-monitor"><span>▶</span><strong>{project ? "Build a program preview" : "Open or create a project"}</strong></div>}
    {safeGuides&&<div className="caption-safe-guide" aria-hidden="true"/>}
    {project && !previewUrl && !sourceView && <div className="preview-callout"><span>{busy ? "Rendering the current revision…" : "Source fallback · program preview is stale"}</span><button className="primary" disabled={busy || !(sequence?.clips.length || sequence?.captions.length)} onClick={() => void onBuild()}>{busy ? "Building…" : "Build preview"}</button></div>}
  </div><div className="transport"><button disabled={!selectedMedia} aria-pressed={sourceView} onClick={()=>setSourceView(value=>!value)}>Compare source / program</button><button aria-label="Safe areas" aria-pressed={safeGuides} onClick={()=>setSafeGuides(value=>!value)}>Safe areas</button><button aria-label="Previous frame" title="Previous frame" disabled={!project} onClick={() => step(-1)}>◀</button><button aria-label="Play or pause" title="Play or pause" disabled={!project || busy} onClick={() => void togglePlayback()}>{busy ? "…" : playing ? "Ⅱ" : "▶"}</button><button aria-label="Next frame" title="Next frame" disabled={!project} onClick={() => step(1)}>▶|</button><code>{project ? formatTimecode(playhead, project.settings.fps) : "00:00:00:00"}</code><span>{sequence?.name ?? "No sequence"}</span></div><ProgramAudioMeter media={videoRef} sourceKey={previewUrl}/>{project&&sequence&&<PlaybackControls project={project} sequence={sequence} playhead={playhead} onSeek={onPlayhead} video={videoRef} sourceKey={previewUrl}/>}</section>;
}

function Timeline({ onAddMedia, project, projectPath, artifactVersion, sequence, selectedClipIds, onSelectClips, selectedClipId, selectedCaptionId, playhead, zoom, onZoom, onPlayhead, onSelect, onSelectCaption, onMove, onMutate }: { onAddMedia(media:MediaAsset,trackId?:string,tick?:number):Promise<void>; project: StudioProject | undefined; projectPath: string; artifactVersion: number; sequence: Sequence | undefined; selectedClipIds: string[]; onSelectClips(ids:string[]):void; selectedClipId: string | undefined; selectedCaptionId: string | undefined; playhead: number; zoom: number; onZoom(value: number): void; onPlayhead(value: number): void; onSelect(id: string): void; onSelectCaption(id: string): void; onMove(id: string, track: Track, tick: number): Promise<void>; onMutate(commands: ProjectCommand[]): Promise<void> }) {
  const [dragId, setDragId] = useState<string>();
  const [snapping, setSnapping] = useState(true);
  const [trimEdit, setTrimEdit] = useState<{ clipId: string; edge: "in" | "out"; originalTick: number; currentTick: number }>();
  const scrollRef=useRef<HTMLDivElement>(null);
  const trimCleanup=useRef<(()=>void)|undefined>(undefined);useEffect(()=>()=>trimCleanup.current?.(),[]);
  const [viewport,setViewport]=useState({left:0,width:1200});
  const [trackHeight,setTrackHeight]=useState(84);
  useEffect(()=>{const element=scrollRef.current;if(!element)return;const position=ticksToSeconds(playhead)*zoom;if(position<element.scrollLeft||position>element.scrollLeft+element.clientWidth-180)element.scrollLeft=Math.max(0,position-180);},[playhead,zoom]);
  const [ripple,setRipple]=useState(false);
  const selected=new Set(selectedClipIds.length?selectedClipIds:selectedClipId?[selectedClipId]:[]);
  const marquee=useTimelineMarquee(sequence,[...selected],zoom,onSelectClips,tick=>onPlayhead(project?framesToTicks(ticksToFrames(tick,project.settings.fps,"round"),project.settings.fps):tick));
  const select=(id:string,additive=false)=>onSelectClips(additive?(selected.has(id)?[...selected].filter(item=>item!==id):[...selected,id]):[id]);
  useEffect(()=>{const element=scrollRef.current;if(!element)return;const resize=new ResizeObserver(()=>setViewport({left:element.scrollLeft,width:element.clientWidth}));resize.observe(element);return()=>resize.disconnect();},[]);
  const durationSeconds=sequence?[...sequence.clips,...sequence.captions].reduce((max,item)=>Math.max(max,ticksToSeconds(item.startTick+item.durationTick)+5),60):60;
  const visibleStart=Math.max(0,(viewport.left-500)/zoom),visibleEnd=(viewport.left+viewport.width+500)/zoom;
  const visible=(start:number,duration:number)=>ticksToSeconds(start+duration)>=visibleStart&&ticksToSeconds(start)<=visibleEnd;
  const moveSelection=async(id:string,track:Track,tick:number)=>{
    if(!sequence)return;
    const ids=selected.has(id)?[...selected]:[id],clip=sequence.clips.find(item=>item.id===id);
    const first=Math.min(...sequence.clips.filter(item=>ids.includes(item.id)).map(item=>item.startTick));
    await onMutate([{type:"clip.move",sequenceId:sequence.id,clipIds:ids,targetTrackId:track.id,startTick:Math.max(0,first+tick-(clip?.startTick??first)),ripple}]);
  };
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
    event.preventDefault(); event.stopPropagation(); trimCleanup.current?.();select(clip.id);
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
    const cleanup=()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",finish);window.removeEventListener("pointercancel",cancel);trimCleanup.current=undefined;};
    const cancel=()=>{cleanup();setTrimEdit(undefined);};
    const finish = () => {
      cleanup();setTrimEdit(undefined);
      if (sequence && currentTick !== originalTick) void onMutate([{ type: "clip.trim", sequenceId: sequence.id, clipId: clip.id, edge, tick: currentTick, ripple }]);
    };
    trimCleanup.current=cleanup;window.addEventListener("pointercancel",cancel,{once:true});window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish, { once: true });
  };
  const keyboardTrim = (event: React.KeyboardEvent, clip: Clip, edge: "in" | "out") => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" || !sequence) return;
    event.preventDefault(); event.stopPropagation();
    const original = edge === "in" ? clip.startTick : clip.startTick + clip.durationTick;
    const raw = original + (event.key === "ArrowLeft" ? -frameTick : frameTick) * (event.shiftKey ? 10 : 1);
    const bounded = edge === "in" ? Math.max(0, Math.min(raw, clip.startTick + clip.durationTick - frameTick)) : Math.max(clip.startTick + frameTick, raw);
    void onMutate([{ type: "clip.trim", sequenceId: sequence.id, clipId: clip.id, edge, tick: bounded, ripple }]);
  };
  const addTrack = async (type: Track["type"]) => {
    if (!project || !sequence) return;
    const same = sequence.tracks.filter((track) => track.type === type);
    const id = crypto.randomUUID();
    const order = Math.max(-1, ...sequence.tracks.map((track) => track.order)) + 1;
    await onMutate([{ type: "track.add", sequenceId: sequence.id, track: { id, type, name: `${type[0]!.toUpperCase()}${type.slice(1)} ${same.length + 1}`, order, locked: false, muted: false, solo: false, hidden: false, gainDb: 0, pan: 0 } }]);
  };
  return <section className="timeline-section"><div className="timeline-toolbar"><div><strong>Timeline</strong><button onClick={() => void addTrack("video")}>+ Video</button><button onClick={() => void addTrack("audio")}>+ Audio</button><button onClick={() => void addTrack("overlay")}>+ Overlay</button><button className={snapping ? "active" : ""} aria-pressed={snapping} onClick={() => setSnapping((value) => !value)}>⌁ Snap</button></div><label><input type="checkbox" checked={ripple} onChange={event=>setRipple(event.target.checked)}/>Ripple</label><label>Track height<input type="range" min="84" max="160" value={trackHeight} onChange={event=>setTrackHeight(Number(event.target.value))}/></label><label>Zoom<input type="range" min="24" max="220" value={zoom} onChange={(event) => onZoom(Number(event.target.value))} /></label></div>
    <AudioMixer project={project} sequence={sequence} onMutate={onMutate}/><SelectionTools project={project} sequence={sequence} selectedIds={[...selected]} playhead={playhead} onSelect={onSelectClips} onMutate={onMutate} ripple={ripple}/>{project&&sequence&&<TimelineReviewControls project={project} sequence={sequence} selectedId={selectedClipId} onMutate={onMutate} onSeek={onPlayhead}/> }<div className="timeline-scroll" ref={scrollRef} onScroll={event=>setViewport({left:event.currentTarget.scrollLeft,width:event.currentTarget.clientWidth})}><div className="track-labels"><div className="ruler-spacer" />{sequence?.tracks.map((track) => <div className="track-label" style={{height:trackHeight}} key={track.id}><span className={`track-dot ${track.type}`} /><span><strong>{track.name}</strong><small>{track.type}</small></span><span className="track-controls">{(["muted","solo","locked","hidden"] as const).map(key=><button key={key} aria-label={key+" "+track.name} aria-pressed={track[key]} onClick={()=>void onMutate([{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{[key]:!track[key]}}])}>{key==="muted"?"M":key==="solo"?"S":key==="locked"?"L":"H"}</button>)}<button aria-label={"Move "+track.name+" up"} disabled={sequence.tracks.indexOf(track)===0} onClick={()=>{const previous=sequence.tracks[sequence.tracks.indexOf(track)-1];if(previous)void onMutate([{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{order:previous.order}},{type:"track.update",sequenceId:sequence.id,trackId:previous.id,patch:{order:track.order}}]);}}>↑</button><button aria-label={"Move "+track.name+" down"} disabled={sequence.tracks.indexOf(track)===sequence.tracks.length-1} onClick={()=>{const next=sequence.tracks[sequence.tracks.indexOf(track)+1];if(next)void onMutate([{type:"track.update",sequenceId:sequence.id,trackId:track.id,patch:{order:next.order}},{type:"track.update",sequenceId:sequence.id,trackId:next.id,patch:{order:track.order}}]);}}>↓</button></span></div>)}</div>
      <div className="lanes" style={{ width }} onPointerDown={marquee.begin}>{marquee.overlay}<div className="ruler" onMouseDown={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onPlayhead(secondsToTicks((event.clientX - rect.left) / zoom)); }}>{Array.from({ length: Math.ceil((visibleEnd-visibleStart)/5)+2 }, (_, offset) => {const index=Math.floor(visibleStart/5)+offset;return <span key={index} style={{ left: index * 5 * zoom }}>{index * 5}s</span>;})}</div>
        {sequence?.tracks.map((track) => <div key={track.id} data-track-id={track.id} className={`lane ${track.type}`} style={{height:trackHeight}} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const mediaId=event.dataTransfer.getData("application/x-studio-media"); const media=project?.media.find(item=>item.id===mediaId);if(media){const rect=event.currentTarget.getBoundingClientRect();void onAddMedia(media,track.id,snapTick(secondsToTicks((event.clientX-rect.left)/zoom)));return;} if (!dragId) return; const rect = event.currentTarget.getBoundingClientRect(); void moveSelection(dragId, track, snapTick(secondsToTicks((event.clientX - rect.left) / zoom), dragId)); setDragId(undefined); }} onMouseDown={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); onPlayhead(snapTick(secondsToTicks((event.clientX - rect.left) / zoom))); } }}>
          {sequence.clips.filter((clip) => clip.trackId === track.id && visible(clip.startTick,clip.durationTick)).map((clip) => {
            const mediaId = clip.source.type === "media" ? clip.source.mediaId : undefined;
            const media = mediaId ? project?.media.find((item) => item.id === mediaId) : undefined;
            const editing = trimEdit?.clipId === clip.id ? trimEdit : undefined;
            const displayStart = editing?.edge === "in" ? editing.currentTick : clip.startTick;
            const displayEnd = editing?.edge === "out" ? editing.currentTick : clip.startTick + clip.durationTick;
            return <div role="group" tabIndex={0} aria-label={clip.name + (selected.has(clip.id) ? ", selected" : "")} draggable key={clip.id} className={`timeline-clip ${selected.has(clip.id) ? "selected" : ""}`} style={{ left: ticksToSeconds(displayStart) * zoom, width: Math.max(16, ticksToSeconds(displayEnd - displayStart) * zoom), "--clip-color": clipColor(clip, media) } as React.CSSProperties} onClick={(event) => { event.stopPropagation(); select(clip.id,event.ctrlKey||event.metaKey||event.shiftKey); }} onKeyDown={(event) => { if(event.currentTarget !== event.target)return;if(event.key === "Enter" || event.key === " "){event.preventDefault();select(clip.id,event.ctrlKey||event.metaKey||event.shiftKey);return;} if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const next = Math.max(0, clip.startTick + (event.key === "ArrowLeft" ? -frameTick : frameTick) * (event.shiftKey ? 10 : 1)); void moveSelection(clip.id, track, next); }} onDragStart={() => setDragId(clip.id)} title={`${clip.name}\n${secondsLabel(clip.startTick)} — ${secondsLabel(clip.startTick + clip.durationTick)}`}><span className="trim-handle trim-in" role="slider" tabIndex={0} aria-label={`Trim start of ${clip.name}`} aria-valuenow={ticksToSeconds(clip.startTick)} onPointerDown={(event) => beginTrim(event, clip, "in")} onKeyDown={(event) => keyboardTrim(event, clip, "in")} />{media?<TimelineTileStrip clip={clip} media={media} projectPath={projectPath} token={token} zoom={zoom} visibleStart={visibleStart} visibleEnd={visibleEnd}/>:<span className="clip-art">{clip.source.type==="animation"?"◇":"▶"}</span>}<strong>{clip.name}</strong><small>{secondsLabel(displayEnd - displayStart)}</small><span className="trim-handle trim-out" role="slider" tabIndex={0} aria-label={`Trim end of ${clip.name}`} aria-valuenow={ticksToSeconds(clip.startTick + clip.durationTick)} onPointerDown={(event) => beginTrim(event, clip, "out")} onKeyDown={(event) => keyboardTrim(event, clip, "out")} /></div>;
          })}
          {sequence.transitions.filter(t=>sequence.clips.some(c=>c.id===t.fromClipId&&c.trackId===track.id)).map(t=>{const from=sequence.clips.find(c=>c.id===t.fromClipId)!;const tick=from.startTick+from.durationTick;if(!visible(tick-t.durationTick/2,t.durationTick))return null;return <button className="transition-block" key={t.id} aria-label={"Edit transition from "+from.name} style={{left:ticksToSeconds(tick-t.durationTick/2)*zoom,width:Math.max(14,ticksToSeconds(t.durationTick)*zoom)}} onClick={e=>{e.stopPropagation();onSelect(from.id);const details=e.currentTarget.closest(".timeline-section")?.querySelector<HTMLDetailsElement>(".editing-review");if(details)details.open=true;}}>⋈</button>;})}
          {sequence.captions.filter((caption) => caption.trackId === track.id && visible(caption.startTick,caption.durationTick)).map((caption) => <div role="button" tabIndex={0} key={caption.id} aria-pressed={selectedCaptionId === caption.id} className={`caption-block ${selectedCaptionId === caption.id ? "selected" : ""}`} style={{ left: ticksToSeconds(caption.startTick) * zoom, width: Math.max(24, ticksToSeconds(caption.durationTick) * zoom) }} title={`${caption.text}\n${secondsLabel(caption.startTick)} — ${secondsLabel(caption.startTick + caption.durationTick)}`} onClick={(event) => { event.stopPropagation(); onSelectCaption(caption.id); }} onKeyDown={(event) => { if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelectCaption(caption.id);return;} if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const startTick = Math.max(0, caption.startTick + (event.key === "ArrowLeft" ? -frameTick : frameTick) * (event.shiftKey ? 10 : 1)); void onMutate([{ type: "caption.update", sequenceId: sequence.id, captionId: caption.id, patch: { startTick } }]); }}><span>CC</span><strong>{caption.text}</strong></div>)}
        </div>)}
        {sequence?.markers.filter(marker=>visible(marker.tick,marker.durationTick)).map(marker=><button className="timeline-marker" key={marker.id} style={{left:ticksToSeconds(marker.tick)*zoom}} aria-label={"Go to marker "+marker.label} title={marker.label} onClick={()=>onPlayhead(marker.tick)}>◆</button>)}<div className="playhead" style={{ left: ticksToSeconds(playhead) * zoom }}><span /></div>
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
  const [autoActivate,setAutoActivate]=useState(false);
  useEffect(() => { void api<{ providers: typeof providers }>("/api/providers").then((result) => setProviders(result.providers)); }, []);
  useEffect(() => { setName(kind === "narration" ? "Narration" : kind === "music" ? "Music bed" : kind === "captions" ? "Captions" : "Generated animation"); }, [kind]);
  const generate = async () => {
    const track = sequence.tracks.find((item) => kind === "captions" ? item.type === "caption" : kind === "animation" ? item.type === "overlay" || item.type === "video" : item.type === "audio");
    if (!track) { onError(`Add a ${kind === "animation" ? "video or overlay" : kind === "captions" ? "caption" : "audio"} track first.`); return; }
    const durationTick = kind === "narration" || kind === "music" ? secondsToTicks(Math.max(0.1, duration)) : framesToTicks(Math.max(1, ticksToFrames(secondsToTicks(Math.max(0.1, duration)), project.settings.fps, "round")), project.settings.fps);
    const body = { autoActivate, projectPath, expectedRevision: project.revision, kind, sequenceId: sequence.id, trackId: track.id, startTick: playhead, durationTick, name, prompt, text: prompt, provider, voiceId, sourceMediaId };
    setBusy(true);
    try {
      const result = await api<{ project: StudioProject }>("/api/generate", { method: "POST", body: JSON.stringify(body) });
      onProject(result.project);
    } catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop generation-backdrop"><div className="generation-modal" role="dialog" aria-modal="true" aria-labelledby="generation-dialog-title">
    <div className="modal-head"><div><p className="eyebrow">GENERATED CONTENT</p><h1 id="generation-dialog-title">Review, revise, and regenerate</h1><p className="generation-subtitle">Every request becomes a persistent version. Activating a new version preserves timeline timing, effects, and mix edits.</p></div><button className="close" aria-label="Close dialog" onClick={onClose}>×</button></div>
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
        <label><input type="checkbox" checked={autoActivate} onChange={event=>setAutoActivate(event.currentTarget.checked)}/>Automatically activate when ready</label><p>Generated audio is padded or trimmed to this slot. Drafts wait for review unless selected.</p>
        <button className="primary large" disabled={busy || !name.trim() || (kind !== "captions" && !prompt.trim()) || (kind === "captions" && !sourceMediaId)} onClick={() => void generate()}>{busy ? "Queueing…" : "Generate draft"}</button>
      </section>
      <section className="generation-library"><div className="generation-heading"><h3>Project artifacts</h3><span>{project.generatedArtifacts.length}</span></div>{project.generatedArtifacts.length ? project.generatedArtifacts.map((artifact) => <GenerationReview key={artifact.id} artifact={artifact} project={project} projectPath={projectPath} request={api} mediaUrl={id=>mediaArtifactUrl(projectPath,id,"source")} onProject={onProject} onError={onError} />) : <div className="empty-panel"><span>✦</span><p>No generated artifacts yet. Imported recordings remain supported as normal media.</p></div>}</section>
    </div>
  </div></div>;
}

function Inspector({ onProjectChange, project, sequence, clip, jobs, projectPath, onUpdate, onMutate, onError,onNavigate }: { onProjectChange(project:StudioProject):void; project: StudioProject | undefined; sequence: Sequence | undefined; clip: Clip | undefined; jobs: JobRecord[]; projectPath: string; onNavigate(tick:number,clipIds:string[],captionIds?:string[]):void; onUpdate(command: ProjectCommand & { type: "clip.update" }): void; onMutate(commands: ProjectCommand[]): Promise<void>; onError(error: string): void }) {
  const [tab, setTab] = useState<"clip" | "export" | "jobs">("clip");
  const [outputPath, setOutputPath] = useState("");
  const [exportSelection,setExportSelection]=useState<ExportSelection>({});
  const exportPresets=project?availableExportPresets(project):[];
  const [presetId,setPresetId]=useState(project?.exportPresets[0]?.id??"web-h264-1080p");
  useEffect(() => { if (projectPath) setOutputPath(`${projectPath.replace(/\\/g,"/")}/exports/export.mp4`); }, [projectPath]);
  const patch = (value: Partial<Clip>) => { if (project && sequence && clip) onUpdate({ type: "clip.update", sequenceId: sequence.id, clipId: clip.id, patch: value }); };
  const addEffect = (kind: "blur" | "brightness" | "equalizer") => {
    if (!clip) return;
    const effect: EffectInstance = { id: crypto.randomUUID(), type: kind, enabled: true, version: 1, parameters: kind === "blur" ? { radius: 8 } : kind === "brightness" ? { value: 0.1 } : { bands: [{ frequency: 100, q: 1, gainDb: 0 }, { frequency: 1000, q: 1, gainDb: 0 }, { frequency: 8000, q: 1, gainDb: 0 }] } };
    if (kind === "equalizer") patch({ audio: { ...clip.audio, effects: [...clip.audio.effects, effect] } });
    else patch({ effects: [...clip.effects, effect] });
  };
  const render = async () => {
    if (!project || !sequence || !outputPath) return;
    try { await api("/api/render", { method: "POST", body: JSON.stringify({ projectPath, sequenceId: sequence.id, presetId, outputPath,expectedRevision:project.revision,...exportSelection }) }); setTab("jobs"); }
    catch (caught) { onError(caught instanceof Error ? caught.message : String(caught)); }
  };
  return <aside className="panel inspector"><div className="tabs"><button className={tab === "clip" ? "active" : ""} onClick={() => setTab("clip")}>Inspector</button><button className={tab === "export" ? "active" : ""} onClick={() => setTab("export")}>Export</button><button className={tab === "jobs" ? "active" : ""} onClick={() => setTab("jobs")}>Jobs</button></div>
    {tab === "clip" && (clip ? <div className="inspector-body"><h3>{clip.name}</h3><small>{clip.source.type} clip · {secondsLabel(clip.durationTick)}</small><fieldset><legend>Timing</legend><label>Start (seconds)<input key={`${clip.id}-start-${clip.startTick}`} type="number" min="0" step="0.033" defaultValue={ticksToSeconds(clip.startTick)} onBlur={(event) => { if (!sequence || !project || !Number.isFinite(event.currentTarget.valueAsNumber)) return; const tick = framesToTicks(ticksToFrames(secondsToTicks(Math.max(0, event.currentTarget.valueAsNumber)), project.settings.fps, "round"), project.settings.fps); if(tick===clip.startTick)return; void onMutate([{ type: "clip.move", sequenceId: sequence.id, clipIds: [clip.id], targetTrackId: clip.trackId, startTick: tick, ripple: false }]); }} /></label><label>Duration (seconds)<input key={`${clip.id}-duration-${clip.durationTick}`} type="number" min={ticksToSeconds(framesToTicks(1, project!.settings.fps))} step="0.033" defaultValue={ticksToSeconds(clip.durationTick)} onBlur={(event) => { if (!sequence || !project || !Number.isFinite(event.currentTarget.valueAsNumber)) return; const duration = framesToTicks(Math.max(1, ticksToFrames(secondsToTicks(event.currentTarget.valueAsNumber), project.settings.fps, "round")), project.settings.fps); if(duration===clip.durationTick)return; void onMutate([{ type: "clip.trim", sequenceId: sequence.id, clipId: clip.id, edge: "out", tick: clip.startTick + duration, ripple: false }]); }} /></label></fieldset>{project && sequence && <EditTools key={"editing-"+clip.id} project={project} sequence={sequence} clip={clip} onMutate={onMutate}/>}<fieldset><legend>Transform</legend><div className="field-pair"><label>X<input type="number" step="0.01" defaultValue={clip.transform.position[0]} onBlur={(event) => patch({ transform: { ...clip.transform, position: [Number(event.target.value), clip.transform.position[1]] } })} /></label><label>Y<input type="number" step="0.01" defaultValue={clip.transform.position[1]} onBlur={(event) => patch({ transform: { ...clip.transform, position: [clip.transform.position[0], Number(event.target.value)] } })} /></label></div><label>Opacity<input type="range" min="0" max="1" step="0.01" value={clip.transform.opacity} onChange={(event) => patch({ transform: { ...clip.transform, opacity: Number(event.target.value) } })} /></label><label>Rotation<input type="number" value={clip.transform.rotation} onChange={(event) => patch({ transform: { ...clip.transform, rotation: Number(event.target.value) } })} /></label></fieldset><fieldset><legend>Audio</legend><label>Gain <output>{clip.audio.gainDb} dB</output><input type="range" min="-60" max="12" step="0.5" value={clip.audio.gainDb} onChange={(event) => patch({ audio: { ...clip.audio, gainDb: Number(event.target.value) } })} /></label><label className="check"><input type="checkbox" checked={clip.audio.muted} onChange={(event) => patch({ audio: { ...clip.audio, muted: event.target.checked } })} /> Muted</label></fieldset>{project&&sequence&&<><ClipFinishing key={"finishing-"+clip.id} project={project} sequence={sequence} clip={clip} onMutate={onMutate}/><RetimeTools key={"retime-"+clip.id} project={project} sequence={sequence} clip={clip} projectPath={projectPath} request={api} onError={onError} onChanged={onProjectChange}/></>}{project&&sequence&&<ClipAudioTools project={project} clip={clip} sequence={sequence} onMutate={onMutate}/>}</div> : <div className="empty-panel"><span>◇</span><p>Select a clip to edit timing, transform, audio, and effects.</p></div>)}
    {tab === "export" && <div className="inspector-body"><h3>Export sequence</h3><label>Preset<select aria-label="Export preset" value={presetId} onChange={event=>{const id=event.currentTarget.value;setPresetId(id);const preset=exportPresets.find(p=>p.id===id);if(preset)setOutputPath(current=>current.replace(/\.[^/.]+$/, "."+preset.container));}}>{exportPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</select></label>{project&&sequence&&exportPresets.find(p=>p.id===presetId)&&<ExportOptions project={project} sequence={sequence} preset={exportPresets.find(p=>p.id===presetId)!} request={api} onChange={setExportSelection} onError={onError}/>}<label>Output path<textarea aria-label="Export output path" rows={3} value={outputPath} onChange={(event) => setOutputPath(event.target.value)} /></label><button className="primary large" onClick={() => void render()} disabled={!project || !sequence}>Queue render</button><p className="hint">The export uses the same processing as the program preview and verifies the completed file.</p>{project&&<ExportHistory projectPath={projectPath} request={api} onError={onError}/>}</div>}
    {tab === "jobs" && <div className="job-list">{project&&sequence&&<QualityControl project={project} sequence={sequence} jobs={jobs} projectPath={projectPath} request={(route,input)=>api(route,{method:"POST",body:JSON.stringify(input)})} onMutate={onMutate} onNavigate={onNavigate} onError={onError}/>} {jobs.length ? jobs.map((job) => <div className={`job ${job.status}`} key={job.id}><div><strong>{job.type}</strong><span>{job.status}</span></div><p>{job.message}</p><div className="progress"><span style={{ width: `${job.progress * 100}%` }} /></div>{job.error && <small>{job.error.message}</small>}</div>) : <div className="empty-panel"><p>No background jobs yet.</p></div>}</div>}
  </aside>;
}

function CaptionInspector({ project, projectPath, sequence, caption, onMutate }: { projectPath:string; project: StudioProject; sequence: Sequence; caption: CaptionCue; onMutate(commands: ProjectCommand[]): Promise<void> }) {
  const update = (patch: Extract<ProjectCommand, { type: "caption.update" }>["patch"]) => void onMutate([{ type: "caption.update", sequenceId: sequence.id, captionId: caption.id, patch }]);
  const alignedTick = (seconds: number) => framesToTicks(ticksToFrames(secondsToTicks(Math.max(0, seconds)), project.settings.fps, "round"), project.settings.fps);
  return <aside className="panel inspector"><div className="tabs"><button className="active">Caption</button></div><div className="inspector-body caption-inspector">
    <h3>Caption</h3><small>{secondsLabel(caption.durationTick)} · {caption.style.position}</small>
    <fieldset><legend>Text</legend><label>Caption text<textarea aria-label="Caption text" key={`${caption.id}-text-${caption.text}`} rows={4} defaultValue={caption.text} onBlur={(event) => event.currentTarget.value.trim() && event.currentTarget.value.trim()!==caption.text && update({ text: event.currentTarget.value.trim() })} /></label></fieldset>
    <fieldset><legend>Timing</legend><label>Start (seconds)<input key={`${caption.id}-start-${caption.startTick}`} type="number" min="0" step="0.033" defaultValue={ticksToSeconds(caption.startTick)} onBlur={(event) => Number.isFinite(event.currentTarget.valueAsNumber) && alignedTick(event.currentTarget.valueAsNumber)!==caption.startTick && update({ startTick: alignedTick(event.currentTarget.valueAsNumber) })} /></label><label>Duration (seconds)<input key={`${caption.id}-duration-${caption.durationTick}`} type="number" min={ticksToSeconds(framesToTicks(1, project.settings.fps))} step="0.033" defaultValue={ticksToSeconds(caption.durationTick)} onBlur={(event) => Number.isFinite(event.currentTarget.valueAsNumber) && Math.max(framesToTicks(1, project.settings.fps), alignedTick(event.currentTarget.valueAsNumber))!==caption.durationTick && update({ durationTick: Math.max(framesToTicks(1, project.settings.fps), alignedTick(event.currentTarget.valueAsNumber)) })} /></label></fieldset>
    <CaptionStyleControls project={project} style={caption.style} onChange={style=>update({style})}/>
    <CaptionLayoutFeedback projectPath={projectPath} sequenceId={sequence.id} captionId={caption.id} revision={project.revision} request={(route,input)=>api(route,{method:"POST",body:JSON.stringify(input)})}/>
    <fieldset><legend>Style</legend><label>Position<select value={caption.style.position} onChange={(event) => update({ style: { ...caption.style, position: event.currentTarget.value as CaptionCue["style"]["position"] } })}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></label><label>Alignment<select value={caption.style.align} onChange={(event) => update({ style: { ...caption.style, align: event.currentTarget.value as CaptionCue["style"]["align"] } })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label><label>Font size<input type="number" min="8" max="500" value={caption.style.fontSize} onChange={(event) => update({ style: { ...caption.style, fontSize: Number(event.currentTarget.value) } })} /></label><div className="field-pair"><label>Text color<input type="color" value={caption.style.color.slice(0, 7)} onChange={(event) => update({ style: { ...caption.style, color: event.currentTarget.value } })} /></label><label>Background<input type="color" value={caption.style.background.slice(0, 7)} onChange={(event) => update({ style: { ...caption.style, background: `${event.currentTarget.value}aa` } })} /></label></div></fieldset>
  </div></aside>;
}

function Login() { const [value, setValue] = useState(""); return <main className="panel"><h1>Video Studio</h1><p>Open the link returned by open_studio, or enter the editor access token.</p><form onSubmit={event => { event.preventDefault(); sessionStorage.setItem("mcp-video-studio:access", value); location.reload(); }}><label>Editor access token<input type="password" autoComplete="off" required minLength={32} value={value} onChange={event => setValue(event.currentTarget.value)} /></label><button>Open editor</button></form></main>; }
createRoot(document.getElementById("root")!).render(<React.StrictMode>{token ? <App /> : <Login />}</React.StrictMode>);

function EditTools({project,sequence,clip,onMutate}:{project:StudioProject;sequence:Sequence;clip:Clip;onMutate(commands:ProjectCommand[]):Promise<void>}) {
  const [frames,setFrames]=useState(1),[from,setFrom]=useState(ticksToSeconds(clip.startTick)),[to,setTo]=useState(ticksToSeconds(clip.startTick+clip.durationTick)),[gain,setGain]=useState(-12);
  const animation=project.animations.find(a=>clip.source.type==="animation"&&a.id===clip.source.animationId);
  const delta=framesToTicks(frames,project.settings.fps),sampleTick=TICKS_PER_SECOND/project.settings.sampleRate,align=(s:number)=>Math.round(secondsToTicks(s)/sampleTick)*sampleTick;
  return <>
    <fieldset><legend>Timeline operations</legend><label>Frames to adjust<input type="number" step="1" value={frames} onChange={e=>setFrames(e.currentTarget.valueAsNumber)} /></label>
      <div className="effect-buttons"><button onClick={()=>void onMutate([{type:"clip.slip",sequenceId:sequence.id,clipId:clip.id,deltaTick:delta}])}>Slip source</button><button onClick={()=>void onMutate([{type:"clip.slide",sequenceId:sequence.id,clipId:clip.id,deltaTick:delta}])}>Slide clip</button><button onClick={()=>void onMutate([{type:"clip.roll",sequenceId:sequence.id,clipId:clip.id,tick:clip.startTick+clip.durationTick+delta}])}>Roll outgoing cut</button></div>
      <p className="hint">Roll and slide preserve linked or grouped cuts when every partner has matching adjacent source handles.</p>
    </fieldset>
    <fieldset><legend>Gain automation / ducking</legend><label>Range start (seconds)<input type="number" step="0.01" min="0" value={from} onChange={e=>setFrom(e.currentTarget.valueAsNumber)} /></label><label>Range end (seconds)<input type="number" step="0.01" min="0" value={to} onChange={e=>setTo(e.currentTarget.valueAsNumber)} /></label><label>Gain offset (dB)<input type="number" min="-120" max="24" value={gain} onChange={e=>setGain(e.currentTarget.valueAsNumber)} /></label>
      <button onClick={()=>void onMutate([{type:"audio.gain.range",sequenceId:sequence.id,targetType:"clip",targetId:clip.id,startTick:align(from),endTick:align(to),gainDb:gain,laneId:"gain-"+clip.id}])}>Set gain range</button>
    </fieldset>
    {animation?.mode==="declarative"&&<AnimationEditor animation={animation} fps={project.settings.fps} onMutate={onMutate}/>}
  </>;
}

function WorkflowTools({project,sequence,projectPath,selectedClip,playhead,onProject,onMutate,onClose,onError}:{project:StudioProject;sequence:Sequence;projectPath:string;selectedClip:Clip|undefined;playhead:number;onProject(project:StudioProject):void;onMutate(commands:ProjectCommand[]):Promise<void>;onClose():void;onError(message:string):void}) {
  const [text,setText]=useState("Your title"),[preset,setPreset]=useState("title"),[captions,setCaptions]=useState(""),[format,setFormat]=useState<"srt"|"vtt"|"ass">("srt"),[mediaId,setMediaId]=useState(""),[gapStart,setGapStart]=useState(0),[gapEnd,setGapEnd]=useState(1),[busy,setBusy]=useState(false);
  const feature=async(name:string,fields:Record<string,unknown>)=>{setBusy(true);try{const result=await api<{project?:StudioProject;text?:string}>("/api/features/"+name,{method:"POST",body:JSON.stringify({projectPath,expectedRevision:project.revision,sequenceId:sequence.id,...fields})});if(result.project)onProject(result.project);if(result.text){const url=URL.createObjectURL(new Blob([result.text],{type:"text/plain;charset=utf-8"}));const link=document.createElement("a");link.href=url;link.download="captions."+format;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}catch(e){onError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  return <div className="modal-backdrop"><section className="generation-modal" role="dialog" aria-modal="true" aria-label="Editing workflows"><div className="modal-head"><h1>Editing workflows</h1><button aria-label="Close editing workflows" onClick={onClose}>×</button></div><div className="generation-layout">
    <section><SequenceTools project={project} sequence={sequence} playhead={playhead} onMutate={onMutate}/><fieldset><legend>Animation templates</legend><label>Template<select value={preset} onChange={e=>setPreset(e.currentTarget.value)}>{["title","lower-third","callout","logo-reveal","bar-chart","diagram"].map(p=><option key={p}>{p}</option>)}</select></label><label>Template title<input value={text} onChange={e=>setText(e.currentTarget.value)}/></label><button disabled={busy} onClick={()=>void feature("create_animation_preset",{preset,text,startTick:framesToTicks(ticksToFrames(playhead,project.settings.fps,"round"),project.settings.fps),durationTick:secondsToTicks(4),trackId:sequence.tracks.find(t=>t.type==="overlay"||t.type==="video")?.id})}>Add template at playhead</button></fieldset>
    <fieldset><legend>Close a global gap</legend><label>Gap start (seconds)<input type="number" min="0" value={gapStart} onChange={e=>setGapStart(e.currentTarget.valueAsNumber)}/></label><label>Gap end (seconds)<input type="number" min="0" value={gapEnd} onChange={e=>setGapEnd(e.currentTarget.valueAsNumber)}/></label><button onClick={()=>void onMutate([{type:"gap.remove",sequenceId:sequence.id,startTick:framesToTicks(ticksToFrames(secondsToTicks(gapStart),project.settings.fps,"round"),project.settings.fps),endTick:framesToTicks(ticksToFrames(secondsToTicks(gapEnd),project.settings.fps,"round"),project.settings.fps)}])}>Remove empty range</button></fieldset>
    <fieldset><legend>Adopt imported audio as a reviewed version</legend><p>{selectedClip?"Selected clip: "+selectedClip.name:"Select a clip in the timeline first."}</p><label>Imported audio<select value={mediaId} onChange={e=>setMediaId(e.currentTarget.value)}><option value="">Choose media</option>{project.media.filter(m=>m.probe.hasAudio).map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></label><button disabled={!selectedClip||!mediaId||busy} onClick={()=>void feature("adopt_generated_media",{clipId:selectedClip?.id,mediaId,kind:"narration",name:selectedClip?.name??"Imported draft",...(project.generatedArtifacts.find(a=>a.scope.clipId===selectedClip?.id&&a.kind==="narration")?{artifactId:project.generatedArtifacts.find(a=>a.scope.clipId===selectedClip?.id&&a.kind==="narration")!.id}:{})})}>Add draft for review</button><p className="hint">The active clip stays unchanged until you activate or approve this draft in Generate.</p></fieldset></section>
    <section><ProjectFiles project={project} projectPath={projectPath} request={api} onProject={onProject} onError={onError}/><fieldset><legend>Caption interchange</legend><label>Caption format<select value={format} onChange={e=>setFormat(e.currentTarget.value as "srt"|"vtt"|"ass")}><option value="srt">SRT</option><option value="vtt">WebVTT</option><option value="ass">ASS</option></select></label><label>Caption file<input type="file" accept=".srt,.vtt,.ass,text/vtt" onChange={e=>{const file=e.currentTarget.files?.[0];if(file){if(file.size>1_000_000){onError("Caption file exceeds one MB.");return;}setFormat(file.name.toLowerCase().endsWith(".ass")?"ass":file.name.toLowerCase().endsWith(".vtt")?"vtt":"srt");void file.text().then(setCaptions);}}}/></label><label>Caption source<textarea rows={12} value={captions} onChange={e=>setCaptions(e.currentTarget.value)}/></label><button disabled={!captions||busy} onClick={()=>void feature("import_captions",{format,text:captions,trackId:sequence.tracks.find(t=>t.type==="caption")?.id})}>Import captions</button><button disabled={busy} onClick={()=>void feature("export_captions",{format})}>Download caption sidecar</button></fieldset></section>
  </div></section></div>;
}
