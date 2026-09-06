# Export formats, ranges and encoders

Export through the Studio **Export** tab or MCP `render_sequence`. Call `get_export_capabilities` (Studio: **Check available encoders**) for this installation's encoder test results. Existing projects can select current built-in presets while retaining their saved custom presets. The selected preset is included in the immutable export snapshot; selecting a built-in does not mutate the project.

| Built-in preset | Output | Audio | Encoding |
|---|---|---|---|
| `web-h264-1080p` | MP4 | AAC | H.264, CRF 18 |
| `web-hevc` | MP4 | AAC | HEVC, CRF 23, hvc1 tag |
| `web-vp9` | WebM | Opus | VP9, CRF 30 |
| `archive-ffv1` | Matroska | FLAC | Lossless FFV1 |
| `audio-wav` | WAV | 24-bit PCM | Completed audio mix |
| `animated-gif` | GIF | None | Per-frame palette; infinite loop |
| `png-sequence` | ZIP | None | Numbered PNG frames plus manifest |

All video exports use the project raster and rational frame rate. The program preview remains H.264 for browser playback; HEVC playback support depends on the viewing application. PNG is lossless relative to the renderer's completed video frames, which already include the project's compositing and color conversion.

## Range exports

The optional `range: {startTick, endTick}` is a non-empty half-open interval inside the rendered sequence. Video boundaries must align to project frames; WAV boundaries must align to output audio samples. The Studio displays frame indices for video and sample indices for WAV. The full sequence is selected when range is omitted.

The engine evaluates the completed program before trimming. Delay tails, compressors, normalization, automation, captions and nested sequences therefore retain the same preceding history as a full export. Video timestamps restart at zero. Audio boundaries at fractional-rate video frames round to the nearest sample; the manifest/result records those actual sample indices. A standalone WAV range is an exact slice of the full 24-bit processed WAV.

Example:

```json
{
  "projectPath": "/path/to/project",
  "sequenceId": "saved-sequence-id",
  "presetId": "web-hevc",
  "outputPath": "/path/to/export.mp4",
  "expectedRevision": 12,
  "range": {"startTick": 35280000, "endTick": 70560000}
}
```

Use the project's `timebase`, `settings.fps` and `settings.sampleRate` to calculate ticks; do not infer them from the example. Invalid ranges fail before output publication.

## GIF timing and color

GIF contains no audio and stores frame delays in centiseconds. Frame rates such as 30 or 30000/1001 require quantized alternating delays; exact rational timestamps cannot be represented. The engine preserves the requested image count and validates duration with frame tolerance. Rates above 100 fps are rejected. Palette conversion and dithering can change colors and produce visible palette changes between frames. Use PNG or FFV1 for lossless frames.

## PNG sequence ZIP

The single output ZIP contains `frame-00000001.png`, ascending numbered frames, and `manifest.json`. Its manifest records the project raster, rational fps, requested/resolved tick range, source frame indices, sample coordinates, frame count and each PNG's byte count/SHA-256. No audio is included. A separate WAV export can use the same video range's recorded sample coordinates when needed.

Frames are streamed into a standard ZIP; ZIP64 is used automatically when needed. Entry order and timestamps are fixed, and the manifest contains no creation timestamp. Repeating the same snapshot and software rendering environment produces identical archive bytes. Each frame is validated for signature, dimensions, regular-file status and checksum; checksums are verified again while packaging. Paths from external manifests are never accepted.

A ZIP supports up to 100,000 frames, with a 512 MiB bound per encoded PNG. Export longer programs in ranges. Packaging requires scratch space for both the PNGs and archive plus a 64 MiB reserve. Scratch frames and incomplete archives are cleaned on failure or cancellation; the previous published output is preserved.

## Hardware selection and fallback

The capability response distinguishes `compiled` from `usable`. Usability requires encoding an actual bounded test frame, so a compiled NVENC/QSV/AMF/VideoToolbox entry is not evidence of an available GPU or driver. Software H.264/HEVC/VP9/FFV1/GIF/PNG are tested too. Probes run at most two at a time, each with a ten-second deadline; results are cached briefly.

H.264 and HEVC support explicit NVENC, QSV, AMF and VideoToolbox choices when the installed FFmpeg and device pass their probes. VideoToolbox software emulation is disabled for hardware probes and rendering. Hardware paths use a bitrate target (default 6M); CRF controls apply to software encoders.

```json
{"encoder": {"name": "hevc_nvenc", "allowSoftwareFallback": true}}
```

Software is the default. A hardware request without fallback permission fails if its probe fails. With explicit permission, an unavailable hardware encoder selects the preset's software encoder and records the reason. The returned `encoder` object states `requested`, `selected`, `hardware`, `fallback` and an optional reason. A failure after encoding begins fails the job; there is no silent retry with a different encoder.

Export history persists the exact range and actual selected encoder. Reproduction requests the previously selected encoder with fallback disabled, even if the original request allowed fallback. Unavailable recorded hardware must fail. Hardware output reproducibility additionally depends on the device and driver; matching Node and FFmpeg alone does not establish identical hardware.

## Acceptance evidence

Real FFmpeg tests encode and decode HEVC, GIF, PNG ZIP, H.264, VP9, FFV1 and WAV. They verify packet/frame counts, nonzero range selection, silent/video-only stream contracts, PNG first/last frame colors and exact stateful WAV slices. Independent ZIP parsing verifies standard and forced ZIP64 end records, filenames, hashes and byte-identical repeat packaging. Boundary tests reject unexpected entries, symlinks, malformed dimensions, invalid counts and cancelled exports.

Modern and legacy HTTP MCP tests verify capability discovery, range persistence, unchanged canonical projects, actual fallback selection and replay. A simulated historical hardware receipt verifies rejection when its recorded device is unavailable; this is not proof of a successful physical GPU encode. The bundled CLI/Chromium workflow exercises browser PNG/GIF range exports and saved ZIP replay plus an MCP HEVC export. Cross-platform CI is the release gate.

Primary implementation references: [FFmpeg trimming](https://ffmpeg.org/ffmpeg-filters.html#trim), [FFmpeg encoding](https://ffmpeg.org/ffmpeg-codecs.html#libx265), [FFmpeg image sequences](https://ffmpeg.org/ffmpeg-formats.html#image2-1), and [yazl's streaming ZIP/ZIP64 contract](https://github.com/thejoshwolfe/yazl).
