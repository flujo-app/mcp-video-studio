import {parseAss,serializeAss} from "./ass.js";
import { framesToTicks, secondsToTicks, ticksToFrames, ticksToSeconds } from "./time.js";
import type { CaptionCue, Raster } from "./types.js";
import type { Rational } from "./time.js";

export type CaptionFormat = "srt" | "vtt" | "ass";
const timestamp = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[,.](\d{3})$/;
function parseTime(value: string): number {
  const match = timestamp.exec(value);
  if (!match) throw new Error(`Invalid caption timestamp: ${value}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}
export function parseCaptions(text: string, format: CaptionFormat, trackId: string, fps: Rational, style: CaptionCue["style"], raster?: Raster): CaptionCue[] {
  if (text.length > 1_000_000) throw new Error("Caption file exceeds one million characters.");
  if(format==="ass")return parseAss(text,trackId,fps,style,raster);
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (format === "vtt" && !/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(normalized)) throw new Error("WebVTT must start with WEBVTT.");
  const blocks = normalized.replace(/^WEBVTT[^\n]*(?:\n|$)/, "").trim().split(/\n[ \t]*\n/);
  const cues: CaptionCue[] = [];
  for (const block of blocks) {
    if (!block.trim() || /^(NOTE|STYLE|REGION)(?:\s|$)/.test(block)) continue;
    const lines = block.split("\n");
    const timingIndex = lines.findIndex(line => line.includes("-->"));
    if (timingIndex < 0 || timingIndex > 1) throw new Error("Caption block is missing a valid timing line.");
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timingIndex]!);
    if (!match) throw new Error("Invalid caption timing.");
    const start = parseTime(match[1]!), end = parseTime(match[2]!);
    if (end <= start || end > 7 * 86400) throw new Error("Caption end must follow its start and be within seven days.");
    const startTick = framesToTicks(ticksToFrames(secondsToTicks(start), fps, "round"), fps);
    const endTick = framesToTicks(ticksToFrames(secondsToTicks(end), fps, "round"), fps);
    const content = lines.slice(timingIndex + 1).join("\n").trim();
    if (!content || content.length > 10_000 || endTick <= startTick) throw new Error("Caption text/timing is empty or exceeds limits.");
    cues.push({ id: crypto.randomUUID(), trackId, startTick, durationTick: endTick - startTick, text: content, style: structuredClone(style) });
    if (cues.length > 1000) throw new Error("Import at most 1000 captions per transaction.");
  }
  return cues;
}
function formatTime(tick: number, format: CaptionFormat): string {
  const total = Math.round(ticksToSeconds(tick) * 1000);
  const hours = Math.floor(total / 3_600_000), minutes = Math.floor(total / 60_000) % 60, seconds = Math.floor(total / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${format === "srt" ? "," : "."}${String(total % 1000).padStart(3, "0")}`;
}
export function serializeCaptions(captions: CaptionCue[], format: CaptionFormat, raster?: Raster): string {
  if(format==="ass")return serializeAss(captions,raster);
  return (format === "vtt" ? "WEBVTT\n\n" : "") + [...captions].sort((a, b) => a.startTick - b.startTick).map((cue, index) =>
    `${index + 1}\n${formatTime(cue.startTick, format)} --> ${formatTime(cue.startTick + cue.durationTick, format)}\n${cue.text.replace(/\r\n?/g, "\n").replace(/\n\s*\n/g, "\n")}`).join("\n\n") + "\n";
}
