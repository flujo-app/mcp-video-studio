# Generated content and review

Open **Generate** to create narration, music, captions, or a declarative animation in a selected timeline slot. Provider credentials come from the server environment. Generated voices are AI-generated; disclose this when sharing narration with listeners.

## Drafts and versions

All generation and regeneration produces a saved draft. **Automatically activate** is an explicit opt-in and defaults to false in the editor and MCP tools. Approval also activates a version. If automatic activation conflicts with the current timeline, the completed output remains a draft with `AUTO_ACTIVATE_CONFLICT`; it can still be reviewed.

In a generated artifact's review card, choose a parent version, edit its script or prompt, select a range, and enable **Regenerate only this range**. A/B selectors display scripts, models, captions, animation previews, and review notes. Narration/music audition plays only the chosen range, including composed source segments. Stop, switching auditions, changing the review position, and closing the card stop its audio. Notes, versions, and active selection survive reopening and a fresh MCP connection.

**Activate / revert to this version** changes the timeline to any saved version. A new generated clip is created only at explicit activation in an empty slot. Existing clip effects, transforms, audio mix, and unrelated clips are preserved. Region boundaries split bound clips through the timeline editor's split logic. Changed sources replace only the selected composition segments. If a bound clip was trimmed incompatibly or a required split crosses a grouped/linked clip, activation fails transactionally with an explanation; restore the slot duration or ungroup/unlink before retrying. Locked tracks cannot be changed. Human-deleted bindings are removed from the artifact.

## MCP region workflow

Use `generate_narration`, `generate_music`, `generate_captions`, or `generate_animation`, with the current `expectedRevision` and slot's sequence, track, start, and duration. Save the returned artifact/version/job IDs. Poll the job and retrieve `list_generated_artifacts` after completion. Requests may use `autoActivate: true` when activation is wanted.

`regenerate_generated_artifact` accepts `parentVersionId`, optional `requestPatch`, optional `region: {offsetTick, durationTick}`, and `autoActivate`. Region offsets are relative to the artifact slot, not the sequence. Omitting a region regenerates the full slot. One second is 35,280,000 ticks. A region must stay inside the artifact and each generation request is limited to ten minutes; caption and animation timings align to the project frame grid. The server preserves source composition outside a partial region. Captions use the latest saved parent when the provider finishes so outside caption edits made during generation survive.

Use `review_generated_version` to activate, approve, or reject a saved version. The human editor uses the same revision-checked operations. Existing pending jobs continue independently of the client connection; persisted projects can be opened through modern `2026-07-28` or legacy `2025-11-25` MCP sessions.

## Audio and provider compatibility

Narration and music are normalized into managed 48 kHz stereo, 16-bit PCM WAV assets. They are trimmed or padded with silence to exactly fit the requested slot. Review the result before activation: long scripts can be cut, and short scripts can leave silence. OpenAI narration is limited to 4,096 characters per request. ElevenLabs music prompt mode requests at least three seconds and then fits shorter selected slots; its prompt limit is 4,100 characters and prompt mode does not accept a seed.

OpenAI container formats are MP3, Opus, AAC, FLAC, and WAV. Its raw PCM format is explicitly decoded as 24 kHz mono signed 16-bit little endian. ElevenLabs supports its MP3/Opus/WAV formats, mono `pcm_<sample-rate>` formats, and 8 kHz mu-law/A-law. Raw audio never relies on a WAV filename for decoding. `requestPatch.outputFormat` changes provider output format; managed timeline assets still use normalized WAV.

Caption generation uploads only the extracted region as mono 16 kHz WAV, limited to 25 MB. `parameters.sourceOffsetTick` offsets the artifact within its source media; partial region offsets are added to it. OpenAI caption word timestamps use `whisper-1`. Models that lack the required timestamp response are rejected on the official endpoint. ElevenLabs captions use `scribe_v2` by default. Narration defaults remain `tts-1` and `eleven_multilingual_v2`; music uses `music_v2`. All models and compatible endpoint bases are configurable. `tts-1` and `tts-1-hd` reject speech instructions locally because those models do not support them. ElevenLabs voice settings are restricted to documented numeric ranges and boolean speaker boost.

Provider models, access, quality, and plan entitlements remain vendor-dependent. The automated suite uses a real local HTTP provider fixture and actual FFmpeg/Chromium, without spending credits. Live provider quality and credentials must be verified in the deployment account. End-of-2026 readiness is conditional on the vendor continuing to offer the configured models.

References checked September 6, 2026: [OpenAI Audio API](https://platform.openai.com/docs/api-reference/audio), [OpenAI speech formats](https://platform.openai.com/docs/guides/text-to-speech), [ElevenLabs models](https://elevenlabs.io/docs/overview/models), [speech endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [voice settings](https://github.com/elevenlabs/skills/blob/main/text-to-speech/references/voice-settings.md), and [music endpoint](https://elevenlabs.io/docs/api-reference/music/compose/).

## Credentials and acceptance evidence

Configured provider keys and credential-shaped input fields cannot be saved in generation requests or annotations. Known raw and encoded key echoes are redacted from provider text/JSON, or rejected before binary/decoded output persistence. Provider error bodies and request-ID headers are not exposed. Temporary extraction/normalization files are owned by the operation and removed on success, cancellation, or failure. User-authorized generation still sends its script, prompt, or selected source audio to the configured provider.

`generation-runtime.integration.test.ts` exercises all four kinds over actual HTTP, fresh modern/legacy clients, partial drafts, explicit activation conflicts, a pending caption edit race, selected audio frequency, animation activation/reversion, and raw/encoded/mislabelled provider secret echoes. `generation-regions.test.ts` checks persistent split bindings, outside edits, reopening, every-version revert, and transactional conflicts. `generation-audio.integration.test.ts` verifies raw decoders, exact padding/trimming and temporary-file cleanup. `generation-browser.integration.test.ts` opens the built CLI's saved project and exercises human regeneration, real A/B playback and automatic stopping, comparisons, notes, activation/reversion, caption/animation pixels, reload, and accessibility.

Run the integration tests with `RUN_FFMPEG_INTEGRATION=1` and `RUN_BROWSER_INTEGRATION=1` after `npm run build` and installing FFmpeg plus Patchright Chromium. These are also included in the Linux, Windows, and macOS Node 22/24 CI matrix.
