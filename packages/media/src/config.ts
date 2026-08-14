import { mkdir, stat, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "./process.js";

export interface StudioConfig {
  dataDir: string;
  projectsDir: string;
  scratchDir: string;
  ffmpegPath: string;
  ffprobePath: string;
  defaultFontFile?: string;
  maxConcurrentJobs: number;
  cacheMaxBytes: number;
  gatewayHost: string;
  gatewayPort: number;
  publicOrigin?: string;
  providers: {
    language: { baseUrl: string; model: string; protocol: "responses" | "chat_completions"; apiKey?: string };
    openaiAudio: { baseUrl: string; speechModel: string; transcriptionModel: string; voice: string; apiKey?: string };
    elevenLabs: { baseUrl: string; speechModel: string; transcriptionModel: string; musicModel: string; voiceId?: string; apiKey?: string };
  };
}

function integerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(env[name]);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StudioConfig {
  const dataDir = path.resolve(env.VIDEO_STUDIO_DATA_DIR?.trim() || path.join(os.homedir(), ".mcp-video-studio"));
  const defaultFontFile = env.VIDEO_STUDIO_DEFAULT_FONT_FILE?.trim();
  const publicOrigin = env.VIDEO_STUDIO_PUBLIC_ORIGIN?.trim();
  const openaiBaseUrl = (env.VIDEO_STUDIO_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, "");
  const openaiApiKey = env.VIDEO_STUDIO_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const elevenLabsApiKey = env.VIDEO_STUDIO_ELEVENLABS_API_KEY?.trim() || env.ELEVENLABS_API_KEY?.trim();
  const elevenLabsVoiceId = env.VIDEO_STUDIO_ELEVENLABS_VOICE_ID?.trim();
  return {
    dataDir,
    projectsDir: path.resolve(env.VIDEO_STUDIO_PROJECTS_DIR?.trim() || path.join(dataDir, "projects")),
    scratchDir: path.resolve(env.VIDEO_STUDIO_SCRATCH_DIR?.trim() || path.join(dataDir, "scratch")),
    ffmpegPath: env.VIDEO_STUDIO_FFMPEG_PATH?.trim() || "ffmpeg",
    ffprobePath: env.VIDEO_STUDIO_FFPROBE_PATH?.trim() || "ffprobe",
    ...(defaultFontFile ? { defaultFontFile: path.resolve(defaultFontFile) } : {}),
    maxConcurrentJobs: integerEnv(env, "VIDEO_STUDIO_MAX_CONCURRENT_JOBS", 2, 1, 16),
    cacheMaxBytes: integerEnv(env, "VIDEO_STUDIO_CACHE_MAX_BYTES", 20 * 1024 * 1024 * 1024, 256 * 1024 * 1024, Number.MAX_SAFE_INTEGER),
    gatewayHost: env.VIDEO_STUDIO_GATEWAY_HOST?.trim() || "127.0.0.1",
    gatewayPort: integerEnv(env, "VIDEO_STUDIO_GATEWAY_PORT", 0, 0, 65535),
    ...(publicOrigin ? { publicOrigin } : {}),
    providers: {
      language: {
        baseUrl: (env.VIDEO_STUDIO_LANGUAGE_BASE_URL?.trim() || openaiBaseUrl).replace(/\/$/, ""),
        model: env.VIDEO_STUDIO_LANGUAGE_MODEL?.trim() || "gpt-5.6-terra",
        protocol: env.VIDEO_STUDIO_LANGUAGE_PROTOCOL === "chat_completions" ? "chat_completions" : "responses",
        ...(openaiApiKey ? { apiKey: openaiApiKey } : {})
      },
      openaiAudio: {
        baseUrl: openaiBaseUrl,
        speechModel: env.VIDEO_STUDIO_OPENAI_SPEECH_MODEL?.trim() || "tts-1",
        transcriptionModel: env.VIDEO_STUDIO_OPENAI_TRANSCRIPTION_MODEL?.trim() || "whisper-1",
        voice: env.VIDEO_STUDIO_OPENAI_VOICE?.trim() || "alloy",
        ...(openaiApiKey ? { apiKey: openaiApiKey } : {})
      },
      elevenLabs: {
        baseUrl: (env.VIDEO_STUDIO_ELEVENLABS_BASE_URL?.trim() || "https://api.elevenlabs.io/v1").replace(/\/$/, ""),
        speechModel: env.VIDEO_STUDIO_ELEVENLABS_SPEECH_MODEL?.trim() || "eleven_multilingual_v2",
        transcriptionModel: env.VIDEO_STUDIO_ELEVENLABS_TRANSCRIPTION_MODEL?.trim() || "scribe_v2",
        musicModel: env.VIDEO_STUDIO_ELEVENLABS_MUSIC_MODEL?.trim() || "music_v2",
        ...(elevenLabsVoiceId ? { voiceId: elevenLabsVoiceId } : {}),
        ...(elevenLabsApiKey ? { apiKey: elevenLabsApiKey } : {})
      }
    }
  };
}

export function providerStatus(config: StudioConfig): Record<string, unknown> {
  const origin = (value: string) => { try { return new URL(value).origin; } catch { return value; } };
  const usable = (value: string, apiKey: string | undefined) => {
    if (apiKey) return true;
    try { return !["api.openai.com", "api.elevenlabs.io"].includes(new URL(value).hostname.toLowerCase()); } catch { return false; }
  };
  return {
    language: { configured: usable(config.providers.language.baseUrl, config.providers.language.apiKey), baseUrl: origin(config.providers.language.baseUrl), model: config.providers.language.model, protocol: config.providers.language.protocol, capabilities: ["structured_generation", "animation"] },
    openaiAudio: { configured: usable(config.providers.openaiAudio.baseUrl, config.providers.openaiAudio.apiKey), baseUrl: origin(config.providers.openaiAudio.baseUrl), speechModel: config.providers.openaiAudio.speechModel, transcriptionModel: config.providers.openaiAudio.transcriptionModel, voice: config.providers.openaiAudio.voice, capabilities: ["narration", "captions"] },
    elevenLabs: { configured: usable(config.providers.elevenLabs.baseUrl, config.providers.elevenLabs.apiKey), baseUrl: origin(config.providers.elevenLabs.baseUrl), speechModel: config.providers.elevenLabs.speechModel, transcriptionModel: config.providers.elevenLabs.transcriptionModel, musicModel: config.providers.elevenLabs.musicModel, voiceConfigured: Boolean(config.providers.elevenLabs.voiceId), capabilities: ["narration", "captions", "music"] }
  };
}

async function binaryDiagnostic(executable: string, args: string[]): Promise<Record<string, unknown>> {
  try {
    const result = await runProcess(executable, args, { timeoutMs: 15_000, maxOutputChars: 80_000 });
    const firstLine = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find(Boolean) ?? "";
    return { available: result.exitCode === 0, executable, version: firstLine, exitCode: result.exitCode };
  } catch (error) {
    return { available: false, executable, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function doctor(config: StudioConfig = loadConfig()): Promise<Record<string, unknown>> {
  await Promise.all([mkdir(config.dataDir, { recursive: true }), mkdir(config.projectsDir, { recursive: true }), mkdir(config.scratchDir, { recursive: true })]);
  const [ffmpeg, ffprobe, disk, filters, encoders] = await Promise.all([
    binaryDiagnostic(config.ffmpegPath, ["-hide_banner", "-version"]),
    binaryDiagnostic(config.ffprobePath, ["-hide_banner", "-version"]),
    statfs(config.scratchDir).catch(() => undefined),
    runProcess(config.ffmpegPath, ["-hide_banner", "-filters"], { timeoutMs: 15_000, maxOutputChars: 500_000 }).catch(() => undefined),
    runProcess(config.ffmpegPath, ["-hide_banner", "-encoders"], { timeoutMs: 15_000, maxOutputChars: 500_000 }).catch(() => undefined)
  ]);
  let font: Record<string, unknown> = { configured: false };
  if (config.defaultFontFile) {
    try { font = { configured: true, path: config.defaultFontFile, bytes: (await stat(config.defaultFontFile)).size }; }
    catch (error) { font = { configured: true, path: config.defaultFontFile, error: error instanceof Error ? error.message : String(error) }; }
  }
  return {
    ok: ffmpeg.available === true && ffprobe.available === true,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    config: { dataDir: config.dataDir, projectsDir: config.projectsDir, scratchDir: config.scratchDir, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath, defaultFontFile: config.defaultFontFile ?? null, maxConcurrentJobs: config.maxConcurrentJobs, cacheMaxBytes: config.cacheMaxBytes, gatewayHost: config.gatewayHost, gatewayPort: config.gatewayPort, publicOrigin: config.publicOrigin ?? null, providers: providerStatus(config) },
    ffmpeg,
    ffprobe,
    capabilities: {
      filters: Object.fromEntries(["drawtext", "xfade", "rubberband", "loudnorm", "subtitles", "chromakey", "sidechaincompress"].map((name) => [name, filters?.stdout.includes(name) ?? false])),
      encoders: Object.fromEntries(["libx264", "libx265", "libvpx-vp9", "ffv1", "aac", "libopus", "h264_nvenc", "h264_qsv", "h264_amf"].map((name) => [name, encoders?.stdout.includes(name) ?? false]))
    },
    font,
    scratch: disk ? { path: config.scratchDir, freeBytes: disk.bavail * disk.bsize, totalBytes: disk.blocks * disk.bsize } : { path: config.scratchDir }
  };
}
