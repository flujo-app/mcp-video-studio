import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AnimationDocument, GenerationRequest, Rational } from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";
import type { StudioConfig } from "@mcp-video-studio/media";

export interface BinaryGenerationResult {
  data: Uint8Array;
  extension: string;
  mimeType: string;
  model: string;
  requestId?: string;
}

export interface TranscriptWord {
  text: string;
  startSeconds: number;
  endSeconds: number;
  speaker?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  words: TranscriptWord[];
  model: string;
  requestId?: string;
}

function headers(apiKey: string | undefined, kind: "bearer" | "elevenlabs"): Record<string, string> {
  if (!apiKey) return {};
  return kind === "bearer" ? { authorization: `Bearer ${apiKey}` } : { "xi-api-key": apiKey };
}

async function providerError(response: Response, provider: string): Promise<never> {
  const detail = (await response.text().catch(() => "")).slice(0, 8_000);
  throw new StudioException("PROVIDER_REQUEST_FAILED", `${provider} returned HTTP ${response.status}.`, response.status === 401 || response.status === 403 ? "policy" : "runtime", { provider, status: response.status, detail });
}

function requireCredential(apiKey: string | undefined, provider: string, baseUrl: string): void {
  let vendorEndpoint = true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    vendorEndpoint = host === "api.openai.com" || host === "api.elevenlabs.io";
  } catch { /* validation happens in fetch */ }
  if (!apiKey && vendorEndpoint) throw new StudioException("PROVIDER_NOT_CONFIGURED", `${provider} requires an API key. Configure it through the documented environment variable.`, "dependency", { provider });
}

function extensionFor(format: string | undefined, fallback = "mp3"): string {
  const normalized = format?.toLowerCase() ?? fallback;
  if (normalized.includes("wav") || normalized.includes("pcm")) return "wav";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("aac")) return "aac";
  return "mp3";
}

function mimeFor(extension: string): string {
  return extension === "wav" ? "audio/wav" : extension === "opus" ? "audio/ogg" : extension === "flac" ? "audio/flac" : extension === "aac" ? "audio/aac" : "audio/mpeg";
}

function parseJsonObject(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); }
  catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new StudioException("PROVIDER_INVALID_JSON", "The language provider did not return a JSON object.", "runtime");
  }
}

export class GenerationProviders {
  constructor(readonly config: StudioConfig) {}

