import { readFile, stat } from "node:fs/promises";
import { providerFetch } from "./provider-http.js";
import path from "node:path";
import type {
  AnimationDocument,
  GenerationRequest,
  Rational,
} from "@mcp-video-studio/contracts";
import { StudioException } from "@mcp-video-studio/core";
import type { StudioConfig } from "@mcp-video-studio/media";

export interface BinaryGenerationResult {
  data: Uint8Array;
  extension: string;
  mimeType: string;
  model: string;
  requestId?: string;
  rawAudio?: { encoding: "s16le" | "mulaw" | "alaw"; sampleRate: number };
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

function safeParameters(
  request: GenerationRequest,
  kind: "narration" | "music" | "captions" | "animation",
): Record<string, unknown> {
  const params = request.parameters ?? {};
  const allowed =
    kind === "narration"
      ? request.provider === "elevenlabs"
        ? ["voice_settings"]
        : ["speed", "instructions"]
      : kind === "music"
        ? ["forceInstrumental"]
        : kind === "captions"
          ? ["diarize", "sourceOffsetTick"]
          : [];
  if (Object.keys(params).some((key) => !allowed.includes(key)))
    throw new StudioException(
      "GENERATION_PARAMETERS",
      "Unsupported provider parameter; model, voice and payload fields must use their explicit tool arguments.",
      "input",
    );
  if (
    params.speed !== undefined &&
    (typeof params.speed !== "number" ||
      !Number.isFinite(params.speed) ||
      params.speed < 0.25 ||
      params.speed > 4)
  )
    throw new StudioException(
      "GENERATION_PARAMETERS",
      "Speech speed must be0.25..4.",
      "input",
    );
  if (
    params.instructions !== undefined &&
    (typeof params.instructions !== "string" ||
      params.instructions.length > 1000)
  )
    throw new StudioException(
      "GENERATION_PARAMETERS",
      "Speech instructions are limited to1000characters.",
      "input",
    );
  for (const key of ["forceInstrumental", "diarize"])
    if (params[key] !== undefined && typeof params[key] !== "boolean")
      throw new StudioException(
        "GENERATION_PARAMETERS",
        "Generation switches must be booleans.",
        "input",
      );
  if (params.voice_settings !== undefined) {
    const settings = params.voice_settings;
    if (!settings || typeof settings !== "object" || Array.isArray(settings))
      throw new StudioException(
        "GENERATION_PARAMETERS",
        "Voice settings must be an object.",
        "input",
      );
    for (const [key, value] of Object.entries(settings)) {
      if (key === "use_speaker_boost") {
        if (typeof value === "boolean") continue;
      } else if (
        ["stability", "similarity_boost", "style", "speed"].includes(key)
      ) {
        if (
          typeof value === "number" &&
          Number.isFinite(value) &&
          value >= (key === "speed" ? 0.25 : 0) &&
          value <= (key === "speed" ? 4 : 1)
        )
          continue;
      }
      throw new StudioException(
        "GENERATION_PARAMETERS",
        "Unsupported voice setting or value outside its documented range.",
        "input",
      );
    }
  }
  return params;
}

function headers(
  apiKey: string | undefined,
  kind: "bearer" | "elevenlabs",
): Record<string, string> {
  if (!apiKey) return {};
  return kind === "bearer"
    ? { authorization: `Bearer ${apiKey}` }
    : { "xi-api-key": apiKey };
}

async function providerError(
  response: Response,
  provider: string,
): Promise<never> {
  await response.body?.cancel().catch(() => undefined);
  throw new StudioException(
    "PROVIDER_REQUEST_FAILED",
    `${provider} returned HTTP ${response.status}.`,
    response.status === 401 || response.status === 403 ? "policy" : "runtime",
    {
      provider,
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    },
  );
}

function requireCredential(
  apiKey: string | undefined,
  provider: string,
  baseUrl: string,
): void {
  let vendorEndpoint = true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    vendorEndpoint = host === "api.openai.com" || host === "api.elevenlabs.io";
  } catch {
    /* validation happens in fetch */
  }
  if (!apiKey && vendorEndpoint)
    throw new StudioException(
      "PROVIDER_NOT_CONFIGURED",
      `${provider} requires an API key. Configure it through the documented environment variable.`,
      "dependency",
      { provider },
    );
}

