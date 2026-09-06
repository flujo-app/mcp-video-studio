# Core editing and timeline review

Studio and MCP apply the same revision-checked transactions. Undo and redo persist in the project journal and survive reopening. A stale edit requires reload and deliberate reapplication.

## Selection and edits

Click a clip or press Enter/Space while it is focused. Ctrl/Command or Shift adds it to the selection. Drag a rectangle from an empty part of a track to select across tracks; Select range reaches clips outside the current viewport. Ctrl/Command+A/C/V/D select all, copy, paste at the playhead and duplicate. Delete/Backspace removes the selection. Buttons provide equivalent actions. Shortcuts do not intercept text fields or modal dialogs.

Copy and duplicate include related clips, clip automation and transitions whose endpoints are both selected. New identities keep the copy independent. Duplicate appends after the selection. MCP `duplicate_clips` accepts an explicit offset when destination overwrite is intended. Omitted IDs in `group_clips` and `link_clips` create relationships; null clears them.

Drag a media asset onto a compatible track, double-click it, or focus it and press Enter/Space. Target media track chooses its destination. New clip edit mode selects overwrite, insert on the destination track, or ripple across tracks. The Timeline Ripple checkbox controls selection removal, movement and trims. Editing workflows > Close a global gap removes only an empty range.

Arrow keys move focused clips by one frame; Shift moves ten frames. Focus an edge handle and use the same keys to trim. Pointer handles snap to nearby boundaries when Snap is enabled. Inspector offers exact timing, slip, slide and roll controls. Track controls expose lock, mute, solo, hide, reorder and height.

Linked/grouped edits preserve relationships and offsets. An edit fails atomically when a locked partner, ambiguous neighbor, occupied ripple interval or missing source handle would break the edit. Sparse groups cannot ripple-delete unrelated material in their gaps. Overwrite splits related A/V content at the same interval and preserves retained automation.

Audio envelope movement rounds to the project's sample grid; later points win rounding collisions. Insert/remove boundaries bracket hold/linear ramps so retained samples keep their values. Non-audio time shifts retain integer ticks.

## Review

Transitions and markers opens adjacent-clip transition type/duration controls, including a visual duration slider, and marker label/time/seek/delete controls. Crossfade and directional wipes require adequate source handles.

Review range and jog provides frame stepping, I/O in/out marks, loop, and J/K/L reverse/stop/forward shuttle. Repeated J/L selects 1x, 2x or 4x. Compare source / program shows the selected source at its in-point plus the timeline offset and playback rate. Build preview refreshes the composed program for the current revision. Safe areas overlays the program monitor.

Visible clips request source-time thumbnail contact sheets and waveform images at power-of-two source spans from 0.5 to 32 seconds. Only visible tiles are mounted. A per-gateway service deduplicates requests, runs at most two decoders, bounds the unique queue to 32 requests and the overall deadline to 30 seconds, and cancels work when its last viewer disconnects. Shutdown awaits decoder cleanup. Derived PNGs are capped at 256 per project. Changed linked media requires inspection/relinking before rebuilding tiles.

## Acceptance evidence

- `core-editing-browser.integration.test.ts`: imports provided video/audio/still assets and builds a 60-second, three-track production through browser controls only. It exercises pointer and keyboard edits, track controls, all insertion modes, ripple deletion, gap removal, transition/marker review, source/zoom tiles and persistent history; axe reports no WCAG A/AA violations.
- `agent-editing-production.integration.test.ts`: the same provided 60-second inputs are assembled through actual modern MCP, then reviewed with a fresh legacy client. Linked splitting, durable history and targeted conflict repair preserve unrelated changes.
- `editing-boundaries.test.ts`, `ripple-boundaries.test.ts` and `automation-timing.test.ts`: linked roll/slide/overwrite, sparse groups, copy identity/automation, retained ramp samples, NTSC frame movement and sample-grid editing.
- `editing-mcp.test.ts`: actual modern and legacy grouping, linking, duplication and revision rejection.
- `timeline-tiles.integration.test.ts`: decoded source-time pixels and audio levels, cache reuse, authorization/Origin rejection, source-change rejection and cancellation cleanup.

These are automated acceptance productions. An unfamiliar human usability benchmark and a manual screen-reader pass require external testers; they are not claimed by the automated browser run.
