# Retiming managed media

Studio's **Retime media** inspector and the modern/legacy MCP retime_clip tool offer reverse playback, freeze frame, and a linear speed ramp. The operation creates lossless managed media and atomically replaces the selected clip's source. Original assets, placement, duration, effects, audio settings, automation, linked/group IDs, and transitions remain in the project. Undo and redo restore the complete transaction.

- **Reverse** reverses normalized project-rate frames and interleaved audio sample frames. Audio plays backwards. Existing constant playback speed is applied before reversal.
- **Freeze frame** holds a source frame chosen by a position inside the clip; its audio becomes silence. Positions in the last valid source frame are supported.
- **Linear speed ramp** changes source velocity linearly between 0.25 and 4 times speed. The authored clip duration stays fixed, so the consumed source interval changes. Audio pitch follows speed. A bounded Blackman-windowed sinc resampler uses the same analytic source-time curve as video and attenuates frequencies that would alias during acceleration. This operation does not promise pitch-preserving variable-speed speech.

The existing constant playback-rate control remains available. Animation and nested-sequence clips must first be rendered and imported as managed media before these three derived-media operations can be applied.

## MCP request

Call retime_clip with projectPath, expectedRevision, sequenceId, clipId, and mode (reverse, freeze, or linear-ramp). Freeze accepts optional freezeAtTick (default zero, measured from the selected clip's start). Ramps accept startRate and endRate; explicit values are recommended. includeLinked defaults to true and applies the same operation to the selected clip's linked group, up to eight media clips. Groups without a link are retained but are not implicitly selected.

The response contains a background job and operationId. Poll get_job; inspect its terminal status and structured error. cancel_job waits for owned processes and scratch to settle. A concurrent edit causes a revision conflict at publication and preserves the newer project. Missing source handles, disabled clips, locked tracks, and unsupported source types fail before publication.

Transition handles are included in derived media. Audio/video clips linked across different tracks can therefore have different derived durations while retaining their authored placement and exact transition coverage.

## Bounds and recovery

Each clip is limited to 120 seconds including transition handles, 7200 output frames, and a source raster of at most 4K pixels. Jobs have a 60-minute deadline, source checksums are pinned and rechecked, and free scratch space is checked conservatively. Video reversal uses at most 64 MiB of decoded frames per chunk; PCM reversal uses two 1 MiB buffers. Ramp interpolation streams bounded PCM windows. FFmpeg and native decoder internals may use additional memory.

Video outputs use FFV1 and float32 PCM in Matroska; audio-only output uses float32 WAV. After publication, video proxies, thumbnails and waveforms are queued for Studio source comparison. Proxy failures never undo or misreport the committed edit; create_proxies can retry them. Frame and sample counts follow project clocks; a rounded container duration never substitutes for the intended timeline duration. Derived media carries source checksums and retiming provenance.

Operation records under the configured data directory reconcile interrupted jobs against the project's atomic committed history cursor. A committed or subsequently undone retime can be recognized after restart. An uncommitted history file is not proof of publication. Recovery removes only the dead operation's UUID-owned scratch directory and preserves project assets. If the project or retained history cannot prove a commit, inspect the project before explicitly retrying.

## Validation

- retiming.integration.test.ts: every reversed decoded frame and stereo sample, multi-chunk reversal, freeze-frame identity and numerical silence, increasing/decreasing ramp positions and late audio windows.
- retime-plan.test.ts and retime-pcm.test.ts: inverse clock mapping, source-handle rejection, last valid freeze frame, 1/2/6-channel DC preservation at extreme speeds, exact lengths, pre-aborted work, and above-Nyquist attenuation.
- retiming-mcp.integration.test.ts: actual modern and legacy HTTP clients, linked media, transitions, automation, fresh sessions, undo/redo, concurrent revisions, and cancellation.
- retiming-recovery.integration.test.ts: committed, undone, and orphaned transaction snapshots with fresh runtime recovery and unrelated-file preservation.
- retiming-browser.integration.test.ts: bundled CLI and Chromium reverse/freeze/ramp controls, undo, project reload, rational-rate H264 export and accessibility checks.

The fixtures are deterministic and use no provider account. Supported-platform CI and an unfamiliar human's usability review remain separate acceptance gates.
