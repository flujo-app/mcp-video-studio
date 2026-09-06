# Local speech fixture

voiceover.wav was synthesized offline with FFmpeg's Flite filter (slt voice), at 24 kHz mono signed 16-bit PCM. Text authored for this test: Studio voiceover acceptance. Music stays below this narration. Review the final mix before export. No recorded person, account, provider request or proprietary media is used.

Regenerate on a FFmpeg build with Flite: ffmpeg -f lavfi -i "flite=text='Studio voiceover acceptance. Music stays below this narration. Review the final mix before export.':voice=slt" -ar 24000 -ac 1 -c:a pcm_s16le voiceover.wav