function extensionFor(format: string | undefined, fallback = "mp3"): string {
  const normalized = format?.toLowerCase() ?? fallback;
  if (normalized.includes("wav") || normalized.includes("pcm")) return "wav";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("aac")) return "aac";
  return "mp3";
}

function audioFormat(
  format: string,
  provider: "openai" | "elevenlabs",
): Pick<BinaryGenerationResult, "rawAudio"> {
  const pcmRate =
    provider === "openai" && format === "pcm"
      ? 24000
      : /^pcm_(8000|16000|22050|24000|32000|44100|48000)$/.test(format)
        ? Number(format.slice(4))
        : undefined;
  if (pcmRate) return { rawAudio: { encoding: "s16le", sampleRate: pcmRate } };
  if (
    provider === "elevenlabs" &&
    (format === "ulaw_8000" || format === "alaw_8000")
  )
    return {
      rawAudio: {
        encoding: format === "ulaw_8000" ? "mulaw" : "alaw",
        sampleRate: 8000,
      },
    };
  if (
    provider === "openai"
      ? ["mp3", "opus", "aac", "flac", "wav"].includes(format)
      : /^(?:mp3_\d{4,5}_\d{2,3}|opus_48000_\d{2,3}|wav_(?:8000|16000|22050|24000|32000|44100|48000))$/.test(
          format,
        )
  )
    return {};
  throw new StudioException(
    "GENERATION_FORMAT",
    "Choose a supported container audio format or documented mono PCM/telephony format.",
    "input",
  );
}

function mimeFor(extension: string): string {
  return extension === "wav"
    ? "audio/wav"
    : extension === "opus"
      ? "audio/ogg"
      : extension === "flac"
        ? "audio/flac"
        : extension === "aac"
          ? "audio/aac"
          : "audio/mpeg";
}

async function providerJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new StudioException(
      "PROVIDER_INVALID_JSON",
      "Provider returned invalid JSON.",
      "runtime",
    );
  }
}
function parseJsonObject(value: string): unknown {
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{"),
      end = text.lastIndexOf("}");
    try {
      if (start >= 0 && end > start)
        return JSON.parse(text.slice(start, end + 1));
    } catch {}
    throw new StudioException(
      "PROVIDER_INVALID_JSON",
      "Language provider did not return a valid JSON object.",
      "runtime",
    );
  }
}

export class GenerationProviders {
  constructor(readonly config: StudioConfig) {}
  private fetch(url: string, init: RequestInit): Promise<Response> {
    return providerFetch(url, init, [
      this.config.providers.openaiAudio.apiKey ?? "",
      this.config.providers.elevenLabs.apiKey ?? "",
      this.config.providers.language.apiKey ?? "",
    ]);
  }

