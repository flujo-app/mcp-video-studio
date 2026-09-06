# Render ranges and parity

Sequences longer than 30 seconds, or with more than 32 visual clips, use frame-aligned video ranges. The default is about ten seconds per range, with at most 3,600 ranges for very long projects. Each range stores lossless FFV1 video after compositing, effects, transitions, captions and optional preview scaling. Its key includes only intersecting visual content and the source checksums it uses. A video-only edit reuses unaffected video ranges.

Audio processing stays continuous across the full sequence. Stateful compression, filtering and loudness normalization are never restarted at a video range boundary. Its independently keyed float WAV cache preserves the sample timeline, and can be reused when an edit affects only video. RF64 supports audio caches larger than the classic WAV limit.

The final container is encoded from cached video and continuous audio. Publishing a changed deliverable still reads and encodes its full duration; expensive source decoding, animation, visual processing and audio DSP are reused according to their dependencies. No caller-authored filter graph is needed.

Video-range and audio-mix cache reads verify file checksums. A running job pins each input through a hard link (or a copy across filesystems) so eviction cannot invalidate an already pinned input. The configured VIDEO_STUDIO_CACHE_MAX_BYTES budget covers video, audio, final and animation render artifacts; the default is 20 GiB. Scratch files are removed on success, error and cancellation. Exports preserve an existing destination until replacement succeeds and refuse to overwrite a media source.

## Parity limits

The range-cache.integration.test.ts fixture uses actual video, transformed clips, a centered transition, captions spanning range boundaries, audio and continuous track compression.

- Decoded video pixels match the whole-sequence lossless reference byte for byte.
- Audio sample counts match exactly. Maximum decoded amplitude difference is one 24-bit PCM step (1 / 8,388,608), covering integer encoder rounding after the float cache.
- The range invalidation fixture edits one clip and proves earlier ranges and the audio mix are reused.
- long-project.integration.test.ts exercises a 30-minute, 901-clip mixed-media project with video proxies, 54,000-frame output and a real browser edit. It runs separately on Linux Node 22 CI.

A program preview and final export share the same renderer. Preview scaling or lossy output codecs require their own expected image/audio tolerances; no real-time browser audio-effects parity is claimed.
