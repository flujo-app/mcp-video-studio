# Video Studio acceptance evidence

Updated 2026-09-06T09:02:01.383575+00:00. Committed baseline: bf5c67bd270effa985cdfe32c403e334219da54e. PR #7 remains a draft. This maps every criterion in issues #1�#6; no issue is automatically closed.

All implementation and verification runs use the ai-computer MCP VM agent-workstation. The exact baseline clean-install gate passed 120 ordinary and 214 real tests, installed 88-tool modern/legacy/EOF checks, five installed browser workflows, and npm audit with zero findings. Both minute-delivery workflows additionally pass against a fresh installed package with all seven installed workflows. Baseline bf5c67b passed all six Linux/macOS/Windows Node22/24 jobs in CI run 34023163232. The new test/document checkpoint still requires its own exact-head CI.

## Issue 6: The five acceptance productions in `TECHNICAL_PLAN.md` pass from clean installs.

Status: automated-productions-in-final-validation.

- The 30-second MCP promo delivers 900 decoded 1920x1080/30 frames with stereo 48 kHz AAC, faststart and all 12 QC checks passing.
- The 30-minute/901-clip fixture and deterministic multi-scene animation production pass their dedicated tests.
- Both same-input one-minute productions pass title/animation, caption defect repair, normalization and 1,800-frame delivery. The browser completes 68 durable revisions with all 8 applicable QC checks passing; the agent completes 26 revisions with all 7 applicable checks passing.

Remaining: Complete final six-job platform CI; clean-installed minute delivery passes. An unfamiliar-human usability benchmark remains external.

## Issue 6: A 30-minute project remains responsive and a one-clip edit invalidates only required render work.

Status: verified.

- tests/long-project.integration.test.ts: 30 minutes, 901 mixed clips with proxies, 54,000 frames and 180 cached ranges.
- Measured editor load 545 ms and far-end scroll 51 ms; one final-clip edit reuses 179 ranges and the continuous audio cache. Dedicated Linux Node22 CI passed.

Remaining: No code gap identified for this bounded fixture; repeat its dedicated gate on the final PR head.

## Issue 6: Human and agent benchmarks complete without shell commands, direct project JSON edits, or hand-written FFmpeg filtergraphs.

Status: automated-productions-in-final-validation.

- The 30-second production performs every project mutation through actual MCP.
- Both one-minute counterparts share prepared video/music/still inputs. Browser editing retains its 56-control matrix and reaches 68 revisions through delivery; actual modern and legacy MCP sessions prove targeted conflict repair and durable history.
- Minute delivery extensions use existing title/animation, caption layout repair, normalization and public export/QC actions. Fixture preparation and read-only media inspection are outside the editing workflow.

Remaining: Clean-installed minute delivery passes. Recruit an unfamiliar human for the independent usability benchmark; automation is not a substitute.

## Issue 6: No unresolved P0/P1 correctness, data-loss, security, accessibility, or preview/render-parity defects remain at v1.0.0.

Status: release-gate-open.

- Exact LUT checkpoint bf5c67b passes clean install/check with 120 ordinary tests and 214 real-media/browser tests, installed 88-tool modern/legacy/EOF checks, five installed browser workflows and npm audit with zero findings.
- Strict pixel, sample, atomic-write, provenance, sandbox, token/Origin, path and credential-canary tests remain enabled.

Remaining: Final combined supported-platform CI, independent release review and manual assistive-technology assessment remain required before v1.0. No issue closure or v1.0 claim.

## Issue 5: QC findings navigate directly to affected timeline ranges with evidence.

Status: verified.

- tests/qc-ranges.integration.test.ts and qc-browser.integration.test.ts exercise decoded frame counts, timestamped black/freeze/silence findings, affected clip IDs, measured evidence, direct timeline jumps and persisted intentional-range review.
- Caption layout findings additionally identify caption IDs and exact timeline ranges.

Remaining: No identified implementation gap for this criterion; final combined CI remains shared.

## Issue 5: Caption/title workflows support import, edit, style, burn-in, and sidecar export.

Status: verified.

- CAPTIONS.md documents SRT/WebVTT/ASS interchange, portable managed TTF/OTF fonts, text/timing/style/outline/shadow/margin controls, burn-in and sidecars.
- Real caption-finishing/layout/font tests exercise bounded FFmpeg metrics, clipping and 5% safe-area measurement, repair, staleness, reopen and axe. Full promo delivery includes editable titles and captions.

Remaining: Unsupported advanced ASS inline overrides are explicitly rejected rather than silently changed; subjective typography review remains external.

## Issue 5: Export and project archives are atomic, validated, portable, and reproducible from provenance.

Status: verified.

- ARCHIVES.md and export/archive real browser/process tests prove atomic checksummed portable archives, managed relink/consolidation, cancellation and restart reconciliation.
- Render receipts pin immutable project snapshots, nested inputs, source/LUT hashes, encoder/environment and output hashes; reproduction checks source availability and exact encoder choices.
- Windows checkpoint de4fbb2 adds bounded rename retries without deleting the original and native lock-release tests.