  async synthesizeSpeech(request: GenerationRequest, signal?: AbortSignal): Promise<BinaryGenerationResult> {
    if (!request.text?.trim()) throw new StudioException("NARRATION_TEXT_REQUIRED", "Narration generation requires text.", "input");
    if (request.provider === "elevenlabs") {
      const provider = this.config.providers.elevenLabs;
      requireCredential(provider.apiKey, "ElevenLabs", provider.baseUrl);
      const voiceId = request.voiceId || provider.voiceId;
      if (!voiceId) throw new StudioException("VOICE_REQUIRED", "Configure VIDEO_STUDIO_ELEVENLABS_VOICE_ID or provide voiceId.", "input");
      const format = request.outputFormat || "mp3_44100_128";
      const response = await fetch(`${provider.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`, {
        method: "POST", signal: signal ?? null,
        headers: { ...headers(provider.apiKey, "elevenlabs"), "content-type": "application/json" },
        body: JSON.stringify({ text: request.text, model_id: request.model || provider.speechModel, ...(request.language ? { language_code: request.language } : {}), ...(request.seed !== undefined ? { seed: request.seed } : {}), ...(request.parameters ?? {}) })
      });
      if (!response.ok) return providerError(response, "ElevenLabs");
      const extension = extensionFor(format);
      return { data: new Uint8Array(await response.arrayBuffer()), extension, mimeType: response.headers.get("content-type") || mimeFor(extension), model: request.model || provider.speechModel, ...(response.headers.get("request-id") ? { requestId: response.headers.get("request-id")! } : {}) };
    }
    const provider = this.config.providers.openaiAudio;
    requireCredential(provider.apiKey, "OpenAI audio", provider.baseUrl);
    const format = request.outputFormat || "mp3";
    const response = await fetch(`${provider.baseUrl}/audio/speech`, {
      method: "POST", signal: signal ?? null,
      headers: { ...headers(provider.apiKey, "bearer"), "content-type": "application/json" },
      body: JSON.stringify({ model: request.model || provider.speechModel, voice: request.voiceId || provider.voice, input: request.text, response_format: format, ...(request.parameters ?? {}) })
    });
    if (!response.ok) return providerError(response, "OpenAI audio");
    const extension = extensionFor(format);
    return { data: new Uint8Array(await response.arrayBuffer()), extension, mimeType: response.headers.get("content-type") || mimeFor(extension), model: request.model || provider.speechModel, ...(response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id")! } : {}) };
  }

  async composeMusic(request: GenerationRequest, durationTick: number, signal?: AbortSignal): Promise<BinaryGenerationResult> {
    if (request.provider !== "elevenlabs") throw new StudioException("PROVIDER_CAPABILITY_MISSING", "Music generation currently requires the ElevenLabs provider.", "input");
    if (!request.prompt?.trim()) throw new StudioException("MUSIC_PROMPT_REQUIRED", "Music generation requires a prompt.", "input");
    const provider = this.config.providers.elevenLabs;
    requireCredential(provider.apiKey, "ElevenLabs", provider.baseUrl);
    const format = request.outputFormat || "mp3_48000_192";
    const durationMs = Math.max(3_000, Math.min(600_000, Math.round(durationTick / 35_280_000 * 1000)));
    const response = await fetch(`${provider.baseUrl}/music?output_format=${encodeURIComponent(format)}`, {
      method: "POST", signal: signal ?? null,
      headers: { ...headers(provider.apiKey, "elevenlabs"), "content-type": "application/json" },
      body: JSON.stringify({ prompt: request.prompt, music_length_ms: durationMs, model_id: request.model || provider.musicModel, force_instrumental: request.parameters?.forceInstrumental ?? true, ...(request.seed !== undefined ? { seed: request.seed } : {}) })
    });
    if (!response.ok) return providerError(response, "ElevenLabs Music");
    const extension = extensionFor(format);
    return { data: new Uint8Array(await response.arrayBuffer()), extension, mimeType: response.headers.get("content-type") || mimeFor(extension), model: request.model || provider.musicModel, ...(response.headers.get("request-id") ? { requestId: response.headers.get("request-id")! } : {}) };
  }

  async transcribe(request: GenerationRequest, filePath: string, signal?: AbortSignal): Promise<TranscriptionResult> {
    const bytes = await readFile(filePath);
    const form = new FormData();
    form.append("file", new Blob([bytes]), path.basename(filePath));
    if (request.provider === "elevenlabs") {
      const provider = this.config.providers.elevenLabs;
      requireCredential(provider.apiKey, "ElevenLabs", provider.baseUrl);
      form.append("model_id", request.model || provider.transcriptionModel);
      form.append("timestamps_granularity", "word");
      if (request.language) form.append("language_code", request.language);
      if (request.parameters?.diarize === true) form.append("diarize", "true");
      const response = await fetch(`${provider.baseUrl}/speech-to-text`, { method: "POST", signal: signal ?? null, headers: headers(provider.apiKey, "elevenlabs"), body: form });
      if (!response.ok) return providerError(response, "ElevenLabs Scribe");
      const data = await response.json() as { text?: string; language_code?: string; words?: Array<{ text?: string; start?: number; end?: number; speaker_id?: string; type?: string }> };
      const words = (data.words ?? []).filter((word) => word.type === undefined || word.type === "word").map((word) => ({ text: word.text ?? "", startSeconds: Number(word.start ?? 0), endSeconds: Number(word.end ?? word.start ?? 0), ...(word.speaker_id ? { speaker: word.speaker_id } : {}) })).filter((word) => word.text.trim());
      return { text: data.text ?? words.map((word) => word.text).join(" "), words, model: request.model || provider.transcriptionModel, ...(data.language_code ? { language: data.language_code } : {}), ...(response.headers.get("request-id") ? { requestId: response.headers.get("request-id")! } : {}) };
    }
    const provider = this.config.providers.openaiAudio;
    requireCredential(provider.apiKey, "OpenAI transcription", provider.baseUrl);
    form.append("model", request.model || provider.transcriptionModel);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    if (request.language) form.append("language", request.language);
    const response = await fetch(`${provider.baseUrl}/audio/transcriptions`, { method: "POST", signal: signal ?? null, headers: headers(provider.apiKey, "bearer"), body: form });
    if (!response.ok) return providerError(response, "OpenAI transcription");
    const data = await response.json() as { text?: string; language?: string; words?: Array<{ word?: string; text?: string; start?: number; end?: number }>; segments?: Array<{ text?: string; start?: number; end?: number }> };
    const rawWords: Array<{ text: string; start?: number; end?: number }> = data.words?.length
      ? data.words.map((word) => ({ text: word.word ?? word.text ?? "", ...(word.start !== undefined ? { start: word.start } : {}), ...(word.end !== undefined ? { end: word.end } : {}) }))
      : data.segments?.map((segment) => ({ text: segment.text ?? "", ...(segment.start !== undefined ? { start: segment.start } : {}), ...(segment.end !== undefined ? { end: segment.end } : {}) })) ?? [];
    const words = rawWords.map((word) => ({ text: word.text, startSeconds: Number(word.start ?? 0), endSeconds: Number(word.end ?? word.start ?? 0) })).filter((word) => word.text.trim());
    return { text: data.text ?? words.map((word) => word.text).join(" "), words, model: request.model || provider.transcriptionModel, ...(data.language ? { language: data.language } : {}), ...(response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id")! } : {}) };
  }

  async generateAnimation(request: GenerationRequest, input: { name: string; durationTick: number; canvas: { width: number; height: number }; fps: Rational }, signal?: AbortSignal): Promise<{ animation: AnimationDocument; model: string; requestId?: string }> {
    if (!request.prompt?.trim()) throw new StudioException("ANIMATION_PROMPT_REQUIRED", "Animation generation requires a prompt.", "input");
    const provider = this.config.providers.language;
    requireCredential(provider.apiKey, "Language provider", provider.baseUrl);
    const model = request.model || provider.model;
    const id = crypto.randomUUID();
    const system = "Return one JSON object only. Create an MCP Video Studio AnimationDocument. Use mode declarative and only reliably rendered node types text, rect, ellipse, and line. Use operations create, write, fade, transform, moveAlongPath, rotate, scale, or wait. All timing values are integer ticks; 35280000 ticks equal one second. Every id must be unique. Do not include markdown.";
    const prompt = `${request.prompt}\n\nRequired id: ${id}\nName: ${input.name}\nDuration ticks: ${input.durationTick}\nCanvas: ${input.canvas.width}x${input.canvas.height}, transparent background\nSeed: ${request.seed ?? 1}\nEach node needs properties and transform {position:[x,y],scale:[x,y],rotation,anchor:[x,y],opacity}. Each operation needs id,type,targetId,startTick,durationTick,easing,parameters.`;
    let response: Response;
    if (provider.protocol === "chat_completions") {
      response = await fetch(`${provider.baseUrl}/chat/completions`, { method: "POST", signal: signal ?? null, headers: { ...headers(provider.apiKey, "bearer"), "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], response_format: { type: "json_object" } }) });
    } else {
      response = await fetch(`${provider.baseUrl}/responses`, { method: "POST", signal: signal ?? null, headers: { ...headers(provider.apiKey, "bearer"), "content-type": "application/json" }, body: JSON.stringify({ model, instructions: system, input: prompt }) });
    }
    if (!response.ok) return providerError(response, "Language provider");
    const data = await response.json() as Record<string, unknown>;
    const text = provider.protocol === "chat_completions"
      ? String(((data.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]?.message?.content) ?? "")
      : String(data.output_text ?? (data.output as Array<{ content?: Array<{ text?: string }> }> | undefined)?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("") ?? "");
    const parsed = parseJsonObject(text) as AnimationDocument;
    const { html: _html, htmlAssetId: _htmlAssetId, ...declarative } = parsed;
    const animation: AnimationDocument = { ...declarative, id, name: input.name, durationTick: input.durationTick, canvas: { ...input.canvas, background: "transparent" }, seed: request.seed ?? parsed.seed ?? 1, mode: "declarative" };
    return { animation, model, ...(response.headers.get("x-request-id") ? { requestId: response.headers.get("x-request-id")! } : {}) };
  }
}
