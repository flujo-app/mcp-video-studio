# Caption finishing

Studio and MCP import/export SRT, WebVTT and ASS. Import cues in Editing workflows; select a caption by pointer, Enter or Space; change its text, timing, font, alignment, color, outline, shadow and margins in the inspector. All updates are revision checked and undoable. Burn-in uses the same renderer for previews and exports.

Import a standalone .ttf or .otf through the media bin or import_media and choose it under Caption font. Managed imports survive removal of the original font file and travel with project archives. Linked fonts remain external until consolidated. OpenType table directories are bounded to 16 MiB and checked before font decoding. WOFF/font collections require conversion first. System fallback fonts depend on the machine; choose a managed font for reproducible typography. Font hashes participate in parent/nested/range render caches and are rechecked before output publication.

ASS v4.00+ interchange supports project-scaled font size/margins, primary and box colors including alpha, outline/shadow, nine-way alignment, comma text, hard/soft breaks and hard spaces. Sidecars declare project PlayResX/PlayResY. Dialogue timing maps to the frame grid. Import rejects attachments, effects, inline override tags, styled bold/italic/underline/strikeout, transformed typography and missing styles instead of silently discarding them. These advanced ASS features require flattening in the source or an animation title. ASS boxes use OutlineColour as defined by the format; BackColour is the shadow color. A box combined with an independent outline/shadow, or literal braces/backslashes that change ASS parsing, requires SRT/WebVTT export. Font binaries remain project assets and are not embedded in an ASS sidecar.

Evidence: tests/ass.test.ts checks timing/style/text round trips and unsupported-input boundaries; tests/fonts.integration.test.ts verifies malformed font rejection, actual portable-font pixels, range parity and atomic missing-font rejection; tests/caption-finishing.integration.test.ts uses real Chromium and SDK2 MCP for font/ASS import, editing, sidecar export, reload and an axe WCAG scan.

Remaining finishing work: measured overflow/QC and safe-area overlay, broader caption/title production acceptance, and any advanced typography beyond the explicitly supported ASS subset. This checkpoint does not close the finishing epic.

Format references: https://aegisub.org/docs/latest/ass_tags/ and https://learn.microsoft.com/en-us/typography/opentype/spec/otff
