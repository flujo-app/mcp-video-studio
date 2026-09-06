# Portable color LUTs

Import a `.cube` file using **Import media**, with **Link source** off. In the clip inspector, add a `lut3d` video effect, select the imported **Color LUT**, and choose tetrahedral or trilinear interpolation. Build the program preview to see the result. Disabling, reordering, undoing or removing the effect uses the ordinary durable clip edit workflow.

MCP clients use `import_media` with `storageMode: "managed"`, then `update_clip` or the normal command API with an effect such as:

```json
{"id":"color-grade","type":"lut3d","enabled":true,"version":1,"parameters":{"mediaId":"ID returned by import_media","interpolation":"tetrahedral"}}
```

Send the current `expectedRevision` with each mutation. Effect parameters accept only the imported media ID and the two named interpolation methods. Raw file paths, URLs and FFmpeg expressions are rejected. Import a replacement LUT as another managed asset and select it in the effect; LUT assets cannot be relinked to external files or inserted as audiovisual clips.

The supported IRIDAS `.cube` subset contains one `LUT_3D_SIZE` from2 through65, exactly size-cubed RGB triples, and optional unique `TITLE`, `DOMAIN_MIN` and `DOMAIN_MAX` headers. Decimal components must be finite and between-64 and64, with increasing domains on each axis. Comments are removed. Files are limited to16 MiB; 1D/shaper LUTs, external references, unknown directives and extra or missing samples are rejected. Rendering admits at most32 distinct LUTs and64 MiB of normalized LUT data.

The renderer validates file handles and content, then writes normalized LUT data into its owned scratch directory. FFmpeg reads that immutable render input. Whole renders, program previews and cached ranges use the same LUT filter; the LUT hash participates in direct and nested cache keys and saved export source provenance. The source is checked again before publication. A historical replay fails if its LUT changed, preserving an existing delivery.

Project archives include managed LUT bytes and validate their checksums when relocated. Tests cover malformed inputs, FIFO/cancellation bounds, real color inversion and whole/range equality, nested source changes, archive relocation and replay refusal after source changes. A nested 8-bit RGB/YUV composition may add up to3 levels of conversion rounding per tested component; same-depth relocated output and whole/range comparisons remain exact in the fixture.

Format/filter reference: [FFmpeg lut3d documentation](https://ffmpeg.org/ffmpeg-filters.html#lut3d-1). These bounded color controls do not claim HDR mastering or color-managed reference-monitor calibration.
