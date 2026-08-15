# MCP Video Studio roadmap

- Status date: 2026-08-15
- Current release: [`0.1.1`](https://www.npmjs.com/package/mcp-video-studio)
- Canonical repository: [`flujo-app/mcp-video-studio`](https://github.com/flujo-app/mcp-video-studio)

This roadmap records implementation state between the architectural targets in [TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md) and the executable work in GitHub issues. The project is a working pre-v1 vertical slice, not yet a claim of full nonlinear-editor parity or production polish.

## Delivered in 0.1.x

- Standalone npm package, Windows/Ubuntu CI, stdio and Streamable HTTP MCP transports, tokenized Studio gateway, and MCP App display modes.
- Exact integer project timebase, versioned schemas, atomic project writes, optimistic revisions, transactions, durable undo/redo, generated-content migration, and persistent background jobs.
- Managed/linked media import, relink/consolidate/status operations, SHA-256 deduplication, normalized ffprobe metadata, thumbnails, proxies, waveforms, and authenticated byte-range delivery.
- Typed multi-track operations for tracks, clips, transitions, captions, markers, automation documents, grouping/linking, insert/overwrite/ripple placement, effects, and atomic transactions.
- Human Studio with project/media bin, program preview, snapping timeline, drag and keyboard clip movement/trim, split/delete, clip inspector, basic effects/audio controls, generation center, jobs, undo/redo, QC, and export.
- Direct FFmpeg render path with compositing, transitions, audio mixing, cache reuse, H.264/AAC and FFV1 output, atomic publication, cancellation, provenance, full-decode QC, and revision-keyed preview.
- Deterministic declarative animation evaluator plus sandboxed self-contained HTML frame capture into exact-frame lossless intermediates.
- Direct OpenAI-compatible and ElevenLabs adapters for narration, transcription/captions, music, and structured animation generation.
- Persistent generated artifacts with immutable parent-linked versions, provider/model/request provenance, draft/approve/reject review state, and activation that preserves clip timing, effects, gain, and automation references.
- Unit and integration coverage for exact time, stores/history, captions, generation migration/activation, filters, render/QC, preview/range serving, and deterministic Chromium animation capture.

## Phase progress

| Technical-plan phase | State in 0.1.1 | Delivered | Remaining gate |
| --- | --- | --- | --- |
| Phase 0 — foundation | Substantial | Package/workspaces, contracts, build, CI, doctor, direct process spawning, generated fixtures | Clean-pack/host matrices, deeper dependency/capability and failure checks; [#6](https://github.com/flujo-app/mcp-video-studio/issues/6) |
| Phase 1 — project/media | Substantial | Portable projects, revisions, atomic persistence, history, import/dedupe, relink/consolidate, probe, artifacts, gateway, durable jobs | Crash/out-of-disk/symlink fault coverage, stronger recovery and disk admission; [#6](https://github.com/flujo-app/mcp-video-studio/issues/6) |
| Phase 2 — editing core | Partial | Core typed track/clip/transition/caption/marker/automation commands, transactions, group/link metadata, insert/overwrite/ripple basics | Advanced edit algebra and complete Studio controls for multi-select, linked/grouped propagation, slip/slide/roll/ripple, gaps, track management; [#1](https://github.com/flujo-app/mcp-video-studio/issues/1) |
| Phase 3 — render slice | Substantial | Cached FFmpeg planning/execution, multi-track video/audio, transitions, previews, H.264/AAC, FFV1, atomic export, provenance and QC | More granular invalidation/range behavior, broader parity/failure fixtures and presets; [#5](https://github.com/flujo-app/mcp-video-studio/issues/5), [#6](https://github.com/flujo-app/mcp-video-studio/issues/6) |
| Phase 4 — human editor | Partial | Usable project/media/timeline/preview/inspector/jobs/generation/export shell with pointer and keyboard core edits | Full NLE interaction set, long-timeline virtualization, richer monitor controls, accessibility and conflict-reapply UX; [#1](https://github.com/flujo-app/mcp-video-studio/issues/1), [#6](https://github.com/flujo-app/mcp-video-studio/issues/6) |
| Phase 5 — production audio | Partial | Custom audio clips/tracks, waveform artifacts, gain, pan, fades, mute/solo render semantics, basic EQ/filter/dynamics, playback rate and loudness QC | Automation compilation/UI, ranged level edits, ducking, mixer/meters, complete effects, time-stretch/pitch and preview parity; [#2](https://github.com/flujo-app/mcp-video-studio/issues/2) |
| Phase 6 — animation | Partial | Deterministic scene schema/evaluator, easing/operations, HTML frame protocol, headless render/cache, ordinary timeline clips, generated version lifecycle | Full node/keyframe editor, fine-grained commands, expanded operations/templates, preview pixel parity and sandbox hardening; [#4](https://github.com/flujo-app/mcp-video-studio/issues/4) |
| Phase 7 — finishing surfaces | Partial | Initial video/audio effects, transitions, editable burned captions, basic QC and export | Rich titles/fonts/subtitles, broader effects, evidence-linked QC, formats/hardware presets, archive/import and export history; [#5](https://github.com/flujo-app/mcp-video-studio/issues/5) |
| Phase 8 — release hardening | Early | Windows/Ubuntu CI, release helper, secret redaction, cancellation, bounded logs/caches/jobs and initial real-runtime tests | Platform/security/fault/performance/accessibility audits and all acceptance productions; [#6](https://github.com/flujo-app/mcp-video-studio/issues/6) |
| Cross-cutting generation lifecycle | Functional foundation | Narration/music/caption/animation providers, durable jobs, version lineage, review state, activation/revert semantics and Studio review center | A/B/ranged review, partial regeneration, provider discovery/retry/cost UX, local adoption and transcript correction; [#3](https://github.com/flujo-app/mcp-video-studio/issues/3) |

## v1 workstreams

1. [Complete timeline editing modes and Studio interactions (#1)](https://github.com/flujo-app/mcp-video-studio/issues/1).
2. [Finish production audio, automation, and preview/render parity (#2)](https://github.com/flujo-app/mcp-video-studio/issues/2).
3. [Finish generated-content review and fine-grained regeneration (#3)](https://github.com/flujo-app/mcp-video-studio/issues/3).
4. [Build the full animation authoring surface and preset library (#4)](https://github.com/flujo-app/mcp-video-studio/issues/4).
5. [Complete titles, captions, effects, QC, export, and project archives (#5)](https://github.com/flujo-app/mcp-video-studio/issues/5).
6. [Pass the v1 hardening, accessibility, packaging, and benchmark gate (#6)](https://github.com/flujo-app/mcp-video-studio/issues/6).

Workstreams 1–5 can progress in parallel where their contracts are already stable. Workstream 6 is a continuous quality bar and the final v1 release gate, not a cleanup phase deferred until the end.

## v1 release rule

`1.0.0` requires the feature-completeness matrix, security/resource controls, and five acceptance productions in [TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md) to pass. A feature is counted as delivered only when it is available through the appropriate Studio and MCP surfaces, persists through the project lifecycle, renders correctly, and has verification proportional to its risk.

The original planning epic, [mario-andreschak/FLUJO#367](https://github.com/mario-andreschak/FLUJO/issues/367), is retained as historical context. Ongoing implementation belongs in this standalone repository.
