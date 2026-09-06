import {z} from "zod";
import {ENCODERS,type EncoderChoice,type ExportRange} from "@mcp-video-studio/renderer";
export const exportOptionsSchema=z.object({
 range:z.object({startTick:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),endTick:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict().optional(),
 encoder:z.object({name:z.enum(ENCODERS.map(entry=>entry.name) as [string,...string[]]),allowSoftwareFallback:z.boolean().optional()}).strict().optional()
});
export function parseExportOptions(input:{range?:unknown;encoder?:unknown}):{range?:ExportRange;encoder?:EncoderChoice}{
 const parsed=exportOptionsSchema.parse({range:input.range,encoder:input.encoder});
 return {...(parsed.range?{range:parsed.range}:{}),...(parsed.encoder?{encoder:{name:parsed.encoder.name,...(parsed.encoder.allowSoftwareFallback!==undefined?{allowSoftwareFallback:parsed.encoder.allowSoftwareFallback}:{})}}:{})};
}
