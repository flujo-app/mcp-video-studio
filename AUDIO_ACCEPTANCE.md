# Audio editing and acceptance

Audio changes use the project sample grid (48 kHz by default). Gain lanes support hold and linear interpolation. Pan and numeric effect ranges are absolute hold changes over a half-open interval `[startTick, endTick)`; unsupported curves fail explicitly. Clip ranges use timeline time, retain their clip ID, and stay inside the clip. Track ranges use timeline time. Editing the same absolute parameter reuses its lane, preserves other intervals, and supports project undo/redo. The editor lists these lanes with a remove control.

The range renderer evaluates each distinct setting with the complete input and processing history, including clip, track and final mix effects. It selects the final PCM samples for each interval after processing. A delay, compressor, gate or loudness processor therefore does not leak changed state into samples outside the selected interval. Range edges are deliberate discontinuities; use a separate linear gain envelope for fades. This is bounded offline rendering, not realtime parameter modulation: at most 32 absolute parameter lanes, 128 points per lane, 256 intervals and 16 distinct setting combinations per sequence. The renderer rejects excess complexity before spawning FFmpeg. Gain lanes remain sample-evaluated and do not create extra setting variants.

All exposed numeric parameters are range-editable: EQ band frequency/Q/gain, high/low-pass frequency, compressor and gate threshold/ratio/attack/release, limiter ceiling, delay time/decay, de-esser intensity/amount/frequency, reverb mix, and loudness target/true peak/range. The shared catalog in `packages/contracts/src/audio-parameters.ts` specifies finite bounds and defaults. EQ ranges refer to an existing band; they do not create bands. Remove a parameter lane before removing its effect. Stereo pan is a balance control, matching the existing renderer; mono and 5.1 projects reject pan ranges.

## Mix workflow

1. Import narration and music, assign separate audio tracks, and edit their clips.
2. Apply the dialogue chain or individual clip effects. Track effects process the mixed clips on that track.
3. Use **Voiceover ducking** to attenuate the music under enabled voice clip regions. Its attack/release ramps align to samples and preserve existing music automation. Overlapping ramps join into one region. This follows clip timing, not speech detection; reapply after moving or resizing voice clips. Replacing a source at unchanged timing retains the ducking.
4. Use **Final mix bus** to process the combined tracks once. **Normalize final mix to -16 LUFS** adds one final loudness stage with a -1.5 dBTP target. A simultaneous input and final normalization stage is rejected. Nested sequences retain their own bus processing.
5. Build the program preview, enable its stereo playback meters, and audition it. These meters measure decoded preview sample peaks through Web Audio; they are not true-peak or integrated-loudness meters. Export QC supplies those measurements.
6. Queue an export, run QC, inspect all warnings, and review detected ranges. QC `passed` means no failing checks; it does not mean every check is PASS or every warning has been reviewed.

The corresponding MCP tools are `set_audio_gain_range`, `set_audio_parameter_range`, `duck_audio_under_voice`, `set_audio_master`, `render_sequence` and `run_qc`. They use the same project commands and renderer as the editor.

## Preview/final PCM tolerances

These are within-run tolerances using the same installed FFmpeg build, input assets, project revision and audio codec/bitrate. Browser preview uses the selected H.264 preset's audio encoding while reducing video size/quality. Changing video size/CRF must not change audio processing. Cross-version FFmpeg or different audio codecs are not expected to have identical PCM.

| Processor | Compared path | Maximum decoded PCM difference |
| --- | --- | --- |
| EQ (all configured bands) | Preview AAC vs final AAC | 1 / 8,388,608 |
| High-pass | Preview AAC vs final AAC | 1 / 8,388,608 |
| Low-pass | Preview AAC vs final AAC | 1 / 8,388,608 |
| Compressor | Preview AAC vs final AAC | 1 / 8,388,608 |
| Limiter | Preview AAC vs final AAC | 1 / 8,388,608 |
| Delay | Preview AAC vs final AAC, including audible tail | 1 / 8,388,608 |
| Gate | Preview AAC vs final AAC | 1 / 8,388,608 |
| De-esser | Preview AAC vs final AAC | 1 / 8,388,608 |
| Reverb | Preview AAC vs final AAC, including audible tail | 1 / 8,388,608 |
| Loudness normalization/resampling | Preview AAC vs final AAC | 1 / 8,388,608 |
| Pan, delay and compressor range edits | WAV PCM outside range vs original; inside vs full-history setting | 1 / 8,388,608 |
| Gain envelopes and ranged video cache | Whole/ranged lossless render | 1 / 8,388,608 |

The per-effect matrix resamples 44.1 kHz source audio to 48 kHz and includes sample-aligned range edits. Delay/reverb tests assert nonzero post-source tails, so matching silence cannot pass. Existing range-cache tests also assert nonzero final audio beyond the first clip's EOF. Continuous float PCM is computed for the entire sequence before video-range assembly; per-input padding, independent audio/video demuxers and sample-count trims preserve this behavior. Nested child sequences and their final bus are included in the parent continuous-audio cache fingerprint.

The table does not assert that lossy AAC sounds identical to a WAV export. AAC/Opus and PCM encodings have distinct errors, padding and peak behavior; use output QC after choosing the delivery codec. WAV export is 24-bit PCM.

## Reproducible evidence

- `tests/audio-parameter-range.test.ts`: interval composition, sample grid, invalid targets/curves, unique active lanes and durable undo.
- `tests/audio-parameter-range.integration.test.ts`: every outside sample, full-history inside samples, nontrivial changed samples, resampling and downstream compressor memory.
- `tests/audio-parity-matrix.integration.test.ts`: all ten effects and audible effect tails in actual preview/final renders.
- `tests/audio-ducking.test.ts`: merged voice regions, exact ramps, restored music and preserved unrelated automation.
- `tests/audio-master.integration.test.ts`: nested bus rendering and cache invalidation, duplicate normalization rejection.
- `tests/audio-regeneration.integration.test.ts`: modern/legacy MCP generation, partial regeneration, approved third imported spoken take, preserved gain/pan/effect lanes and successful final render.
- `tests/audio-production-browser.integration.test.ts`: actual stdio MCP plus Chromium editor, offline spoken narration, music, parameter ranges, dialogue chain, ducking, final mix, live decoded meters, reviewed loudness/peak checks and MP4/WAV export.

Run audio DSP tests with `RUN_FFMPEG_INTEGRATION=1`. Browser tests additionally require `RUN_BROWSER_INTEGRATION=1` and a built application. The committed speech fixture is generated offline with Flite; the generation adapter fixture is a local HTTP server. Neither fixture demonstrates paid provider availability or replaces human listening/review.