Remaining: Final Windows CI must confirm the native retry fixture. Unavailable recorded hardware is explicitly rejected during reproduction.

## Issue 5: Effects and transitions have preview/final coverage and never require caller-authored filtergraphs.

Status: verified.

- VIDEO_EFFECTS.md: all nine color effects preserve original alpha; exact whole/range lossless pixels and H264 preview/final MAE <= 3, RMS <= 8 are tested. Geometric masks preserve alpha in ranges and nested sequences.
- LUTS.md: bounded managed .cube parsing/import, two interpolation methods, exact whole/range color changes, nested/archive hash dependencies and actual installed browser/MCP workflows.
- EXPORTS.md and RETIMING.md: HEVC/GIF/PNG ZIP/H264/VP9/FFV1/WAV, rational frame clocks, exact audio slices, encoder fallback/replay, freeze/reverse/linear ramps with actual final PCM count and transactional recovery.

Remaining: Real hardware encoders require available hardware. GIF centisecond timing and pitch-following variable ramps are explicit documented contracts, not claims of arbitrary precision or pitch preservation.

## Issue 4: A human can inspect and edit a generated animation at node/property/keyframe granularity in Studio.

Status: verified.

- tests/animation-editor.integration.test.ts exercises hierarchy/canvas selection, keyboard movement, properties, operations/keyframes, durable undo/redo/reopen and axe.
- Shared editor/export painter supports grouped transforms, SVG morphs, kinetic text, camera motion, seeded particles and bounded embedded media.

Remaining: Unfamiliar-human and manual assistive-technology acceptance remain external; template aesthetics are not measured by deterministic tests.

## Issue 4: An MCP client can make a targeted animation change without replacing the whole scene document.

Status: verified.

- Typed edit_animation applies individual node/property/operation edits through actual modern and legacy clients while preserving unmentioned scene objects.
- Generation-region and animation-clips tests also preserve unrelated human animation edits during activation/revert.

Remaining: No identified code gap; final combined CI remains shared.

## Issue 4: Repeated renders are deterministic and hostile HTML cannot access network, navigation, popups, downloads, service workers, or filesystem APIs.

Status: verified.

- Sandbox adversarial tests cover network, parent access, navigation, popups, downloads, workers/service workers, storage and filesystem surfaces.
- Deterministic clock/PRNG, seeded crypto, explicit frame-driven scheduling and immutable same-frame canvas capture retain strict nonblank pixel hashes.
- c6406229 recovers a lost canvas by drawing the same frame on a fresh canvas at most three times; persistent loss rejects publication. Subsequent macOS timing checkpoint jobs passed strict animation gates.

Remaining: Final combined platform CI and independent security review remain required; no claim that a finite adversarial suite proves universal sandbox safety.

## Issue 4: Animation clips remain ordinary trim/split/speed/effect/transition-capable timeline clips.

Status: verified.

- tests/animation-clips.integration.test.ts compares actual split/trim/speed/effect/transition pixels with equivalent managed media.
- Fractional source-frame, original timestamp and cached-range regressions preserve frames at 24 and 30000/1001 fps.

Remaining: No identified implementation gap; final combined CI remains shared.

## Issue 3: A new MCP session can inspect a project and safely revise one generated region without regenerating or disturbing unrelated work.

Status: verified-with-fixture-provider.

- Generation region composition persists across fresh modern/legacy sessions and multiple versions; source regions outside the selected revision preserve unrelated clips, captions, automation and human transforms.
- Real HTTP provider fixtures, actual FFmpeg outputs, pending-edit race/revert and nested animation activation tests pass.

Remaining: Authenticated paid-provider generation requires provider accounts/credits and is unclaimed.

## Issue 3: No regeneration becomes active before explicit review unless the caller chooses an explicit auto-activate policy.

Status: verified-with-fixture-provider.

- Generation drafts remain inactive by default; explicit autoActivate policy is the only opt-in bypass.
- Tests cover pending/success/failed/rejected states and revision-safe activation with unrelated human edits.

Remaining: Authenticated paid-provider acceptance remains external.

## Issue 3: Humans can compare, approve, reject, revert, and annotate every generated version in Studio.

Status: verified-with-fixture-provider.

- GENERATION.md and actual browser tests cover bounded A/B playback, automatic range stop, rapid switching, annotations, approve/reject/revert and reopened state.
- Fault-injected older HTTP project responses cannot overwrite newer same-project revisions.

Remaining: Independent human review of provider output quality and authenticated paid-provider acceptance remain external.

## Issue 3: Provider secrets remain server-side and are absent from projects, jobs, history, browser storage, logs, and tool results.

Status: verified-with-fixture-provider.

