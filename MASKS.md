# Geometric clip masks

Clip finishing includes rectangle and ellipse masks. Add one in the Clip inspector, edit its numeric controls, then choose **Apply mask** and **Build preview**. Enable/disable and removal are revision-checked edits with durable undo/redo. The keyboard can reach every native input and action.

`set_clip_mask` exposes the same operation through MCP. Supply projectPath, expectedRevision, sequenceId, clipId and parameters. Omit maskId to create; supply an existing maskId to replace; parameters:null removes that mask. Other clip effects are retained. The enabled field defaults to true, so pass false when keeping an edited mask disabled.

## Geometry and rendering

x, y, width and height are fractions of the transformed clip rectangle, after crop, scale and rotation. Bounds must fit inside that rectangle. Rectangle/ellipse coverage multiplies the alpha already present at this stage; opacity scales the coverage and invert keeps the outside instead of the inside. Multiple masks intersect and run after color effects, regardless of their positions in the effect stack. Disabled masks do not affect the image.

Feather is an inward fade measured as a fraction of the smaller transformed image dimension. Rectangle feather uses distance to the nearest edge; ellipse feather uses radial distance scaled by the smaller radius. It is limited to half the smaller normalized mask dimension. Defaults are a centered half-width/half-height rectangle, no feather, full opacity and no inversion.

Preview and export use the same renderer. The filter extracts alpha before its grayscale coverage calculation and merges it back into the original color image. This avoids the one-level alpha rounding observed in FFmpeg's packed-to-planar RGB conversion. No user-provided expression or path enters the generated coverage expression. [FFmpeg's documented alpha extraction, geq and alpha merge filters](https://ffmpeg.org/ffmpeg-filters.html) provide these operations.

Masks are scalar geometry, with no animated path, freehand editing, tracking, or compositing-group contract. A nested sequence is composited internally before it reaches its parent's clip mask; nested output does not introduce a new transparent-sequence format.

## Evidence

- Schema and transactional rejection of malformed or out-of-bounds geometry.
- Actual modern and deliberate legacy MCP create/replace/remove, stale revision rejection, unrelated effect retention and durable undo.
- Real FFmpeg raw RGBA checks for rectangle/ellipse, feather, inverse, original transparency and unchanged RGB.
- Real nested clip pixels, exact lossless full/range frames, unchanged range pixels, cache invalidation, preview/final parity and durable undo/redo.
- Built Studio browser controls, decoded program pixels and automated WCAG checks. The broader unfamiliar-human usability and assistive-technology acceptance remains external.
