import type { StudioError } from "@mcp-video-studio/contracts";

export class StudioException extends Error {
  readonly studio: StudioError;

  constructor(code: string, message: string, category: StudioError["category"] = "runtime", details?: Record<string, unknown>) {
    super(message);
    this.name = "StudioException";
    this.studio = { code, message, category, ...(details ? { details } : {}) };
  }
}

export function asStudioError(error: unknown): StudioError {
  if (error instanceof StudioException) return error.studio;
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error), category: "runtime" };
}
