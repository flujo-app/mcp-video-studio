# Video Studio acceptance tracking

Updated 2026-09-06T04:10:43.227Z. PR remains a draft while feasible criteria below are implemented. No epic is closed by this checkpoint.

## Issue 6: The five acceptance productions in `TECHNICAL_PLAN.md` pass from clean installs.

Status: in-progress.

- CI 34007281456: clean package and browser/media checks on Windows/macOS/Linux Node22/24.

Remaining: Build the full 30s promo and agent-only acceptance production. The mixed-media long-project fixture and multiscene SVG/morph/transform/text/camera/particles renderer production pass locally; the long project also passed Linux Node22 CI 34013043222. Unfamiliar-human acceptance needs a human tester.

## Issue 6: A 30-minute project remains responsive and a one-clip edit invalidates only required render work.

Status: verified.

- tests/long-project.integration.test.ts passed:30min/901mixed video/image/color/audio clips with proxies,54000frames,180cached ranges
- Actual stdio MCP editor load545ms/far-end scroll51ms; last-clip change reuses179ranges and continuous audio cache
- Dedicated LinuxNode22 CI step added; all platform regular parity/browser gates remain

Remaining: No remaining implementation for this measured fixture; CI confirmation pending on next push.

## Issue 6: Human and agent benchmarks complete without shell commands, direct project JSON edits, or hand-written FFmpeg filtergraphs.

Status: in-progress.

- Real SDK2 packed install and browser-only project/selection/caption/template workflows pass.

Remaining: Complete the prescribed full agent production. Unfamiliar-human usability benchmark is an external acceptance step.

## Issue 6: No unresolved P0/P1 correctness, data-loss, security, accessibility, or preview/render-parity defects remain at v1.0.0.

Status: in-progress.

- Host/Origin/token/HTML/path/archive/provider adversarial tests; atomic history and disk fault tests; axe and actual pixel/sample tests.

Remaining: Finish all remaining code criteria and independent final review; no v1.0 claim.

## Issue 5: QC findings navigate directly to affected timeline ranges with evidence.

Status: verified.

- tests/qc-ranges.integration.test.ts: real decoded frame counts and timestamped black/freeze/silence with clip IDs and persisted intentional ranges
- tests/qc-browser.integration.test.ts: browser queues export/QC, navigates to1.000s, inspects measured values, persists review and reloads

Remaining: No remaining work for range navigation and measured evidence; additional finishing/QC checks remain tracked under finishing coverage.

## Issue 5: Caption/title workflows support import, edit, style, burn-in, and sidecar export.

Status: in-progress.

- SRT/WebVTT import/export, caption inspector/style, real drawtext burn-in and templates/browser workflow pass.

Remaining: ASS interchange, font import/overflow/safe-area workflows and full finishing browser acceptance.

## Issue 5: Export and project archives are atomic, validated, portable, and reproducible from provenance.

Status: in-progress.

- tests/archive.test.ts: repeatable bytes, materialized linked sources, checksum/path validation and atomic import; schema2 recovery migration tests.
- Source hashes rechecked and streams/duration validated before atomic export publication; corrupt cache failure preserves prior export

Remaining: Archive cancellation/recovery jobs, media relink/consolidation workflow and export provenance/history surface.

## Issue 5: Effects and transitions have preview/final coverage and never require caller-authored filtergraphs.

Status: in-progress.

- New actual FFmpeg audio processor/limiter tests and multiply/screen alpha-coverage pixel test pass; shared preview/export renderer.
- tests/transitions.integration.test.ts: real centered crossfade 50/50 and wipe direction, unchanged frame count; finite source handles rejected atomically

Remaining: Remaining declared formats/effects and preview/final parity matrix; finishing browser coverage.

## Issue 4: A human can inspect and edit a generated animation at node/property/keyframe granularity in Studio.

Status: in-progress.

- UI node name/text/position controls and basic templates exist.

Verified by tests/animation-editor.integration.test.ts: real MCP-launched browser hierarchy, canvas selection, keyboard movement, property and keyframe edits, durable undo/redo/reopen and zero axe violations. The multiscene SVG/morph/transform/kinetic-text/camera/particles production has sampled editor/export pixel parity and repeated decoded-frame identity. Additional clip-operation coverage remains below.

## Issue 4: An MCP client can make a targeted animation change without replacing the whole scene document.

Status: verified.

- tests/http-security.test.ts and tests/advanced.test.ts: actual modern/legacy SDK clients update one animation node/operation while preserving the rest.

Remaining: No remaining work for targeted scene mutation criterion; broader animation epic remains open.

## Issue 4: Repeated renders are deterministic and hostile HTML cannot access network, navigation, popups, downloads, service workers, or filesystem APIs.

Status: in-progress.

- Sandbox adversarial network/parent/storage/worker/popup tests; nonblank deterministic pixel hashes and stuck-frame cancellation pass.

