# Video effect and frame parity

The program preview and final export use the same video filter graph. Preview H 264 uses a faster, lower-bitrate encoding profile, so compressed bytes and individual pixel values can differ. Lossless whole-sequence and range-cache output must match exactly.

`tests/video-effect-parity.integration.test.ts` applies each effect independently to the same moving 192×108,12 fps fixture. It compares every decoded RGB component of whole and 4-frame range FFV 1 renders, checks that enabled effects visibly change the image, and verifies that the disabled stack reproduces the input. It then compares the actual queued program preview against final H 264 delivery.

| Effect | Exercised parameters | Maximum mean absolute RGB error | Maximum RMS RGB error |
| --- | --- | --- | --- |
| color | brightness 0.1, contrast 1.2, saturation 0.4 | 3 | 8 |
| brightness | value 0.15 | 3 | 8 |
| blur | radius 4 | 3 | 8 |
| sharpen | amount 2 | 3 | 8 |
| vignette | angle 0.9 | 3 | 8 |
| chromaKey | green, similarity 0.2, blend 0 | 3 | 8 |
| grayscale | default | 3 | 8 |
| hflip | default | 3 | 8 |
| vflip | default | 3 | 8 |

Errors use 8-bit channel units across every decoded frame/component. On the tested FFmpeg 5.1 and 7.0.2 builds, measured mean absolute error was 0.913–2.332 and RMS was 2.080–5.180. These are acceptance tolerances for the fixture and the two H 264 profiles; they are not a promise of perceptual equality for every image.

Vignette's default spatial dither changes its random state when a new cached range starts. The shared renderer explicitly sets `dither=0` so independently rendered ranges produce identical pixels. This removes that noise and may make smooth vignette gradients show more banding. `VIDEO_EFFECTS_VERSION` invalidates prior video caches; audio caches are independent.

`tests/video-output-timing.integration.test.ts` verifies 31 actual encoded packets, decoded frames and raw RGB frames at 12,24 and 30000/1001 fps, both whole and 7-frame ranges. It also compares every lossless whole/range pixel. Range offsets and trims use integer frame PTS rather than decimal seconds. Final video encoding sets an explicit rational output rate and CFR mode; a mismatched encoded rate is rejected before publication. GIF has its own centisecond timing contract in the export-format documentation.

The original transform/transition gates additionally verify crop, scale, rotation/anchor, alpha/blend, source-handle-checked crossfades/wipes, fractional source rates and constant speeds. LUTs, geometric masks and time-remapping operations require their own independent fixtures as they are added. They are not covered by the nine-effect table.

## Transparency and geometric masks

Renderer effect version 3 invalidates older cached color processing. Color adjustments, sharpening and vignette retain the incoming alpha channel exactly; Gaussian blur processes alpha with the same spatial kernel, flips move all channels together, and chroma-key coverage multiplies the original alpha. This prevents vignette/key processing from making partially transparent clips opaque. The real RGBA regression covers an alpha gradient, blur geometry and keyed coverage; the nine-effect whole/range and measured H264 preview/final parity matrix remains enabled.

Rectangle and ellipse masks apply as a final clip visibility stage. Their scalar geometry, feather, inversion, opacity, Studio controls and typed MCP edit are described in [MASKS.md](MASKS.md).
