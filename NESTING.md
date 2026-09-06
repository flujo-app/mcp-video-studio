# Reusable sequences

In Editing workflows, create or rename a sequence, switch the current sequence, and insert another sequence at the playhead. MCP clients use create_sequence and insert_nested_sequence; lifecycle commands are also available through apply_commands. Every edit checks the expected project revision and participates in durable undo/redo.

A nested clip renders its source sequence with picture, captions and mixed audio, using the project raster, frame rate, background and a lossless FFV1/FLAC Matroska preset. It supports source trim, playback speed, clip transforms, video effects and audio processing through the same clip renderer. Nested outputs are internal scratch files; parent and child cache entries include reachable source hashes and sequence/animation dependencies. A child edit invalidates its uses while unrelated parent ranges stay reusable. Audio-only exports include nested audio.

Cycles, missing source sequences, nesting beyond eight levels and dependency inspections over 100,000 clips fail before project publication. Shared dependency graphs are memoized. Source handle checks reject parent trims or speed changes beyond the child duration. Removing a referenced sequence is rejected. Rendering uses the parent's expected revision so concurrent project changes cannot silently mix revisions.

Validation: tests/nesting.test.ts covers cycles, disabled references, depth and shared DAGs; tests/nested-sequences.integration.test.ts renders nested AV and audio-only outputs, verifies actual changed pixels and cache invalidation, and checks atomic failures/undo. tests/sequence-workflow.integration.test.ts exercises real Chromium and SDK2 MCP creation, switching, insertion, reload, conflicts and accessibility.
