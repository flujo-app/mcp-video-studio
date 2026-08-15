# MCP Video Studio

A standalone multi-track video editor for people and MCP clients. It combines a human timeline editor, typed MCP editing tools, direct FFmpeg rendering, persistent jobs and QC, and a deterministic Manim-like/HTML5 animation engine in one installable Node package.

This repository is intentionally standalone. It does not ship inside FLUJO and does not modify FLUJO source code.

## Project status

The current release is [`0.1.1`](https://www.npmjs.com/package/mcp-video-studio), a working pre-v1 vertical slice published from the canonical [`flujo-app/mcp-video-studio`](https://github.com/flujo-app/mcp-video-studio) repository. It delivers an end-to-end human/MCP edit, preview, generation, render, and QC path. It is not yet the polished, feature-complete v1 editor described by the acceptance matrix.

The project originated in [FLUJO issue #367](https://github.com/mario-andreschak/FLUJO/issues/367). That integration epic has been migrated here because the maintainer requested a standalone package rather than a server pre-shipped inside FLUJO.

Remaining v1 work is tracked in [ROADMAP.md](./ROADMAP.md):

- [#1 — timeline editing modes and Studio interactions](https://github.com/flujo-app/mcp-video-studio/issues/1)
- [#2 — production audio mixer, automation, and preview/render parity](https://github.com/flujo-app/mcp-video-studio/issues/2)
- [#3 — generated-content review and fine-grained regeneration](https://github.com/flujo-app/mcp-video-studio/issues/3)
- [#4 — full animation authoring and presets](https://github.com/flujo-app/mcp-video-studio/issues/4)
- [#5 — titles, captions, effects, QC, export, and project archives](https://github.com/flujo-app/mcp-video-studio/issues/5)
- [#6 — hardening, accessibility, packaging, and v1 acceptance](https://github.com/flujo-app/mcp-video-studio/issues/6)

## What works

- Human Studio served as an MCP App: project/media bin with generated tiles, revision-keyed program preview and transport, draggable/snapping multi-track timeline, pointer and keyboard trim/move, tracks, playhead, split/delete, transform/audio/effect inspector, undo/redo, export, and live jobs.
- Exact integer timebase for fractional video rates and 44.1/48 kHz audio.
- Portable JSON projects with managed or linked media, streaming SHA-256 deduplication, atomic saves, optimistic revisions, and durable undo/redo.
- Direct `ffprobe` normalization and direct `ffmpeg` spawning with argv arrays, bounded logs, cancellation, process-tree cleanup, and atomic artifact publication.
- Background thumbnail, proxy, waveform, program-preview, render, animation, and QC jobs with persisted progress and restart recovery.
- Multi-track video compositing and audio mixing with trim, move, split, playback rate, transform, opacity, gain, pan, fades, EQ/filter/effect stacks, and transitions.
- Semantic render caching shared by program previews and exports, with atomic publication, cache-hit provenance, LRU-style access timestamps, and bounded automatic eviction.
- H.264/AAC MP4 and lossless FFV1 presets, faststart, frame-exact output, hashes, provenance, and full-decode QC.
- First-class caption cues with frame-aligned timing, editable style and position, caption tracks, MCP operations, and deterministic FFmpeg burn-in.
- Declarative animation scene graph with tick-based easing and operations, plus self-contained HTML animations with an offline frame hook.
- Persisted generated-content artifacts for narration, music, captions, and animation: immutable parent-linked versions, provider/model/request provenance, draft/approve/reject state, timeline activation, and a human generation center in Studio.
- Direct OpenAI-compatible and ElevenLabs provider adapters. Product-critical generation does not depend on MCP Sampling; provider secrets stay server-side.
- stdio and Streamable HTTP MCP transports. Large media stays behind a tokenized, range-enabled loopback gateway instead of being base64-encoded through MCP.

The implementation sequence and current gaps are in [ROADMAP.md](./ROADMAP.md). The architecture, invariants, feature-completeness matrix, and v1 acceptance gates are in [TECHNICAL_PLAN.md](./TECHNICAL_PLAN.md).

## Requirements

- Node.js 20 or newer
- FFmpeg and ffprobe available on `PATH`, or configured with environment variables
- Chromium for animation rendering (`npm run runtime:install` in a source checkout)

On Windows, a full FFmpeg build is recommended. `mcp-video-studio doctor` reports the resolved binaries and runtime configuration.

## Install and run

From this repository:

```powershell
npm install
npm run runtime:install
npm run check
npm start
```

`npm start` uses stdio for MCP. It writes MCP protocol data only to stdout and prints the authenticated human-editor URL to stderr.

Run the standalone Streamable HTTP endpoint instead:

```powershell
npm run serve
```

The default MCP URL is `http://127.0.0.1:8787/mcp`. The human editor binds a random loopback port. Set `VIDEO_STUDIO_MCP_PORT=0` to choose a random MCP port too.

Run diagnostics:

```powershell
npm run build
node dist/index.js doctor
```

## MCP client configuration

After publishing/installing the package, a stdio client can use:

```json
{
  "mcpServers": {
    "video-studio": {
      "command": "npx",
      "args": ["-y", "mcp-video-studio", "--stdio"]
    }
  }
}
```

For a source checkout, use the absolute path to `dist/index.js` with `node`.

The `open_studio` MCP App supports the standard `inline`, `fullscreen`, and
picture-in-picture (`pip`) display modes. Its header exposes the modes supported
by the current host; PiP switches to a compact, preview-focused workspace.

The main MCP tools are:

- `open_studio`, `doctor`, `list_projects`, `create_project`, `get_project`, `get_sequence`
- `import_media`, `get_cache_status`, `apply_timeline_transaction`
- `add_track`, `add_clip`, `move_clips`, `trim_clip`, `split_clip`, `remove_clips`, `update_clip`
- `add_caption`, `update_caption`, `remove_captions`
- `get_generation_providers`, `list_generated_artifacts`, `generate_narration`, `generate_music`, `generate_captions`, `generate_animation`, `regenerate_generated_artifact`, `review_generated_version`
- `set_animation`, `undo`, `redo`
- `render_sequence`, `run_qc`, `list_jobs`, `get_job`, `cancel_job`

All mutations take `expectedRevision`. A concurrent human/agent edit returns a structured `REVISION_CONFLICT` instead of overwriting newer work.

Generated content uses the same rule. The first completed version is attached to its timeline slot as a draft. Regeneration creates a child version without changing the active clip. Activating or approving a version swaps only its media/animation source—or its owned caption cues—so clip placement, filters, automation references, and audio settings survive. A later MCP session can recover the complete lifecycle with `list_generated_artifacts`.

## Project layout

Each project is a directory:

```text
project/
  project.json
  assets/
  fonts/
  proxies/
  cache/
  history/
    state.json
    transactions/
  jobs/
  exports/
```

The canonical clock is `35,280,000` ticks per second. This represents 23.976, 24, 25, 29.97, 30, 50, 59.94, and 60 fps along with 44.1/48 kHz sample grids exactly.

## HTML animation protocol

An animation document with `mode: "html"` supplies a self-contained `html` string. External network requests are blocked. For every output frame the renderer pauses Web Animations at the exact virtual time and calls, when defined:

```js
window.renderFrame = ({ frame, tick, time, seed }) => {
  // Update DOM/canvas synchronously for this exact frame.
};
```

`time` is seconds and `tick` is the exact Studio tick. The result is captured at the project frame rate into a transparent/lossless FFV1 intermediate and behaves like any other timeline clip.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `VIDEO_STUDIO_DATA_DIR` | Standalone state root | `~/.mcp-video-studio` |
| `VIDEO_STUDIO_PROJECTS_DIR` | Default projects directory | `<data>/projects` |
| `VIDEO_STUDIO_SCRATCH_DIR` | Render scratch directory | `<data>/scratch` |
| `VIDEO_STUDIO_FFMPEG_PATH` | FFmpeg executable | `ffmpeg` |
| `VIDEO_STUDIO_FFPROBE_PATH` | ffprobe executable | `ffprobe` |
| `VIDEO_STUDIO_DEFAULT_FONT_FILE` | Explicit font used by text filters | unset |
| `VIDEO_STUDIO_MAX_CONCURRENT_JOBS` | Background concurrency | `2` |
| `VIDEO_STUDIO_GATEWAY_HOST` | Studio gateway bind address | `127.0.0.1` |
| `VIDEO_STUDIO_GATEWAY_PORT` | Studio gateway port (`0` is random) | `0` |
| `VIDEO_STUDIO_GATEWAY_TOKEN` | Fixed gateway token (minimum 32 characters; normally generated) | generated |
| `VIDEO_STUDIO_MCP_PORT` | Streamable HTTP MCP port | `8787` |
| `VIDEO_STUDIO_PUBLIC_ORIGIN` | Public gateway origin override | unset |
| `VIDEO_STUDIO_OPENAI_API_KEY` | OpenAI/OpenAI-compatible credential; falls back to `OPENAI_API_KEY` | unset |
| `VIDEO_STUDIO_OPENAI_BASE_URL` | Base URL used by OpenAI audio adapters | `https://api.openai.com/v1` |
| `VIDEO_STUDIO_LANGUAGE_BASE_URL` | OpenAI-compatible language endpoint for structured animation generation | OpenAI base URL |
| `VIDEO_STUDIO_LANGUAGE_MODEL` | Language model ID | `gpt-5.6-terra` |
| `VIDEO_STUDIO_LANGUAGE_PROTOCOL` | `responses` or `chat_completions` | `responses` |
| `VIDEO_STUDIO_OPENAI_SPEECH_MODEL` | OpenAI-compatible speech model | `tts-1` |
| `VIDEO_STUDIO_OPENAI_TRANSCRIPTION_MODEL` | OpenAI-compatible transcription model | `whisper-1` |
| `VIDEO_STUDIO_OPENAI_VOICE` | Default OpenAI-compatible voice | `alloy` |
| `VIDEO_STUDIO_ELEVENLABS_API_KEY` | ElevenLabs credential; falls back to `ELEVENLABS_API_KEY` | unset |
| `VIDEO_STUDIO_ELEVENLABS_BASE_URL` | ElevenLabs API base URL | `https://api.elevenlabs.io/v1` |
| `VIDEO_STUDIO_ELEVENLABS_VOICE_ID` | Default narration voice ID | unset |
| `VIDEO_STUDIO_ELEVENLABS_SPEECH_MODEL` | ElevenLabs speech model | `eleven_multilingual_v2` |
| `VIDEO_STUDIO_ELEVENLABS_TRANSCRIPTION_MODEL` | ElevenLabs transcription model | `scribe_v2` |
| `VIDEO_STUDIO_ELEVENLABS_MUSIC_MODEL` | ElevenLabs music model | `music_v2` |

API keys are intentionally absent from project files, history, jobs, MCP results, and browser storage. `doctor`, `get_generation_providers`, and Studio expose only redacted readiness information.

## Development and verification

```powershell
npm run typecheck
npm test
npm run build
npm run check
```

The normal suite has exact-time, command/store/history, animation-evaluator, and render-filter coverage. Run the real FFmpeg captioned render/QC and revision-cached preview/range acceptance tests with:

```powershell
$env:RUN_FFMPEG_INTEGRATION='1'
npx vitest run tests/render.integration.test.ts tests/preview.integration.test.ts
```

The implementation never constructs shell command strings for media work. It passes explicit arguments with `shell: false`, publishes only completed artifacts, removes render scratch data, and preserves structured dependency/runtime errors.

## Release

To publish the current version:

```powershell
npm run release
```

The release command signs in through npm when necessary, runs the complete
check suite, publishes the package publicly, and confirms that npm serves the
version. It is safe to rerun: if that exact version is already published, it
verifies the project and skips the duplicate publish.

Run `npm run release:check` to validate the release helper without publishing.

## License

MIT
