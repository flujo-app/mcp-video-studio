import path from "node:path";
import { loadConfig, runChecked } from "@mcp-video-studio/media";
/** Prepared inputs only: editor acceptance performs every project mutation through its UI. */
export async function coreEditingFixture(root: string) {
  const config = loadConfig({
    ...process.env,
    VIDEO_STUDIO_DATA_DIR: root,
    VIDEO_STUDIO_GATEWAY_PORT: "0",
  });
  const video = path.join(root, "Provided video.mp4"),
    audio = path.join(root, "Provided music.wav"),
    image = path.join(root, "Provided still.png");
  await runChecked(config.ffmpegPath, [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=160x90:r=30",
    "-t",
    "36",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    video,
  ]);
  await runChecked(config.ffmpegPath, [
    "-hide_banner",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=220:sample_rate=48000:duration=60",
    "-c:a",
    "pcm_s16le",
    audio,
  ]);
  await runChecked(config.ffmpegPath, [
    "-hide_banner",
    "-y",
    "-i",
    video,
    "-frames:v",
    "1",
    image,
  ]);
  return { video, audio, image };
}

/** Read-only inspection of the delivered artifact; does not edit the production. */
export async function verifyMinuteDelivery(root: string, output: string) {
  const config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root });
  const { stdout } = await runChecked(config.ffprobePath, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    output,
  ]);
  const info = JSON.parse(stdout) as {
    streams: Array<Record<string, any>>;
    format: { duration: string };
  };
  const video = info.streams.find((stream) => stream.codec_type === "video"),
    audio = info.streams.find((stream) => stream.codec_type === "audio");
  if (
    !video ||
    video.codec_name !== "h264" ||
    video.width !== 1920 ||
    video.height !== 1080 ||
    video.r_frame_rate !== "30/1" ||
    Number(video.nb_frames) !== 1800
  )
    throw new Error(
      "Minute video delivery contract failed: " + JSON.stringify(video),
    );
  if (
    !audio ||
    audio.codec_name !== "aac" ||
    audio.sample_rate !== "48000" ||
    audio.channels !== 2
  )
    throw new Error(
      "Minute audio delivery contract failed: " + JSON.stringify(audio),
    );
  if (
    !Number.isFinite(Number(info.format.duration)) ||
    Math.abs(Number(info.format.duration) - 60) > 0.001
  )
    throw new Error("Minute duration contract failed");
  return {
    video: {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      frames: Number(video.nb_frames),
      fps: video.r_frame_rate,
    },
    audio: {
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
    },
  };
}
