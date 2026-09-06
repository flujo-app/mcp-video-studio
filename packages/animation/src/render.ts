import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareSandbox, browserEnvironment } from "./sandbox.js";
import { chromium } from "patchright";
import { ticksPerFrame, type AnimationDocument, type Rational } from "@mcp-video-studio/contracts";
import { sha256File, StudioException } from "@mcp-video-studio/core";
import { ffmpegArtifact, type StudioConfig } from "@mcp-video-studio/media";
import { animationProblems } from "@mcp-video-studio/contracts";
import { createAnimationPainter } from "./painter.js";
import { evaluateAnimation } from "./evaluate.js";

export const ANIMATION_RENDERER_VERSION=4;

const RENDERER_HTML = '<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;overflow:hidden;background:transparent}canvas{display:block}</style></head><body><canvas id="canvas"></canvas><script>window.__applyState=('+createAnimationPainter.toString()+')(document.getElementById("canvas"));</script></body></html>';

export interface AnimationRenderOptions {
  outputPath: string;
  fps: Rational;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: number) => void) | undefined;
}

export async function renderAnimation(document: AnimationDocument, config: StudioConfig, options: AnimationRenderOptions): Promise<Record<string, unknown>> {
  const problems=animationProblems(document);if(problems.length)throw new StudioException("INVALID_ANIMATION",problems[0]!,"input",{problems});
  if (document.mode === "html" && !document.html?.trim()) throw new StudioException("HTML_REQUIRED", "HTML animations require a self-contained html document.", "input");
  const perFrame = ticksPerFrame(options.fps);
  const frameCount = Math.ceil(document.durationTick / perFrame);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 108_000 || document.canvas.width * document.canvas.height > 8_294_400 || document.canvas.width < 1 || document.canvas.height < 1) throw new StudioException("RENDER_LIMIT", "Animation must fit 4K pixels and 108000 frames.", "policy");
  if (options.signal?.aborted) throw new StudioException("CANCELLED", "Animation render cancelled.", "runtime");
  const scratch = path.join(config.scratchDir, `animation-${randomUUID()}`);
  const frames = path.join(scratch, "frames");
  await mkdir(frames, { recursive: true });
  const browser = await chromium.launch({ headless: true, env: browserEnvironment() }).catch(async error=>{await rm(scratch,{recursive:true,force:true}).catch(()=>undefined);throw error;});
  const startupFailure=async(error:unknown):Promise<never>=>{await browser.close().catch(()=>undefined);await rm(scratch,{recursive:true,force:true}).catch(()=>undefined);throw error;};
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: document.canvas.width, height: document.canvas.height }, deviceScaleFactor: 1 }).catch(startupFailure);
  const page = await context.newPage().catch(startupFailure);
  page.setDefaultTimeout(10000);
  let timedOut=false;
  const abort=()=>{void browser.close();};
  options.signal?.addEventListener("abort",abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;abort();}, Math.min(30*60_000, 30000+frameCount*2000));
  timer.unref();
  try {
    let target: import("patchright").Frame | import("patchright").Page = page;
    if(document.mode === "html") target=await prepareSandbox(browser,page,context,document.html!,document.seed);
    else {await context.route("**/*",route=>route.abort());await page.setContent(RENDERER_HTML,{waitUntil:"load"});await page.evaluate(()=>globalThis.document.fonts.ready.then(()=>undefined));}
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (options.signal?.aborted) throw new StudioException("CANCELLED", "Animation render was cancelled.", "runtime");
      const tick = frame * perFrame;
      if (document.mode === "declarative") {
        const state = evaluateAnimation(document, tick);
        await page.evaluate(async ({nodes,frame}) => { await (window as unknown as {__applyState:(nodes:unknown,frame:unknown)=>Promise<unknown>}).__applyState(nodes,frame); }, {nodes:state,frame:{...document.canvas,seed:document.seed,time:tick/35_280_000}}, false);
      } else {
        await target.evaluate(async state => {
          const host=window as unknown as {__studioFrame:(time:number,frame:number)=>void;__studioFailure?:string;renderFrame?:(state:unknown)=>unknown};
          if(host.__studioFailure)throw new Error(host.__studioFailure);
          host.__studioFrame(state.time,state.frame);
          for(const animation of globalThis.document.getAnimations()){animation.pause();animation.currentTime=state.time*1000;}
          if(typeof host.renderFrame!=="function")throw new Error("HTML animation must define renderFrame(state).");
          await host.renderFrame(state);
        }, { frame, tick, time: tick / 35_280_000, seed: document.seed }, false);
      }
      const framePath=path.join(frames,String(frame).padStart(8,"0")+".png");
      if(document.mode==="declarative"){
        // Capture the completed canvas bitmap directly. Browser compositor screenshots can
        // race transparent GPU surface presentation on macOS even after drawing completes.
        const png=await page.evaluate(()=>{const canvas=globalThis.document.querySelector("canvas");if(!(canvas instanceof HTMLCanvasElement))throw new Error("Animation canvas is missing.");return canvas.toDataURL("image/png");});
        await writeFile(framePath,Buffer.from(png.slice("data:image/png;base64,".length),"base64"));
      }else await page.screenshot({path:framePath,type:"png",omitBackground:document.canvas.background==="transparent",animations:"allow",caret:"hide"});
      options.onProgress?.((frame + 1) / (frameCount + 1));
    }
    const fpsText = `${options.fps.numerator}/${options.fps.denominator}`;
    await ffmpegArtifact(config, ["-framerate", fpsText, "-start_number", "0", "-i", path.join(frames, "%08d.png"), "-frames:v", String(frameCount), "-c:v", "ffv1", "-level", "3", "-pix_fmt", "bgra"], options.outputPath, { signal: options.signal, timeoutMs: 12 * 60 * 60_000 });
    options.onProgress?.(1);
    return { outputPath: path.resolve(options.outputPath), frameCount, durationTick: frameCount * perFrame, ...(await sha256File(options.outputPath)) };
  } catch(error) {
    if(options.signal?.aborted) throw new StudioException("CANCELLED","Animation render cancelled.","runtime");
    if(timedOut) throw new StudioException("RENDER_TIMEOUT","Animation exceeded its bounded rendering deadline.","runtime");
    throw error;
  } finally {
    clearTimeout(timer);options.signal?.removeEventListener("abort",abort);
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}
