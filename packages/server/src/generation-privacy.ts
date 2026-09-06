import { StudioException } from "@mcp-video-studio/core";
import type { StudioConfig } from "@mcp-video-studio/media";
export const generationSecrets = (config: StudioConfig) =>
  [
    config.providers.openaiAudio.apiKey,
    config.providers.elevenLabs.apiKey,
    config.providers.language.apiKey,
  ].filter((v): v is string => !!v);
export function secretVariants(secrets: string[]) {
  return [
    ...new Set(
      secrets.filter(Boolean).flatMap((s) => [
        s,
        encodeURIComponent(s),
        Buffer.from(s).toString("base64"),
        JSON.stringify(s).slice(1, -1),
        Array.from(s)
          .map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"))
          .join(""),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
}
export function redactGenerationText(value: string, secrets: string[]) {
  for (const secret of secretVariants(secrets))
    value = value.split(secret).join("[REDACTED]");
  return value;
}
export function assertSafeGenerationInput(value: unknown, secrets: string[]) {
  const raw = JSON.stringify(value);
  if (Buffer.byteLength(raw) > 250000)
    throw new StudioException(
      "GENERATION_INPUT_LIMIT",
      "Generation input exceeds250KB.",
      "input",
    );
  if (redactGenerationText(raw, secrets) !== raw)
    throw new StudioException(
      "GENERATION_CREDENTIAL_INPUT",
      "Keep configured provider credentials out of generation inputs and review notes.",
      "policy",
    );
  const visit = (value: unknown, depth = 0) => {
    if (depth > 8)
      throw new StudioException(
        "GENERATION_INPUT_LIMIT",
        "Generation parameters are too deeply nested.",
        "input",
      );
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (
          /^(?:api[_-]?key|access[_-]?token|authorization|password|secret|client[_-]?secret|refresh[_-]?token)$/i.test(
            key,
          )
        )
          throw new StudioException(
            "GENERATION_CREDENTIAL_INPUT",
            "Credentials must come from provider configuration, not persisted generation parameters.",
            "policy",
          );
        visit(item, depth + 1);
      }
    }
  };
  visit(value);
}

export function assertSafeGenerationOutput(value: unknown, secrets: string[]) {
  const raw = JSON.stringify(value);
  if (redactGenerationText(raw, secrets) !== raw)
    throw new StudioException(
      "PROVIDER_CREDENTIAL_ECHO",
      "Provider output echoed a configured credential; no version output was saved.",
      "policy",
    );
}