  async synthesizeSpeech(
    request: GenerationRequest,
    signal?: AbortSignal,
  ): Promise<BinaryGenerationResult> {
    const parameters = safeParameters(request, "narration");
    if ((request.text?.length ?? 0) > 4096)
      throw new StudioException(
        "NARRATION_LIMIT",
        "Narration is limited to4096characters per request; regenerate bounded sections.",
        "input",
      );
    if (!request.text?.trim())
      throw new StudioException(
        "NARRATION_TEXT_REQUIRED",
        "Narration generation requires text.",
        "input",
      );
    if (request.provider === "elevenlabs") {
      const provider = this.config.providers.elevenLabs;
      requireCredential(provider.apiKey, "ElevenLabs", provider.baseUrl);
      const voiceId = request.voiceId || provider.voiceId;
      if (!voiceId)
        throw new StudioException(
          "VOICE_REQUIRED",
          "Configure VIDEO_STUDIO_ELEVENLABS_VOICE_ID or provide voiceId.",
          "input",
        );
      const format = request.outputFormat || "mp3_44100_128";
      const formatInfo = audioFormat(format, "elevenlabs");
      const response = await this.fetch(
        `${provider.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(format)}`,
        {
          method: "POST",
          signal: signal ?? null,
          headers: {
            ...headers(provider.apiKey, "elevenlabs"),
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: request.text,
            model_id: request.model || provider.speechModel,
            ...(request.language ? { language_code: request.language } : {}),
            ...(request.seed !== undefined ? { seed: request.seed } : {}),
            ...parameters,
          }),
        },
      );
      if (!response.ok) return providerError(response, "ElevenLabs");
      const extension = extensionFor(format);
      return {
        ...formatInfo,
        data: new Uint8Array(await response.arrayBuffer()),
        extension,
        mimeType: response.headers.get("content-type") || mimeFor(extension),
        model: request.model || provider.speechModel,
        ...(response.headers.get("request-id")
          ? { requestId: response.headers.get("request-id")! }
          : {}),
      };
    }
    const provider = this.config.providers.openaiAudio;
    requireCredential(provider.apiKey, "OpenAI audio", provider.baseUrl);
    if (
      parameters.instructions &&
      ["tts-1", "tts-1-hd"].includes(request.model || provider.speechModel)
    )
      throw new StudioException(
        "GENERATION_PARAMETERS",
        "The configured tts-1 model does not support speech instructions.",
        "input",
      );
    const format = request.outputFormat || "mp3";
    const formatInfo = audioFormat(format, "openai");
    const response = await this.fetch(`${provider.baseUrl}/audio/speech`, {
      method: "POST",
      signal: signal ?? null,
      headers: {
        ...headers(provider.apiKey, "bearer"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model || provider.speechModel,
        voice: request.voiceId || provider.voice,
        input: request.text,
        response_format: format,
        ...parameters,
      }),
    });
    if (!response.ok) return providerError(response, "OpenAI audio");
    const extension = extensionFor(format);
    return {
      ...formatInfo,
      data: new Uint8Array(await response.arrayBuffer()),
      extension,
      mimeType: response.headers.get("content-type") || mimeFor(extension),
      model: request.model || provider.speechModel,
      ...(response.headers.get("x-request-id")
        ? { requestId: response.headers.get("x-request-id")! }
        : {}),
    };
  }

  async composeMusic(
    request: GenerationRequest,
    durationTick: number,
    signal?: AbortSignal,
  ): Promise<BinaryGenerationResult> {
    safeParameters(request, "music");
    if (request.provider !== "elevenlabs")
      throw new StudioException(
        "PROVIDER_CAPABILITY_MISSING",
        "Music generation currently requires the ElevenLabs provider.",
        "input",
      );
    if (!request.prompt?.trim())
      throw new StudioException(
        "MUSIC_PROMPT_REQUIRED",
        "Music generation requires a prompt.",
        "input",
      );
    const provider = this.config.providers.elevenLabs;
    requireCredential(provider.apiKey, "ElevenLabs", provider.baseUrl);
    const format = request.outputFormat || "mp3_48000_192";
    const formatInfo = audioFormat(format, "elevenlabs");
    if (request.prompt.length > 4100 || request.seed !== undefined)
      throw new StudioException(
        "MUSIC_PARAMETERS",
        "Music prompts are limited to 4100 characters; seeds require a composition plan and are unavailable in prompt mode.",
        "input",
      );
    const durationMs = Math.max(
      3_000,
      Math.min(600_000, Math.round((durationTick / 35_280_000) * 1000)),
    );
    const response = await this.fetch(
      `${provider.baseUrl}/music?output_format=${encodeURIComponent(format)}`,
      {
        method: "POST",
        signal: signal ?? null,
        headers: {
          ...headers(provider.apiKey, "elevenlabs"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: request.prompt,
          music_length_ms: durationMs,
          model_id: request.model || provider.musicModel,
          force_instrumental: request.parameters?.forceInstrumental ?? true,
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
        }),
      },
    );
    if (!response.ok) return providerError(response, "ElevenLabs Music");
    const extension = extensionFor(format);
    return {
      ...formatInfo,
      data: new Uint8Array(await response.arrayBuffer()),
      extension,
      mimeType: response.headers.get("content-type") || mimeFor(extension),
      model: request.model || provider.musicModel,
      ...(response.headers.get("request-id")
        ? { requestId: response.headers.get("request-id")! }
        : {}),
    };
  }

  async transcribe(
    request: GenerationRequest,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<TranscriptionResult> {
    safeParameters(request, "captions");
    if ((await stat(filePath)).size > 25_000_000)
      throw new StudioException(
        "TRANSCRIPTION_LIMIT",
        "Transcribe a bounded region of at most 25 MB.",
        "input",
      );
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
      const response = await this.fetch(`${provider.baseUrl}/speech-to-text`, {
        method: "POST",
        signal: signal ?? null,
        headers: headers(provider.apiKey, "elevenlabs"),
        body: form,
      });
      if (!response.ok) return providerError(response, "ElevenLabs Scribe");
      const data = (await providerJson(response)) as {
        text?: string;
        language_code?: string;
        words?: Array<{
          text?: string;
          start?: number;
          end?: number;
          speaker_id?: string;
          type?: string;
        }>;
      };
      const words = (data.words ?? [])
        .filter((word) => word.type === undefined || word.type === "word")
        .map((word) => ({
          text: word.text ?? "",
          startSeconds: Number(word.start ?? 0),
          endSeconds: Number(word.end ?? word.start ?? 0),
          ...(word.speaker_id ? { speaker: word.speaker_id } : {}),
        }))
        .filter((word) => word.text.trim());
      return {
        text: data.text ?? words.map((word) => word.text).join(" "),
        words,
        model: request.model || provider.transcriptionModel,
        ...(data.language_code ? { language: data.language_code } : {}),
        ...(response.headers.get("request-id")
          ? { requestId: response.headers.get("request-id")! }
          : {}),
      };
    }
    const provider = this.config.providers.openaiAudio;
    requireCredential(
      provider.apiKey,
      "OpenAI transcription",
      provider.baseUrl,
    );
    const transcriptionModel = request.model || provider.transcriptionModel;
    if (
      new URL(provider.baseUrl).hostname === "api.openai.com" &&
      transcriptionModel !== "whisper-1"
    )
      throw new StudioException(
        "TIMESTAMPS_UNSUPPORTED",
        "Caption word timestamps require whisper-1 on the OpenAI endpoint. Configure that model or use a compatible endpoint with word timestamps.",
        "input",
      );
    form.append("model", transcriptionModel);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    if (request.language) form.append("language", request.language);
    const response = await this.fetch(
      `${provider.baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        signal: signal ?? null,
        headers: headers(provider.apiKey, "bearer"),
        body: form,
      },
    );
    if (!response.ok) return providerError(response, "OpenAI transcription");
    const data = (await providerJson(response)) as {
      text?: string;
      language?: string;
      words?: Array<{
        word?: string;
        text?: string;
        start?: number;
        end?: number;
      }>;
      segments?: Array<{ text?: string; start?: number; end?: number }>;
    };
    const rawWords: Array<{ text: string; start?: number; end?: number }> = data
      .words?.length
      ? data.words.map((word) => ({
          text: word.word ?? word.text ?? "",
          ...(word.start !== undefined ? { start: word.start } : {}),
          ...(word.end !== undefined ? { end: word.end } : {}),
        }))
      : (data.segments?.map((segment) => ({
          text: segment.text ?? "",
          ...(segment.start !== undefined ? { start: segment.start } : {}),
          ...(segment.end !== undefined ? { end: segment.end } : {}),
        })) ?? []);
    const words = rawWords
      .map((word) => ({
        text: word.text,
        startSeconds: Number(word.start ?? 0),
        endSeconds: Number(word.end ?? word.start ?? 0),
      }))
      .filter((word) => word.text.trim());
    return {
      text: data.text ?? words.map((word) => word.text).join(" "),
      words,
      model: request.model || provider.transcriptionModel,
      ...(data.language ? { language: data.language } : {}),
      ...(response.headers.get("x-request-id")
        ? { requestId: response.headers.get("x-request-id")! }
        : {}),
    };
  }

  async generateAnimation(
    request: GenerationRequest,
    input: {
      name: string;
      durationTick: number;
      canvas: { width: number; height: number };
      fps: Rational;
    },
    signal?: AbortSignal,
  ): Promise<{
    animation: AnimationDocument;
    model: string;
    requestId?: string;
  }> {
    safeParameters(request, "animation");
    if (!request.prompt?.trim())
      throw new StudioException(
        "ANIMATION_PROMPT_REQUIRED",
        "Animation generation requires a prompt.",
        "input",
      );
    const provider = this.config.providers.language;
    requireCredential(provider.apiKey, "Language provider", provider.baseUrl);
    const model = request.model || provider.model;
    const id = crypto.randomUUID();
    const system =
      "Return one JSON object only. Create an MCP Video Studio AnimationDocument. Use mode declarative and only reliably rendered node types text, rect, ellipse, and line. Use operations create, write, fade, transform, moveAlongPath, rotate, scale, or wait. All timing values are integer ticks; 35280000 ticks equal one second. Every id must be unique. Do not include markdown.";
    const prompt = `${request.prompt}\n\nRequired id: ${id}\nName: ${input.name}\nDuration ticks: ${input.durationTick}\nCanvas: ${input.canvas.width}x${input.canvas.height}, transparent background\nSeed: ${request.seed ?? 1}\nEach node needs properties and transform {position:[x,y],scale:[x,y],rotation,anchor:[x,y],opacity}. Each operation needs id,type,targetId,startTick,durationTick,easing,parameters.`;
    let response: Response;
    if (provider.protocol === "chat_completions") {
      response = await this.fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        signal: signal ?? null,
        headers: {
          ...headers(provider.apiKey, "bearer"),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
        }),
      });
    } else {
      response = await this.fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        signal: signal ?? null,
        headers: {
          ...headers(provider.apiKey, "bearer"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, instructions: system, input: prompt }),
      });
    }
    if (!response.ok) return providerError(response, "Language provider");
    const data = (await providerJson(response)) as Record<string, unknown>;
    const text =
      provider.protocol === "chat_completions"
        ? String(
            (
              data.choices as
                Array<{ message?: { content?: string } }> | undefined
            )?.[0]?.message?.content ?? "",
          )
        : String(
            data.output_text ??
              (
                data.output as
                  Array<{ content?: Array<{ text?: string }> }> | undefined
              )
                ?.flatMap((item) => item.content ?? [])
                .map((item) => item.text ?? "")
                .join("") ??
              "",
          );
    const parsed = parseJsonObject(text) as AnimationDocument;
    const { html: _html, htmlAssetId: _htmlAssetId, ...declarative } = parsed;
    const animation: AnimationDocument = {
      ...declarative,
      id,
      name: input.name,
      durationTick: input.durationTick,
      canvas: { ...input.canvas, background: "transparent" },
      seed: request.seed ?? parsed.seed ?? 1,
      mode: "declarative",
    };
    return {
      animation,
      model,
      ...(response.headers.get("x-request-id")
        ? { requestId: response.headers.get("x-request-id")! }
        : {}),
    };
  }
}
