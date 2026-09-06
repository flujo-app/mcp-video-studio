import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { framesToTicks, ticksPerSample, ticksPerFrame, ticksToFrames, ticksToSeconds, type Clip, type ExportPreset, type MediaAsset, type Sequence, type StudioProject } from "@mcp-video-studio/contracts";
import { sequenceDependencies, prepareTransitionTimeline, transitionStyle, ProjectStore, sequenceDuration, sha256File, readJson, writeJson, confinedPath, StudioException } from "@mcp-video-studio/core";
import { renderAnimation,ANIMATION_RENDERER_VERSION } from "@mcp-video-studio/animation";
import { requireFfmpegFilters, filterScriptOption, ffmpegArtifact, mediaPath, probeMedia, type StudioConfig } from "@mcp-video-studio/media";
import { audioAutomationFilters } from "./automation.js";
import { atempoChain, audioEffectFilters, clipTransformFilters, videoEffectFilters } from "./filters.js";

export interface RenderOptions {
  sequenceId: string;
  presetId: string;
  outputPath: string;
  expectedRevision?: number;
  /** Frame-aligned cache ranges; 0 disables range caching for parity verification. */
  videoRangeFrames?: number;
  maxWidth?: number;
  crf?: number;
  encoderPreset?: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium";
  signal?: AbortSignal;
  onProgress?: (progress: number, message: string) => void;
}

interface InputSpec {
  args: string[];
  clip: Clip;
  media?: Pick<MediaAsset,"id"|"kind"|"probe">;
  inputIndex: number;
  path?: string;
  streams?: "video" | "audio";
}

function canonicalHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : nested);
  return createHash("sha256").update(canonical).digest("hex");
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function publishFile(sourcePath: string, outputPath: string): Promise<void> {
  if (samePath(sourcePath, outputPath)) return;
  const output = path.resolve(outputPath);
  await mkdir(path.dirname(output), { recursive: true });
  const extension = path.extname(output);
  const temporary = path.join(path.dirname(output), `.${path.basename(output, extension)}.${randomUUID()}.cache${extension}`);
  try {
    await copyFile(sourcePath, temporary);
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface RenderCacheStats {
  directory: string;
  artifactCount: number;
  totalBytes: number;
  oldestAccessedAt?: string;
  newestAccessedAt?: string;
}

async function renderCacheEntries(projectRoot: string): Promise<Array<{ path: string; bytes: number; mtimeMs: number }>> {
  const entries:Array<{path:string;bytes:number;mtimeMs:number}>=[];
  for(const kind of ["renders","animations"]){
   const directory=confinedPath(projectRoot,path.join(projectRoot,"cache",kind));
   const names=await readdir(directory,{withFileTypes:true}).catch(()=>[]);
   for(const entry of names.filter(entry=>entry.isFile()&&!entry.name.endsWith(".json")&&!entry.name.startsWith("."))){
    const filePath=confinedPath(projectRoot,path.join(directory,entry.name));
    const info=await stat(filePath).catch(()=>undefined);
    if(info)entries.push({path:filePath,bytes:info.size,mtimeMs:info.mtimeMs});
   }
  }
  return entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
}

export async function renderCacheStats(projectRoot: string): Promise<RenderCacheStats> {
  const directory = path.join(path.resolve(projectRoot), "cache", "renders");
  const entries = await renderCacheEntries(projectRoot);
  return {
    directory,
    artifactCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    ...(entries[0] ? { oldestAccessedAt: new Date(entries[0].mtimeMs).toISOString(), newestAccessedAt: new Date(entries.at(-1)!.mtimeMs).toISOString() } : {})
  };
}

export async function pruneRenderCache(projectRoot: string, maxBytes: number, preservePath?: string): Promise<RenderCacheStats & { removedArtifacts: number; freedBytes: number }> {
  const entries = await renderCacheEntries(projectRoot);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let removedArtifacts = 0;
  let freedBytes = 0;
  for (const entry of entries) {
    if (totalBytes <= maxBytes) break;
    if (preservePath && samePath(entry.path, preservePath)) continue;
    try{await rm(entry.path,{force:true});await rm(entry.path+".json",{force:true});}catch{continue;}
    totalBytes -= entry.bytes;
    freedBytes += entry.bytes;
    removedArtifacts += 1;
  }
  return { ...(await renderCacheStats(projectRoot)), removedArtifacts, freedBytes };
}

function presetById(project: StudioProject, id: string): ExportPreset {
  const preset = project.exportPresets.find((candidate) => candidate.id === id);
  if (!preset) throw new StudioException("PRESET_NOT_FOUND", `Export preset not found: ${id}`, "input");
  return preset;
}

function sequenceById(project: StudioProject, id: string): Sequence {
  const sequence = project.sequences.find((candidate) => candidate.id === id);
  if (!sequence) throw new StudioException("SEQUENCE_NOT_FOUND", `Sequence not found: ${id}`, "input");
  return sequence;
}

function mediaById(project: StudioProject, id: string): MediaAsset {
  const media = project.media.find((candidate) => candidate.id === id);
  if (!media) throw new StudioException("MEDIA_NOT_FOUND", `Media not found: ${id}`, "input");
  return media;
}

function ffmpegColor(value: string): string {
  if (!/^(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|[a-z]{1,24})$/i.test(value)) throw new StudioException("INVALID_COLOR", "Use a hexadecimal or named color.", "input");
  return value.replace(/^#/, "0x");
}

function ffmpegCaptionColor(value: string): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!match) return ffmpegColor(value);
  const alpha = match[2] ? Number.parseInt(match[2], 16) / 255 : 1;
  return `0x${match[1]}@${alpha.toFixed(3)}`;
}

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function captionFontFile(fontFamily: string, configured?: string): string {
  const windows = process.env.WINDIR || "C:\\Windows";
  const family = fontFamily.toLowerCase();
  const windowsName = family.includes("mono") || family.includes("consol") ? "consola.ttf" : family.includes("serif") || family.includes("times") ? "times.ttf" : "arial.ttf";
  const candidates = [
    ...(configured ? [configured] : []),
    path.join(windows, "Fonts", windowsName),
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf"
  ];
  const match = candidates.find((candidate) => existsSync(candidate));
  if (!match) throw new StudioException("CAPTION_FONT_MISSING", "No supported system caption font was found. Install Arial, Helvetica, DejaVu Sans, or Liberation Sans.", "dependency");
  return match;
}

async function buildInputs(project: StudioProject, sequence: Sequence, store: ProjectStore, config: StudioConfig, signal?: AbortSignal, progress?: (value: number, message: string) => void, streams: {video?:boolean;audio?:boolean;scratch?:string} = {}): Promise<InputSpec[]> {
  const enabled = sequence.clips.filter((clip) => clip.enabled);
  const inputs: InputSpec[] = [];
  let index = 0;
  for (const clip of enabled) {
    if (clip.source.type === "media") {
      const media = mediaById(project, clip.source.mediaId);
      const source = mediaPath(store, media);
      // Independent demuxers prevent a trimmed video stream from ending the clip's audio input.
      if(streams.video!==false&&(media.probe.hasVideo||media.kind==="image"))inputs.push({args:media.kind==="image"?["-loop","1","-an","-i",source]:["-an","-i",source],clip,media,inputIndex:index++,path:source,streams:"video"});
      if(streams.audio!==false&&media.probe.hasAudio)inputs.push({args:["-vn","-i",source],clip,media,inputIndex:index++,path:source,streams:"audio"});
    } else if(clip.source.type==="sequence"){
      if(!streams.scratch)throw new StudioException("NESTED_RENDER_CONTEXT","Nested rendering requires its parent scratch directory.","runtime");
      const preset=project.exportPresets.find(preset=>preset.container==="mkv"&&preset.videoCodec==="ffv1"&&preset.audioCodec==="flac");
      if(!preset)throw new StudioException("NESTED_RENDER_PRESET","Add an FFV1/FLAC Matroska preset to render nested sequences.","input");
      const rendered=path.join(streams.scratch,"nested-"+randomUUID()+".mkv");
      const result=await renderSequence(store,config,{sequenceId:clip.source.sequenceId,presetId:preset.id,outputPath:rendered,expectedRevision:project.revision,...(signal?{signal}:{})});
      const media={id:clip.source.sequenceId,kind:"video" as const,probe:result.probe as MediaAsset["probe"]};
      if(streams.video!==false)inputs.push({args:["-an","-i",rendered],clip,media,inputIndex:index++,path:rendered,streams:"video"});
      if(streams.audio!==false)inputs.push({args:["-vn","-i",rendered],clip,media,inputIndex:index++,path:rendered,streams:"audio"});
    } else if (streams.video!==false&&clip.source.type === "color") {
      inputs.push({ args: ["-f", "lavfi", "-i", `color=c=${ffmpegColor(clip.source.color)}:s=${project.settings.raster.width}x${project.settings.raster.height}:r=${project.settings.fps.numerator}/${project.settings.fps.denominator}`], clip, inputIndex: index++ });
    } else if (streams.video!==false&&clip.source.type === "animation") {
      const animationId = clip.source.animationId;
      const animation = project.animations.find((candidate) => candidate.id === animationId);
      if (!animation) throw new StudioException("ANIMATION_NOT_FOUND", `Animation not found: ${animationId}`, "input");
      const key = canonicalHash({ animation, fps: project.settings.fps,renderer:ANIMATION_RENDERER_VERSION });
      const rendered = confinedPath(store.root,path.join(store.root,"cache","animations",key+".mkv"));
      await mkdir(path.dirname(rendered), { recursive: true });
      try { await sha256File(rendered); }
      catch {
        progress?.(0.05, `Rendering animation ${animation.name}`);
        await renderAnimation(animation, config, { outputPath: rendered, fps: project.settings.fps, signal, onProgress: (value) => progress?.(0.05 + value * 0.15, `Rendering animation ${animation.name}`) });
      }
      inputs.push({ args: ["-i", rendered], clip, inputIndex: index++, path: rendered });
    }
  }
  return inputs;
}

function fadeFilters(sequence:Sequence,clip:Clip):string[]{
 const incoming=sequence.transitions.find(transition=>transition.toClipId===clip.id&&transitionStyle(transition.type)!=="cut");
 if(!incoming)return[];
 const start=ticksToSeconds(clip.startTick),duration=ticksToSeconds(incoming.durationTick),style=transitionStyle(incoming.type);
 if(style==="crossfade")return["fade=t=in:st="+start+":d="+duration+":alpha=1"];
 const progress="clip((T-"+start+")/"+duration+",0,1)",condition=style==="wipeleft"?"lte(X/W,"+progress+")":"gte(X/W,1-"+progress+")";
 return["format=gbrap","geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*"+condition+"'"];
}


function buildFilterGraph(project: StudioProject, sequence: Sequence, inputs: InputSpec[], captionFiles: Map<string, string>, maxWidth?: number, defaultFontFile?: string, pass: {video?:boolean;audio?:boolean;range?:{startTick:number;endTick:number};cachedVideoInput?:number;cachedAudioInput?:number;captionFonts?:Map<string,string>} = {}): { graph: string; videoLabel: string; audioLabel: string; durationTick: number; frameCount: number } {
  const durationTick = pass.range?pass.range.endTick-pass.range.startTick:sequenceDuration(sequence);
  if (durationTick <= 0) throw new StudioException("EMPTY_SEQUENCE", "The sequence has no renderable duration.", "input");
  const frameCount = ticksToFrames(durationTick, project.settings.fps, "ceil");
  const durationSeconds = ticksToSeconds(framesToTicks(frameCount, project.settings.fps));
  const durationSamples=Math.round(durationSeconds*project.settings.sampleRate);
  const fps = `${project.settings.fps.numerator}/${project.settings.fps.denominator}`;
  const { width, height } = project.settings.raster;
  const statements:string[]=[];
  let videoLabel = "base0";
  if(pass.video!==false){
  statements.push(`color=c=${ffmpegColor(project.settings.background)}:s=${width}x${height}:r=${fps}:d=${durationSeconds},format=rgba${pass.range ? ",setpts=PTS+"+ticksToSeconds(pass.range.startTick)+"/TB" : ""}[base0]`);
  const visual = inputs.filter(input=>input.streams!=="audio").filter(input => !sequence.tracks.find(track => track.id === input.clip.trackId)?.hidden).filter((input) => input.clip.source.type === "color" || input.media?.probe.hasVideo || input.media?.kind === "image" || input.clip.source.type === "animation")
    .sort((a, b) => {
      const trackA = sequence.tracks.find((track) => track.id === a.clip.trackId)?.order ?? 0;
      const trackB = sequence.tracks.find((track) => track.id === b.clip.trackId)?.order ?? 0;
      return trackA - trackB || a.clip.startTick - b.clip.startTick;
    });
  visual.forEach((input, visualIndex) => {
    const clip = input.clip;
    const rate = clip.playbackRate.numerator / clip.playbackRate.denominator;
    const startTick=Math.max(clip.startTick,pass.range?.startTick??clip.startTick);
    const finishTick=Math.min(clip.startTick+clip.durationTick,pass.range?.endTick??Number.MAX_SAFE_INTEGER);
    const sourceFps=input.media?.probe.frameRate??project.settings.fps,sourceFrameSeconds=sourceFps.denominator/sourceFps.numerator;
    const requestedSourceStart=ticksToSeconds(clip.sourceInTick+Math.round((startTick-clip.startTick)*rate));
    // Keep the preceding source frame so slowed clips hold the same image across cache boundaries.
    const sourceStart=Math.floor((requestedSourceStart+1e-9)/sourceFrameSeconds)*sourceFrameSeconds;
    const sourceEnd=ticksToSeconds(clip.sourceInTick+Math.round((finishTick-clip.startTick)*rate))+sourceFrameSeconds;
    const start = ticksToSeconds(clip.startTick);
    const transform = clipTransformFilters(clip, project.settings.raster);
    const filters = [
      `trim=start=${sourceStart}:end=${sourceEnd}`,
      `setpts=(PTS-${ticksToSeconds(clip.sourceInTick)}/TB)/${rate}+${start}/TB`,
      `fps=${fps}`,
      "trim=start="+ticksToSeconds(startTick)+":end="+ticksToSeconds(finishTick),
      ...transform.filters,
      ...videoEffectFilters(clip.effects),
      ...fadeFilters(sequence, clip)
    ];
    const clipLabel = `vclip${visualIndex}`;
    statements.push(`[${input.inputIndex}:v]${filters.join(",")}[${clipLabel}]`);
    const next = `base${visualIndex + 1}`;
    if(clip.blendMode==="normal"){
    statements.push(`[${videoLabel}][${clipLabel}]overlay=x=${transform.x}:y=${transform.y}:eof_action=pass:shortest=0[${next}]`);
    }else{
      const tag="blend"+visualIndex;
      statements.push("color=c=black@0:s="+width+"x"+height+":r="+fps+":d="+durationSeconds+",format=rgba["+tag+"empty]");
      statements.push("["+tag+"empty]["+clipLabel+"]overlay=x="+transform.x+":y="+transform.y+":eof_action=pass:shortest=0:format=auto,format=rgba,split["+tag+"rgb]["+tag+"alpha]");
      statements.push("["+tag+"alpha]alphaextract,format=gbrp["+tag+"mask]");
      statements.push("["+tag+"rgb]format=gbrp["+tag+"foreground]");
      statements.push("["+videoLabel+"]format=gbrp,split["+tag+"original]["+tag+"under]");
      statements.push("["+tag+"under]["+tag+"foreground]blend=all_mode="+clip.blendMode+"["+tag+"result]");
      statements.push("["+tag+"original]["+tag+"result]["+tag+"mask]maskedmerge=planes=7["+next+"]");
    }
    videoLabel = next;
  });

  const captions = sequence.captions.filter((caption) => {
    const track = sequence.tracks.find((candidate) => candidate.id === caption.trackId);
    return track && !track.hidden && !track.muted;
  });
  captions.forEach((caption, captionIndex) => {
    const start = ticksToSeconds(caption.startTick);
    const finish = ticksToSeconds(caption.startTick + caption.durationTick);
    const x = caption.style.align === "left" ? String(caption.style.marginLeft??width*.05) : caption.style.align === "right" ? "w-text_w-"+(caption.style.marginRight??width*.05) : "(w-text_w)/2";
    const y = caption.style.position === "top" ? String(caption.style.marginVertical??height*.07) : caption.style.position === "center" ? "(h-text_h)/2" : "h-text_h-"+(caption.style.marginVertical??height*.08);
    const next = `caption${captionIndex}`;
    const textFile = captionFiles.get(caption.id);
    if (!textFile) throw new StudioException("CAPTION_TEXT_MISSING", `Caption text file missing for ${caption.id}.`, "runtime");
    statements.push(`[${videoLabel}]drawtext=fontfile='${escapeFilterPath(pass.captionFonts?.get(caption.id)??captionFontFile(caption.style.fontFamily, defaultFontFile))}':textfile='${escapeFilterPath(textFile)}':reload=0:expansion=none:fontsize=${caption.style.fontSize}:fontcolor=${ffmpegCaptionColor(caption.style.color)}:box=1:boxcolor=${ffmpegCaptionColor(caption.style.background)}:boxborderw=18:borderw=${caption.style.outlineWidth??0}:bordercolor=${ffmpegCaptionColor(caption.style.outlineColor??"#000000")}:shadowcolor=${ffmpegCaptionColor(caption.style.shadowColor??"#000000")}:shadowx=${caption.style.shadowOffset??0}:shadowy=${caption.style.shadowOffset??0}:x=${x}:y=${y}:enable='gte(t,${start})*lt(t,${finish})'[${next}]`);
    videoLabel = next;
  });

  }
  if(pass.audio!==false){
  const audibleTracks = sequence.tracks.filter((track) => track.type === "audio" || track.type === "video");
  const anySolo = audibleTracks.some((track) => track.solo);
  const audioInputs = inputs.filter((input) => input.streams!=="video"&&input.media?.probe.hasAudio && (() => {
    const track = sequence.tracks.find((candidate) => candidate.id === input.clip.trackId);
    return track && !track.muted && (!anySolo || track.solo) && !input.clip.audio.muted;
  })());
  const audioLabels: string[] = [];
  const trackLabels=new Map<string,string[]>();
  audioInputs.forEach((input, audioIndex) => {
    const clip = input.clip;
    const track = sequence.tracks.find((candidate) => candidate.id === clip.trackId)!;
    if((track.effects??[]).some(effect=>effect.enabled&&effect.type==="loudness")&&clip.audio.effects.some(effect=>effect.enabled&&effect.type==="loudness"))throw new StudioException("DUPLICATE_NORMALIZATION","Use loudness normalization on the clip or its track, not both.","input");
    const rate = clip.playbackRate.numerator / clip.playbackRate.denominator;
    const sourceRate=input.media?.probe.sampleRate??project.settings.sampleRate,sourceSample=ticksPerSample(sourceRate);
    const firstSample=Math.round(clip.sourceInTick/sourceSample),lastSample=firstSample+Math.round(clip.durationTick*rate/sourceSample);
    const filters = [
      "atrim=start_sample="+firstSample+":end_sample="+lastSample,
      "asetpts=N/SR/TB",
      `aformat=sample_rates=${project.settings.sampleRate}:channel_layouts=${project.settings.channels === 1 ? "mono" : project.settings.channels === 6 ? "5.1" : "stereo"}`,
      ...atempoChain(rate),
      "asettb=1/"+project.settings.sampleRate,"asetpts=N/SR/TB",
      `volume=${clip.audio.gainDb}dB`,
      ...(project.settings.channels === 2 ? [`stereotools=balance_out=${Math.max(-1, Math.min(1, clip.audio.pan))}`] : []),
      ...(clip.audio.fadeInTick > 0 ? [`afade=t=in:st=0:d=${ticksToSeconds(clip.audio.fadeInTick)}`] : []),
      ...(clip.audio.fadeOutTick > 0 ? [`afade=t=out:st=${Math.max(0, ticksToSeconds(clip.durationTick - clip.audio.fadeOutTick))}:d=${ticksToSeconds(clip.audio.fadeOutTick)}`] : []),
      ...audioEffectFilters(clip.audio.effects,project.settings.sampleRate),
      ...audioAutomationFilters(project, sequence, clip),
      ...sequence.transitions.filter(transition=>transitionStyle(transition.type)!=="cut"&&transition.toClipId===clip.id).map(transition=>"afade=t=in:st=0:d="+ticksToSeconds(transition.durationTick)),
      ...sequence.transitions.filter(transition=>transitionStyle(transition.type)!=="cut"&&transition.fromClipId===clip.id).map(transition=>"afade=t=out:st="+ticksToSeconds(clip.durationTick-transition.durationTick)+":d="+ticksToSeconds(transition.durationTick)),
      `adelay=${Math.round(clip.startTick / ticksPerSample(project.settings.sampleRate))}S:all=1`,
      // Every mixer input owns the same finite sample interval; no input EOF changes mix duration.
      "atrim=end_sample="+durationSamples,"apad=whole_len="+durationSamples,
      "asetpts=N/SR/TB","asetnsamples=n=1024:p=0"
    ];
    const label = `aclip${audioIndex}`;
    statements.push(`[${input.inputIndex}:a]${filters.join(",")}[${label}]`);
    const owned=trackLabels.get(track.id)??[];trackLabels.set(track.id,owned);
    owned.push(`[${label}]`);
  });
  for(const [trackId,labels] of trackLabels){
    const track=sequence.tracks.find(item=>item.id===trackId)!;
    const label="atrack"+audioLabels.length;
    const filters=[
      "amix=inputs="+labels.length+":duration=shortest:normalize=0",
      "volume="+track.gainDb+"dB",
      ...(project.settings.channels===2?["stereotools=balance_out="+track.pan]:[]),
      ...audioEffectFilters(track.effects??[],project.settings.sampleRate)
    ];
    statements.push(labels.join("")+filters.join(",")+"["+label+"]");
    audioLabels.push("["+label+"]");
  }
  const audioLabel = "aout";
  if (audioLabels.length > 0) statements.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,atrim=end_sample=${durationSamples},apad=whole_len=${durationSamples},asetpts=N/SR/TB[${audioLabel}]`);
  else statements.push(`anullsrc=r=${project.settings.sampleRate}:cl=${project.settings.channels === 1 ? "mono" : project.settings.channels === 6 ? "5.1" : "stereo"},atrim=duration=${durationSeconds}[${audioLabel}]`);
  }
  if(pass.video!==false){
  const outputWidth = maxWidth && width > maxWidth ? Math.max(2, Math.floor(maxWidth / 2) * 2) : width;
  const outputHeight = outputWidth !== width ? Math.max(2, Math.round(height * outputWidth / width / 2) * 2) : height;
  statements.push(`[${videoLabel}]${outputWidth !== width ? `scale=${outputWidth}:${outputHeight}:flags=lanczos,` : ""}format=yuv420p${pass.range?",trim=start="+ticksToSeconds(pass.range.startTick)+":end="+ticksToSeconds(pass.range.endTick)+",setpts=PTS-STARTPTS":""},trim=end_frame=${frameCount}[vout]`);
  }
  if(pass.cachedAudioInput!==undefined)statements.push("["+pass.cachedAudioInput+":a]asetpts=N/SR/TB[aout]");
  if(pass.cachedVideoInput!==undefined)statements.push("["+pass.cachedVideoInput+":v]setpts=N/("+fps+"*TB),trim=end_frame="+frameCount+"[vout]");
  return { graph: statements.join(";\n"), videoLabel: "vout", audioLabel: "aout", durationTick: framesToTicks(frameCount, project.settings.fps), frameCount };
}


function visualClip(project:StudioProject,sequence:Sequence,clip:Clip):boolean{
 if(!clip.enabled||sequence.tracks.find(track=>track.id===clip.trackId)?.hidden)return false;
 if(clip.source.type==="sequence")return true;
 return clip.source.type==="color"||clip.source.type==="animation"||clip.source.type==="media"&&project.media.some(media=>clip.source.type==="media"&&media.id===clip.source.mediaId&&(media.probe.hasVideo||media.kind==="image"));
}
function audibleClip(project:StudioProject,clip:Clip):boolean{return clip.enabled&&(clip.source.type==="sequence"||clip.source.type==="media"&&project.media.some(media=>clip.source.type==="media"&&media.id===clip.source.mediaId&&media.probe.hasAudio));}
async function continuousAudio(project:StudioProject,sequence:Sequence,store:ProjectStore,config:StudioConfig,options:RenderOptions,scratch:string,mediaHashes:Map<string,string>){
 const clips=sequence.clips.filter(clip=>audibleClip(project,clip)),ids=new Set(clips.map(clip=>clip.id));
 const mediaIds=new Set(clips.flatMap(clip=>clip.source.type==="media"?[clip.source.mediaId]:[]));
 const durationTick=framesToTicks(ticksToFrames(sequenceDuration(sequence),project.settings.fps,"ceil"),project.settings.fps);
 const key=canonicalHash({durationTick,settings:{sampleRate:project.settings.sampleRate,channels:project.settings.channels},
  clips:clips.map(({id,trackId,source,startTick,durationTick,sourceInTick,playbackRate,enabled,audio})=>({id,trackId,source,startTick,durationTick,sourceInTick,playbackRate,enabled,audio})),
  tracks:sequence.tracks.map(({id,type,muted,solo,gainDb,pan,effects})=>({id,type,muted,solo,gainDb,pan,effects})),
  automation:sequence.automation,transitions:sequence.transitions.filter(transition=>ids.has(transition.fromClipId)||ids.has(transition.toClipId)),
  media:[...mediaIds].map(id=>({id,hash:mediaHashes.get(id)})),renderer:14,animationRenderer:ANIMATION_RENDERER_VERSION});
 const cached=confinedPath(store.root,path.join(store.root,"cache","renders","audio-"+key+".wav"));
 let hit=false;try{const [meta,hash]=await Promise.all([readJson<{sha256:string;bytes:number}>(confinedPath(store.root,cached+".json")),sha256File(cached)]);hit=hash.bytes>0&&hash.sha256===meta.sha256&&hash.bytes===meta.bytes;}catch{}
 if(!hit){
  const inputs=await buildInputs(project,{...sequence,clips},store,config,options.signal,options.onProgress,{video:false,scratch});
  const graph=buildFilterGraph(project,sequence,inputs,new Map(),undefined,undefined,{video:false});
  const graphPath=path.join(scratch,"continuous-audio.txt");await writeFile(graphPath,graph.graph,"utf8");
  await ffmpegArtifact(config,[...inputs.flatMap(input=>input.args),await filterScriptOption(config.ffmpegPath),graphPath,"-map","["+graph.audioLabel+"]","-t",String(ticksToSeconds(durationTick)),"-c:a","pcm_f32le","-rf64","auto","-vn"],cached,{signal:options.signal,timeoutMs:24*60*60_000});
  await writeJson(cached+".json",await sha256File(cached));
 }
 const pinned=path.join(scratch,"continuous-audio.wav");await link(cached,pinned).catch(()=>copyFile(cached,pinned));
 await utimes(cached,new Date(),new Date()).catch(()=>undefined);
 return{args:["-i",pinned],cacheHit:hit,renderKey:key};
}
function nestedFingerprint(project:StudioProject,clips:Clip[],mediaHashes:Map<string,string>){
 const sequences=new Set<string>(),media=new Set<string>(),animations=new Set<string>();
 for(const clip of clips)if(clip.enabled&&clip.source.type==="sequence"){
  const dependencies=sequenceDependencies(project,clip.source.sequenceId);
  for(const id of dependencies.sequences)sequences.add(id);for(const id of dependencies.media)media.add(id);for(const id of dependencies.animations)animations.add(id);
 }
 return{captionFonts:project.sequences.filter(sequence=>sequences.has(sequence.id)).flatMap(sequence=>sequence.captions.map(caption=>({id:caption.id,hash:mediaHashes.get("caption-font:"+caption.id)}))),sequences:project.sequences.filter(sequence=>sequences.has(sequence.id)),media:[...media].map(id=>({id,sha256:mediaHashes.get(id)})),animations:project.animations.filter(animation=>animations.has(animation.id))};
}
interface CachedRange{startTick:number;endTick:number;renderKey:string;cacheHit:boolean}
async function videoRanges(project:StudioProject,sequence:Sequence,store:ProjectStore,config:StudioConfig,options:RenderOptions,scratch:string,captionFiles:Map<string,string>,mediaHashes:Map<string,string>,captionFonts:Map<string,string>){
 const totalFrames=ticksToFrames(sequenceDuration(sequence),project.settings.fps,"ceil");
 const rangeFrames=Math.max(options.videoRangeFrames??Math.max(1,Math.round(10*project.settings.fps.numerator/project.settings.fps.denominator)),Math.ceil(totalFrames/3600));
 const ranges:CachedRange[]=[],list:string[]=[];
 const clips=sequence.clips.filter(clip=>visualClip(project,sequence,clip));
 for(let startFrame=0;startFrame<totalFrames;startFrame+=rangeFrames){
  options.signal?.throwIfAborted();
  const startTick=framesToTicks(startFrame,project.settings.fps),endTick=framesToTicks(Math.min(totalFrames,startFrame+rangeFrames),project.settings.fps);
  const owned=clips.filter(clip=>clip.startTick<endTick&&clip.startTick+clip.durationTick>startTick);
  const ids=new Set(owned.map(clip=>clip.id)),mediaIds=new Set(owned.flatMap(clip=>clip.source.type==="media"?[clip.source.mediaId]:[]));
  const animationIds=new Set(owned.flatMap(clip=>clip.source.type==="animation"?[clip.source.animationId]:[]));
  const captions=sequence.captions.filter(caption=>caption.startTick<endTick&&caption.startTick+caption.durationTick>startTick);
  const rangeSequence={...sequence,clips:owned,captions};
  const key=canonicalHash({
   nested:nestedFingerprint(project,owned,mediaHashes),
   startTick,endTick,clips:owned.map(({name,audio,groupId,linkedGroupId,...clip})=>clip),
   tracks:sequence.tracks.filter(track=>owned.some(clip=>clip.trackId===track.id)||captions.some(caption=>caption.trackId===track.id)).map(({id,order,hidden,muted,type})=>({id,order,hidden,muted:type==="caption"?muted:undefined})),
   captionFonts:captions.map(caption=>({id:caption.id,hash:mediaHashes.get("caption-font:"+caption.id)})),captions,transitions:sequence.transitions.filter(transition=>ids.has(transition.fromClipId)||ids.has(transition.toClipId)),
   settings:{raster:project.settings.raster,fps:project.settings.fps,background:project.settings.background,colorSpace:project.settings.colorSpace},
   media:[...mediaIds].map(id=>({id,hash:mediaHashes.get(id)})),
   animations:project.animations.filter(animation=>animationIds.has(animation.id)),
   output:{maxWidth:options.maxWidth??null,defaultFontFile:config.defaultFontFile??null},renderer:14,animationRenderer:ANIMATION_RENDERER_VERSION
  });
  const cached=confinedPath(store.root,path.join(store.root,"cache","renders","video-"+key+".mkv"));
  let hit=false;
  try{const [meta,hash]=await Promise.all([readJson<{sha256:string;bytes:number}>(confinedPath(store.root,cached+".json")),sha256File(cached)]);hit=hash.bytes>0&&hash.sha256===meta.sha256&&hash.bytes===meta.bytes;}catch{}
  if(!hit){
   const inputs=await buildInputs(project,rangeSequence,store,config,options.signal,options.onProgress,{audio:false,scratch});
   const compiled=buildFilterGraph(project,rangeSequence,inputs,captionFiles,options.maxWidth,config.defaultFontFile,{audio:false,range:{startTick,endTick},captionFonts});
   const graphPath=path.join(scratch,"range-"+ranges.length+".txt");await writeFile(graphPath,compiled.graph,"utf8");
   await ffmpegArtifact(config,[...inputs.flatMap(input=>input.args),await filterScriptOption(config.ffmpegPath),graphPath,"-map","["+compiled.videoLabel+"]","-frames:v",String(compiled.frameCount),"-c:v","ffv1","-level","3","-an"],cached,{signal:options.signal,timeoutMs:60*60_000});
   await writeJson(cached+".json",await sha256File(cached));
  }
  await utimes(cached,new Date(),new Date()).catch(()=>undefined);
  // Pin an immutable file for this render so concurrent cache pruning cannot remove its input.
  const pinned=path.join(scratch,"range-"+ranges.length+".mkv");
  await link(cached,pinned).catch(()=>copyFile(cached,pinned));
  list.push("file 'range-"+ranges.length+".mkv'","duration "+ticksToSeconds(endTick-startTick));
  ranges.push({startTick,endTick,renderKey:key,cacheHit:hit});
  options.onProgress?.(.05+.65*(startFrame+Math.min(rangeFrames,totalFrames-startFrame))/totalFrames,"Video range "+ranges.length+(hit?" reused":" rendered"));
 }
 const listPath=path.join(scratch,"video-ranges.ffconcat");await writeFile(listPath,"ffconcat version 1.0\n"+list.join("\n")+"\n","utf8");
 return {args:["-f","concat","-safe","1","-i",listPath],ranges};
}

export async function renderSequence(store: ProjectStore, config: StudioConfig, options: RenderOptions): Promise<Record<string, unknown>> {
  const project = await store.read();
  if (options.expectedRevision !== undefined && project.revision !== options.expectedRevision) {
    throw new StudioException("REVISION_CONFLICT", `Preview requested for revision ${options.expectedRevision}, but the project is now revision ${project.revision}.`, "conflict", { expectedRevision: options.expectedRevision, actualRevision: project.revision });
  }
  if(options.videoRangeFrames!==undefined&&(!Number.isSafeInteger(options.videoRangeFrames)||options.videoRangeFrames<0||options.videoRangeFrames>100000))throw new StudioException("INVALID_RENDER_RANGE","Video range frames must be an integer from 0 to 100000.","input");
  const sequence = prepareTransitionTimeline(project,sequenceById(project, options.sequenceId));
  const preset = presetById(project, options.presetId);
  const dependencies=sequenceDependencies(project,sequence.id),mediaIds=dependencies.media,animationIds=dependencies.animations;
  const mediaHashes=new Map<string,string>();
  for(const media of project.media.filter(asset=>mediaIds.has(asset.id))){
   const source=mediaPath(store,media);
   if(samePath(source,options.outputPath))throw new StudioException("SOURCE_OUTPUT_OVERWRITE","Export cannot overwrite a project media source.","input");
   mediaHashes.set(media.id,(await sha256File(source,options.signal)).sha256);
  }
  const captionFonts=new Map<string,string>();
  if(preset.container!=="wav")for(const owner of project.sequences.filter(owner=>dependencies.sequences.has(owner.id)))for(const caption of owner.captions){
   const font=caption.style.fontMediaId?mediaPath(store,mediaById(project,caption.style.fontMediaId)):captionFontFile(caption.style.fontFamily,config.defaultFontFile);
   if(samePath(font,options.outputPath))throw new StudioException("SOURCE_OUTPUT_OVERWRITE","Export cannot overwrite a caption font.","input");
   captionFonts.set(caption.id,font);mediaHashes.set("caption-font:"+caption.id,(await sha256File(font,options.signal)).sha256);
  }
  confinedPath(store.root,path.join(store.root,"cache","renders"));

  const renderKey = canonicalHash({
    captionFonts:[...captionFonts.keys()].map(id=>({id,hash:mediaHashes.get("caption-font:"+id)})),sequence,
    nested:project.sequences.filter(child=>child.id!==sequence.id&&dependencies.sequences.has(child.id)),
    settings: project.settings,
    preset,
    media: project.media.filter((asset) => mediaIds.has(asset.id)).map((asset) => ({ id: asset.id, hash: mediaHashes.get(asset.id), offline: asset.offline ?? false })),
    animations: project.animations.filter((animation) => animationIds.has(animation.id)),
    output: { videoRangeFrames:options.videoRangeFrames??null, maxWidth: options.maxWidth ?? null, crf: options.crf ?? null, encoderPreset: options.encoderPreset ?? null, defaultFontFile: config.defaultFontFile ?? null },
    renderer: 14,animationRenderer:ANIMATION_RENDERER_VERSION
  });
  const cachePath = confinedPath(store.root,path.join(store.root,"cache","renders",renderKey+"."+preset.container));
  const durationTick = sequenceDuration(sequence);
  if (durationTick <= 0) throw new StudioException("EMPTY_SEQUENCE", "The sequence has no renderable duration.", "input");
  const frameCount = ticksToFrames(durationTick, project.settings.fps, "ceil");
  const outputDurationTick=preset.container==="wav"?durationTick:framesToTicks(frameCount,project.settings.fps);
  options.onProgress?.(0.02, "Checking render cache");
  const cached = await stat(cachePath).then((info) => info.isFile() && info.size > 0).catch(() => false);
  if (cached) {
    try {
      const [metadata,hash]=await Promise.all([readJson<{sha256:string;bytes:number}>(confinedPath(store.root,cachePath+".json")),sha256File(cachePath,options.signal)]);
      if(metadata.sha256!==hash.sha256||metadata.bytes!==hash.bytes)throw new Error("Render cache checksum changed.");
      const probe=await probeMedia(cachePath,config,options.signal);
      await publishFile(cachePath, options.outputPath);
      const now = new Date();
      await utimes(cachePath, now, now).catch(() => undefined);

      options.onProgress?.(1, "Reused cached render");
      return {
        success: true, cacheHit: true, cachePath, outputPath: path.resolve(options.outputPath), projectId: project.projectId, revision: project.revision,
        sequenceId: sequence.id, renderKey, frameCount, durationTick: outputDurationTick, probe, ...hash, durationMs: 0
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      await rm(cachePath, { force: true }).catch(() => undefined);
    }
  }
  const scratch = path.join(config.scratchDir, `render-${randomUUID()}`);
  const output=path.resolve(options.outputPath);
  const stagedOutput=path.join(path.dirname(output),"."+path.basename(output)+"."+randomUUID()+".review."+preset.container);
  await mkdir(scratch, { recursive: true });
  try {
    options.onProgress?.(0.01, "Planning render");
    if(preset.container!=="wav"&&sequence.captions.length)await requireFfmpegFilters(config.ffmpegPath,["drawtext"]);
    const audioOnly = preset.container === "wav";

    const captionFiles = new Map<string, string>();
    await Promise.all(sequence.captions.map(async (caption, index) => {
      const textPath = path.join(scratch, `caption-${index}.txt`);
      await writeFile(textPath, caption.text, "utf8");
      captionFiles.set(caption.id, textPath);
    }));
    const useRanges=!audioOnly&&options.videoRangeFrames!==0&&(options.videoRangeFrames!==undefined||ticksToSeconds(durationTick)>30||sequence.clips.filter(clip=>visualClip(project,sequence,clip)).length>32);
    const cachedVideo=useRanges?await videoRanges(project,sequence,store,config,options,scratch,captionFiles,mediaHashes,captionFonts):undefined;
    const cachedAudio=cachedVideo?await continuousAudio(project,sequence,store,config,options,scratch,mediaHashes):undefined;
    const inputSequence=cachedVideo?{...sequence,clips:[]}:audioOnly?{...sequence,clips:sequence.clips.filter(clip=>audibleClip(project,clip))}:sequence;
    const inputs=await buildInputs(project,inputSequence,store,config,options.signal,options.onProgress,{video:!audioOnly,scratch});
    const compiled = buildFilterGraph(project,sequence,inputs,captionFiles,options.maxWidth,config.defaultFontFile,{captionFonts,video:!audioOnly&&!cachedVideo,audio:!cachedAudio,...(cachedVideo?{cachedVideoInput:inputs.length}:{}),...(cachedAudio?{cachedAudioInput:inputs.length+1}:{})});
    const graphPath = path.join(scratch, "filter-complex.txt");
    await writeFile(graphPath, compiled.graph, "utf8");
    const inputArgs = [...inputs.flatMap((input) => input.args),...(cachedVideo?.args??[]),...(cachedAudio?.args??[])];
    const graph = compiled.graph;
    await writeFile(graphPath, graph, "utf8");
    const args = [
      ...inputArgs, await filterScriptOption(config.ffmpegPath), graphPath,
      ...(!audioOnly ? ["-map", `[${compiled.videoLabel}]`, "-c:v", preset.videoCodec ?? "libx264"] : []),
      "-map", `[${compiled.audioLabel}]`, "-t", String(ticksToSeconds(outputDurationTick)),
      ...(preset.videoCodec === "libx264" ? ["-preset", options.encoderPreset ?? "veryfast", "-crf", String(options.crf ?? preset.crf ?? 18)] : []),
      "-c:a", preset.audioCodec ?? "aac",
      ...(preset.audioBitrate ? ["-b:a", preset.audioBitrate] : []),
      ...(preset.faststart ? ["-movflags", "+faststart"] : []),
      "-progress", "pipe:2"
    ];
    const totalSeconds = Math.max(1, ticksToSeconds(compiled.durationTick));
    const result = await ffmpegArtifact(config, args, stagedOutput, {
      signal: options.signal, timeoutMs: 24 * 60 * 60_000,
      onProgress: (progress) => {
        const microseconds = Number(progress.out_time_us);
        if (Number.isFinite(microseconds)) options.onProgress?.(0.2 + Math.min(0.75, microseconds / 1_000_000 / totalSeconds * 0.75), "Rendering sequence");
      }
    });
    options.onProgress?.(0.97, "Verifying output");
    const [probe, hash] = await Promise.all([probeMedia(stagedOutput, config, options.signal), sha256File(stagedOutput,options.signal)]);
    if(!probe.hasAudio||!audioOnly&&!probe.hasVideo||Math.abs(probe.durationTick-outputDurationTick)>Math.max(ticksPerFrame(project.settings.fps),ticksPerSample(project.settings.sampleRate)))throw new StudioException("INVALID_RENDER_OUTPUT","Rendered streams or duration do not match the requested sequence.","runtime");
    for(const media of project.media.filter(asset=>mediaHashes.has(asset.id)))if((await sha256File(mediaPath(store,media),options.signal)).sha256!==mediaHashes.get(media.id))throw new StudioException("SOURCE_CHANGED_DURING_RENDER","A media source changed during rendering. The previous export was preserved; retry after the source is stable.","conflict");
    for(const [id,font]of captionFonts)if((await sha256File(font,options.signal)).sha256!==mediaHashes.get("caption-font:"+id))throw new StudioException("SOURCE_CHANGED_DURING_RENDER","A caption font changed during rendering. Retry with stable font assets.","conflict");
    await publishFile(stagedOutput, cachePath);
    await writeFile(`${cachePath}.json`, `${JSON.stringify({ renderKey, projectId: project.projectId, sequenceId: sequence.id, createdAt: new Date().toISOString(), presetId: preset.id, frameCount: compiled.frameCount, durationTick: outputDurationTick, sha256: hash.sha256, bytes: hash.bytes }, null, 2)}\n`, "utf8");
    await rename(stagedOutput,output);
    const cache = await pruneRenderCache(store.root, config.cacheMaxBytes, cachePath);
    options.onProgress?.(1, "Completed");
    return {
      success: true, cacheHit: false, cachePath, outputPath: path.resolve(options.outputPath), projectId: project.projectId, revision: project.revision,
      sequenceId: sequence.id, renderKey, frameCount: compiled.frameCount, durationTick: outputDurationTick, probe, ...hash,
      videoRanges:cachedVideo?.ranges??[], audioCache:cachedAudio?{cacheHit:cachedAudio.cacheHit,renderKey:cachedAudio.renderKey}:null, ffmpegCommand: { executable: config.ffmpegPath, args }, durationMs: result.durationMs, cache
    };
  } finally {
    await rm(stagedOutput,{force:true}).catch(()=>undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
