# Declarative animation editing and rendering

Studio provides an animation hierarchy, canvas picking, arrow-key movement, parent-group selection, text/geometry/transform controls, frame scrubbing, embedded image/video import and operation/keyframe editing. All changes use the same revision-checked node/operation commands as MCP and retain durable undo/redo.

The editor and export browser use the same canvas painter. Supported nodes are groups, text, rectangles, ellipses, lines, SVG paths, embedded images/videos, one active camera and seeded particles. Groups compose transforms and opacity; camera transforms pan/rotate/zoom the scene. The write operation reveals graphemes. SVG morphs interpolate matching command layouts; convert arc commands to cubic curves before morphing. Property keyframes animate geometry, camera zoom, font/particle size and hexadecimal fill/stroke colors.

Images/videos must be self-contained PNG/JPEG/WebP/MP4/WebM base64 data URLs, limited to 12 MiB per encoded URL (the browser upload limit is 9 MiB). Remote/file URLs are rejected. Video nodes use their explicit source time plus animation time and hold the final source frame. This keeps the animation artifact portable and offline. Asset decode and seeking have 10-second deadlines. Documents support at most 2,000 nodes, 10,000 operations, 4K pixels and 108,000 rendered frames.

Particles derive their positions from the document seed, node ID and requested time; rendering does not depend on earlier playback. HTML animations remain isolated and must implement the deterministic frame hook described in the README. Repeatability is checked with the installed Chromium/font set; font changes can alter text rasterization.

The production acceptance test renders grouped SVG morphs, kinetic text, camera motion and particles over 40 frames; it checks transparency, repeated decoded-pixel identity and editor/export sampled-pixel parity within one 8-bit premultiplication rounding bit. A real MCP-launched browser test covers hierarchy/canvas/property/keyframe changes, reopening, undo/redo and WCAG axe checks. Clip trim/speed/transition acceptance remains tracked separately in ACCEPTANCE.md.
