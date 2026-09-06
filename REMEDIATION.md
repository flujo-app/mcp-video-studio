# 2026 compatibility and acceptance work

This branch remains pre-v1. Issues #1–#6 stay open until their complete acceptance criteria pass. The current checkpoint repairs concrete protocol, security, persistence and rendering failures and adds working editor features. It does not claim completion of the six product epics.

## Protocol and access

The runtime uses TypeScript SDK 2.0.0 with actual modern 2026-07-28 and stateless legacy clients on stdio and HTTP. Node 22+ is required. Each HTTP request gets a fresh MCP server; the single Studio runtime owns project/job state. The latest published MCP Apps bridge, ext-apps 1.7.5, retains its SDK 1 peer dependency; server registration uses the SDK 2 public APIs and standard Apps resource metadata.

HTTP requires VIDEO_STUDIO_MCP_TOKEN (32–512 URL-safe characters) in Authorization: Bearer. Editor access uses a separate generated capability returned by open_studio. The editor keeps this capability in per-origin sessionStorage to survive reloads, removes it from the visible URL, and offers Lock editor. API mutations use bearer headers; GET media/EventSource URLs retain the editor capability. No provider credentials belong in browser storage.

Exact Host and Origin checks precede dispatch. Additional trusted authorities/origins are configured through VIDEO_STUDIO_ALLOWED_HOSTS and VIDEO_STUDIO_ALLOWED_ORIGINS. Null origins are rejected. TLS termination is required for remote deployment; keep default loopback binding otherwise.

## Verified changes

- Slip/roll/slide source handles, linked moves, cross-track gap removal, durable undo and stale-write rejection have boundary tests.
- Gain ranges are evaluated for every output sample after time stretch; audio placement uses sample delays. Actual PCM checks prove both range boundaries preserve surrounding audio.
- Preview and final render share the same renderer. WAV 24-bit and VP9/Opus exports are exercised against FFmpeg.
- Individual animation nodes and operations are editable through typed MCP commands. Six editable templates and property controls are available.
- HTML hooks execute as functions in their page realm. An opaque sandbox iframe blocks host DOM/storage, network, workers and popups. Seeded clock/random hooks, readiness, bounded cancellation and decoded-pixel repeatability are tested.
- History entries are prepared before the atomic project+undo-cursor commit. Fault injection verifies failed history/project writes do not advance revision or lose undo. Cross-process project locking coordinates local writers.
- Managed media paths reject traversal and symlinks. Linked media remains an explicit external-file feature. Media copy is streamed with disk admission.
- Provider redirects are denied, requests and response bodies are bounded, known keys are redacted from JSON, and error bodies are omitted. Only an explicit 429 receives one bounded retry; uncertain generation failures require an explicit retry.
- SRT/WebVTT import/export, local media adoption and version comparison/annotation APIs use ordinary revision-safe transactions.
- Portable archives stream media into a deterministic checksummed .mcpstudio container. Imports validate paths, manifests, sizes and every hash in a staging directory before publishing a new project.

## Archive format

Version 1 uses the 13-byte ASCII signature MCPSTUDIO001 followed by a newline, a 4-byte unsigned big-endian JSON manifest length, the UTF-8 manifest, and the ordered raw file contents listed in that manifest. Limits: 16 MiB manifest, 10000 files, 20 GiB media. Media is materialized as managed assets; caches and historical undo snapshots are omitted. Import creates a fresh undo history. Checksums detect corruption; this is not an authenticated signature or encryption.

Archive destination directories must not exist. File exports use temporary siblings and rename only after writing succeeds. A malicious local process that concurrently swaps filesystem paths is outside the single-user project-directory threat model; do not place projects in directories writable by untrusted users.

## Provider references checked

OpenAI's [file transcription guide](https://developers.openai.com/api/docs/guides/speech-to-text) still requires whisper-1 for word timestamps; the adapter rejects incompatible OpenAI caption model overrides. The [speech guide](https://developers.openai.com/api/docs/guides/text-to-speech) continues to document tts-1, and [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) supports the configured language path. [ElevenLabs music](https://elevenlabs.io/docs/api-reference/music/compose) documents prompt length/duration bounds and disallows seed with prompt mode. No paid generation or live provider-account acceptance has been performed.

## Remaining acceptance

The exact 24 acceptance criteria and their evidence are tracked in the remediation progress record. Further code work includes full timeline multi-selection/ripple controls, mixer/effect controls, partial generation regions and complete human version review, animation operation/keyframe editing, QC navigation, broader finishing formats, long-project virtualization/cache invalidation, fault coverage and all five acceptance productions. These are pending implementation/testing, not external blockers. Independent unfamiliar-user/screen-reader evaluation and account-backed generation require human/provider access. This branch must not be labeled v1.0.0 while those gates remain open.

## Editor and format continuation