- Provider canary tests inspect project files, jobs, history, browser storage, logs and tool results; keys stay server-side and provider errors/configuration labels are sanitized.
- Bounded caption/audio inputs and raw PCM/mulaw/alaw decoder/temp-cleanup tests use local HTTP fixtures without real keys.

Remaining: Real provider-account acceptance remains external; no credentials were requested or exposed by these fixtures.

## Issue 2: Human and MCP clients can make exact time-ranged audio changes without replacing unaffected clips.

Status: verified.

- Exact audio pan/effect ranges use full-history graph variants masked by integer sample index, preserving every outside sample.
- Real 44.1-to-48 kHz pan/delay/compressor and actual modern/legacy MCP range tests pass.

Remaining: No identified implementation gap; subjective listening review remains external.

## Issue 2: Preview and exported audio meet documented per-effect parity tolerances.

Status: verified.

- AUDIO_ACCEPTANCE.md documents the per-effect matrix and PCM tolerance of 1/8388608, continuous float-WAV cache and one final master bus.
- All supported effects, stateful tails, output ranges and actual preview/final decoded PCM are checked without widening the strict tail-signal assertion.

Remaining: Manual listening-panel acceptance remains external.

## Issue 2: Automation is sample/grid aligned, survives regeneration/source swaps, and is covered by boundary tests.

Status: verified.

- Automation sample/grid boundary tests retain envelope values outside edited ranges and survive source swaps, regeneration and nested master-cache changes.
- Clip duplication remaps automation/relation IDs; linked/ripple edits preserve source handles and automation through durable undo/redo.

Remaining: No identified code gap; final combined CI remains shared.

## Issue 2: A VO + music project can be ducked, mixed, loudness-normalized, reviewed, and exported without an external DAW.

Status: verified.

- Actual spoken VO/music browser workflow applies dialogue processing, ducks music, normalizes the final bus, reads live decoded meters, reviews and exports MP4/WAV.
- The full promo and completed agent-minute delivery pass loudness/true-peak QC; non-finite measurements serialize as explicit null.

Remaining: No external DAW is required for these fixtures. Human listening/quality judgments remain external.

## Issue 1: A human can assemble and revise a multi-track one-minute edit without direct JSON editing or terminal assistance.

Status: verified.

- Committed core browser benchmark performs 56 pointer/keyboard edits on the same provided 60-second video/music/still composition and proves persistence after reload.
- The public MCP counterpart performs linked split, undo/redo, source revisions and modern/legacy conflict repair; its complete 1,800-frame delivery extension now passes.

Remaining: The extended browser and clean-installed title/caption/audio/QC/export gates pass; unfamiliar-human usability remains external.

## Issue 1: Pointer and keyboard flows cover every core operation above.

Status: verified.

- EDITING.md and real browser matrix cover split, slip/slide/roll, pointer/keyboard trims, transition controls, markers, in/out/loop/jog, group/link/ripple, insert modes, track state/order, clipboard and durable undo/redo.
- Source-time thumbnail/waveform tiles are virtualized, content-keyed and tested across zoom levels. Targeted mask, retiming, LUT, caption, audio and export controls have separate real browser gates.

Remaining: Manual screen-reader and full keyboard usability review by a human remain external; axe automation reports no detected violations in covered flows.

## Issue 1: Linked/grouped/ripple edits have boundary tests and durable undo/redo.

Status: verified.

- Linked/grouped/ripple boundary tests and actual modern/legacy MCP tests cover optional group/link IDs, explicit clearing, duplication with automation remapping and exact source handles.
- Undo/redo persists in the atomic history cursor across reopen, with cross-process locking and restart/publication fault tests.

Remaining: Final Windows native write-retry and combined CI remain required.

## Issue 1: A concurrent human/model edit produces a visible conflict/reapply flow rather than lost work.

Status: verified.

- Actual browser conflict flow exposes stale revision, disables reapply until the latest revision loads, then preserves another writer's track rename.
- Modern/legacy MCP rejects stale writes; minute-production targeted repair retains unrelated clips/reviews. Monotonic HTTP-refresh tests prevent delayed older responses replacing committed edits.

Remaining: No identified implementation gap; final combined CI remains shared.

The retained successful 30-second production, project, inputs and contact sheet are at /workspace/mcp-remediation/evidence/video-studio/promo-production-20260906. An automated browser run does not establish unfamiliar-human usability, and fixture HTTP providers do not establish authenticated paid-provider acceptance.

The two full-minute outputs and complete project/input directories from the clean installed gate are retained at /workspace/mcp-remediation/evidence/video-studio/minute-production-20260906. Its human-minute.json and agent-minute.json reports identify exact paths, revisions, decoded frame counts and QC measurements. The gate passed 120 ordinary tests, 88-tool modern/legacy/EOF persistence, seven installed workflows and npm audit with zero findings. No implementation or test blob changed after that successful gate; only this evidence paragraph was finalized.
