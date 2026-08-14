import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { StudioException } from "@mcp-video-studio/core";
import type { StudioConfig } from "./config.js";
import { runChecked, type ProcessOptions, type ProcessResult } from "./process.js";

export async function ffmpegArtifact(config: StudioConfig, argsBeforeOutput: string[], outputPath: string, options: ProcessOptions = {}): Promise<ProcessResult> {
  const output = path.resolve(outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  const extension = path.extname(output);
  const temporary = path.join(path.dirname(output), `.${path.basename(output, extension)}.${randomUUID()}.tmp${extension}`);
  try {
    const result = await runChecked(config.ffmpegPath, ["-hide_banner", "-y", ...argsBeforeOutput, temporary], options);
    await rm(output, { force: true });
    await rename(temporary, output);
    return result;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function escapeConcatPath(filePath: string): string {
  return path.resolve(filePath).replaceAll("\\", "/").replaceAll("'", "'\\''");
}

export function escapeFilterValue(value: string): string {
  return value.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'").replaceAll(",", "\\,");
}

export function assertSafeDrawtext(filter: string, defaultFontFile?: string): string {
  if (!filter.includes("drawtext")) return filter;
  if (/(?:^|:)font=/.test(filter)) throw new StudioException("UNSAFE_FONT_FAMILY", "drawtext font= is not supported; use an explicit font file.", "input");
  if (/(?:^|:)fontfile=/.test(filter)) return filter;
  if (!defaultFontFile) throw new StudioException("MISSING_FONT_FILE", "Text rendering requires VIDEO_STUDIO_DEFAULT_FONT_FILE or an imported project font.", "dependency");
  return filter.replace("drawtext=", `drawtext=fontfile='${escapeFilterValue(defaultFontFile)}':`);
}