The editor now supports multiple selection, copy/paste/duplicate, group/link edits,
track mute/solo/lock/visibility/reorder/height, and viewport-limited clip/ruler DOM.
Linked splits create a distinct right-hand relationship; their automation follows
subsequent moves. Ripple insertion splits spanning clips; deletion rejects any
unselected content in the removed interval and locked affected tracks reject
the complete transaction.

Project schema 2 makes the embedded undo cursor mandatory. Schema 1 projects
remain readable and upgrade on the first committed edit, with a recovery copy at
history/schema1-project.json. Older binaries reject schema 2 instead of silently
using obsolete history state. Use an archive backup before changing versions;
downgrading requires a separate export/conversion, not editing the version number.
Archive inspection reports the source and target schema versions.

## Audio and finishing continuation

Clip and track effect stacks can be added, parameter-edited, bypassed, reordered
and removed in Studio. Track gain/pan/effects are applied after clip mixing.
Supported processors include EQ, high/low-pass, compression, limiting, gate,
de-essing, delay, short multi-tap reverb and loudness normalization. Duplicate
clip/track normalization is rejected. Program preview and final export share
this processing graph.

Effect parameters are bounded and unknown effects are reported, never silently
discarded. Chroma-key colors cannot inject filter expressions. Crop, mirrored
scale and RGB blend modes use the clip's alpha coverage; real pixel tests verify
multiply/screen composition outside transformed bounds. Audio tests measure
actual post-mix limiting/bypass and run the supported processor chain in FFmpeg.
The full local gate now has50 passing tests including real browser/render tests.
Further transition, range-cache, generation, animation and full production
acceptance work remains underway; this is not a v1 release claim.

## Transition and QC continuation

Centered crossfades and directional wipes preserve the authored cut and total duration. Finite video/audio/animation sources require real handles; edits fail atomically when unavailable. Clip finishing controls expose crop, scale, blend, speed and transition duration. Rotation uses the configured angle and anchor, and WAV duration remains sample exact.

QC performs a complete decode, measures actual video frames and produces bounded black, freeze and silence ranges with affected clip IDs. Studio can navigate those findings, inspect measured values, and save intentional-range reasons. Reports show their revision and require reanalysis after edits. Concurrent revision failures require a successful reload before reapply; validation errors are not presented as conflicts.

Validation: 55 tests across 26 files passed with real FFmpeg and Chromium enabled, including a browser render/QC/navigation/review/reload/conflict flow, centered transition pixels and exact 48,100-sample WAV output. Packed modern/legacy stdio and browser acceptance also pass. Full epic acceptance work continues; this is not a v1 release.

## Incremental rendering and automation boundaries

Long timelines now cache frame-aligned FFV1 video ranges and an independently keyed continuous float WAV audio mix. Transition and caption pixel parity is byte exact against the whole renderer; audio keeps the exact sample count with at most one 24-bit PCM rounding step. Cache hits verify checksums before publication, media source hashes invalidate stale renders, and finished exports are checked in a sibling staging file before replacing an existing output.

The real 30-minute mixed-media acceptance passed: 901 video/image/color/audio clips with proxies, 54,000 frames, 180 ranges, 545 ms browser load and 51 ms far-end scroll on the remediation VM. Editing the final clip reused 179 ranges and the audio mix. Initial render took 147.8 seconds; the revised export took 63.3 seconds including full-duration encoding. CI now runs this acceptance separately on Linux Node 22. See RENDER_CACHE.md for cache behavior and parity limits.

A gain-range update now splices an existing automation lane instead of replacing its outside-range envelope. Sample-by-sample regression tests cover linear boundary preservation, target mismatch rejection and durable undo. This also repairs Studio's repeated Set gain range operation.

## HTML frame determinism

HTML animations must drive changes through renderFrame(state); wall-clock timers, requestAnimationFrame and idle callbacks reject with an explicit error. The supported clock and crypto random methods are deterministic for the supplied seed/frame. CSS animations are paused at the requested frame time and screenshots preserve that time. Leaving the original srcdoc closes the render page. Adversarial tests now explicitly cover navigation, downloads and service-worker registration in addition to network, filesystem, popups, workers and parent/storage isolation. Animation renderer versions participate in cache keys.

FFmpeg 7 reproduction fixed two real range-cache defects: output-level video frame limits prematurely terminated audio, and missing final packet durations shortened concat offsets. Final frame bounds now live inside the video graph; concat durations and frame-index timestamps are explicit. The strict regression verifies 120 decoded frames and 192,000 stereo samples with identical video pixels and at most one 24-bit rounding bit of audio difference. Local full gate: 64 tests pass, packed modern/legacy clients and browser pass, production npm audit is clear.

The declarative animation checkpoint adds a shared editor/export painter, typed SVG morph/property operations, group/camera transforms, kinetic text, deterministic particles, bounded offline image/video nodes, and full node/hierarchy/keyframe controls. Real browser and multiscene export tests pass. Video decode waits for a presented frame (requestVideoFrameCallback), fixing an intermittent blank frame exposed by the full gate. See ANIMATION.md for limits and acceptance evidence.