Verified by tests/sandbox.integration.test.ts: seeded crypto/UUID, forbidden timers/RAF, navigation closure, download/service-worker rejection and exact requested CSS animation timestamps. Remaining: independent final security review with the full production fixture.

## Issue 4: Animation clips remain ordinary trim/split/speed/effect/transition-capable timeline clips.

Status: in-progress.

- Source-handle validation and shared clip trim/split/speed/effect rendering paths.

Remaining: Exercise animation-specific trim/split/speed/transition pixel parity after transition completion.

## Issue 3: A new MCP session can inspect a project and safely revise one generated region without regenerating or disturbing unrelated work.

Status: in-progress.

- Generation lineage/current draft/version inspection plus reconnect/persistence tests.

Remaining: Implement explicit partial-region regeneration for all kinds and prove unrelated content preservation over a new MCP session.

## Issue 3: No regeneration becomes active before explicit review unless the caller chooses an explicit auto-activate policy.

Status: in-progress.

- tests/generation.test.ts: regenerated child stays draft and does not replace active output before review.

Remaining: Add explicit auto-activation policy and cross-kind browser/provider-mock acceptance.

## Issue 3: Humans can compare, approve, reject, revert, and annotate every generated version in Studio.

Status: in-progress.

- Existing approve/reject/activate UI; compare/annotate feature APIs and local-media adoption.

Remaining: Connect A/B/ranged audition, version diffs, annotations and reversion to the browser.

## Issue 3: Provider secrets remain server-side and are absent from projects, jobs, history, browser storage, logs, and tool results.

Status: in-progress.

- Provider redirects, bounded responses, request-ID removal, configured-secret redaction and endpoint validation tests pass.

Remaining: Add end-to-end all-storage/log/browser/tool canary assertions across generation kinds and failures.

## Issue 2: Human and MCP clients can make exact time-ranged audio changes without replacing unaffected clips.

Status: in-progress.

- Gain-range commands/UI and real sample-boundary rendering test preserve surrounding samples.

Remaining: Extend range controls to pan/effect parameters and complete browser plus actual MCP exact-range acceptance.

## Issue 2: Preview and exported audio meet documented per-effect parity tolerances.

Status: in-progress.

- Same processing graph for program preview/export; actual FFmpeg supported audio processors execute; post-mix limiter verified by PCM.

Remaining: Document per-effect tolerance table and compare preview/final decoded audio including resampling and tails.

## Issue 2: Automation is sample/grid aligned, survives regeneration/source swaps, and is covered by boundary tests.

Status: in-progress.

- Exact gain sample boundaries; moved/split linked clip automation and durable undo tests.
- tests/envelope.test.ts: every outside sample and linear edge survives gain-range update, cross-target write rejected, undo restored

Remaining: Regeneration/source-swap audio automation acceptance and remaining curve/parameter support.

## Issue 2: A VO + music project can be ducked, mixed, loudness-normalized, reviewed, and exported without an external DAW.

Status: in-progress.

- Music gain range, post-mix track effects, loudness normalization with duplicate-stage rejection, mixer/clip effect stack UI implemented.

Remaining: Full VO+music browser production, live mixer meters, ducking controls/buses and reviewed export evidence.

## Issue 1: A human can assemble and revise a multi-track one-minute edit without direct JSON editing or terminal assistance.

Status: in-progress.

- Browser imports captions, creates titles/color, edits selection and undo/redo; core import/export paths tested.

Remaining: Full one-minute multi-track production with provided mixed media; unfamiliar human verification external.

## Issue 1: Pointer and keyboard flows cover every core operation above.

Status: in-progress.

- Multi-selection/copy/paste/duplicate/group/link, track controls, keyboard trims/moves and modal focus implemented; browser proves core subset.

Remaining: Marquee, transition/marker/range/loop/jog controls, full keyboard and screen-reader acceptance.

## Issue 1: Linked/grouped/ripple edits have boundary tests and durable undo/redo.

Status: in-progress.

- tests/ripple-boundaries.test.ts five linked split/move/trim/insert/delete tests; advanced roll/slide/slip and reopening undo tests pass.

Remaining: Add remaining overwrite/sparse grouping/automation interpolation edge cases and redo coverage; linked roll/slide currently explicit unsupported boundaries.

## Issue 1: A concurrent human/model edit produces a visible conflict/reapply flow rather than lost work.

Status: verified.

- tests/qc-browser.integration.test.ts: concurrent external revision becomes visible conflict, reapply is disabled until reload, reapplied edit preserves external track rename
- Actual SDK modern/legacy revision conflict tests also pass

Remaining: No remaining work for conflict/reapply acceptance.

External acceptance remains explicit: unfamiliar-human usability benchmark and authenticated paid-provider generation have not been claimed.

Animation checkpoint: full local gate passes 68 tests, packed modern/legacy MCP clients, persistence, EOF and browser checks. Explicit sample spans pass Linux/macOS CI for the preceding audio-only checkpoint; Windows jobs are pending.
