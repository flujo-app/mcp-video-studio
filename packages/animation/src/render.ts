import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prepareSandbox, browserEnvironment } from "./sandbox.js";
import { chromium } from "patchright";
import { ticksPerFrame, type AnimationDocument, type Rational } from "@mcp-video-studio/contracts";
import { sha256File, StudioException } from "@mcp-video-studio/core";
import { ffmpegArtifact, type StudioConfig } from "@mcp-video-studio/media";
import { evaluateAnimation } from "./evaluate.js";

export const ANIMATION_RENDERER_VERSION=2;

const RENDERER_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;overflow:hidden;background:transparent}canvas{display:block}</style></head><body><canvas id="canvas"></canvas><script>
const canvas=document.getElementById('canvas');const ctx=canvas.getContext('2d');
window.__setup=(w,h,bg)=>{canvas.width=w;canvas.height=h;window.__background=bg};
function color(value,fallback){return typeof value==='string'?value:fallback}
window.__applyState=(nodes)=>{ctx.clearRect(0,0,canvas.width,canvas.height);if(window.__background&&window.__background!=='transparent'){ctx.fillStyle=window.__background;ctx.fillRect(0,0,canvas.width,canvas.height)}for(const node of nodes){if(!node.visible||node.transform.opacity<=0)continue;const t=node.transform,p=node.properties||{};ctx.save();ctx.globalAlpha=t.opacity;ctx.translate(t.position[0],t.position[1]);ctx.rotate(t.rotation*Math.PI/180);ctx.scale(t.scale[0],t.scale[1]);if(node.type==='rect'){ctx.fillStyle=color(p.fill,'#fff');ctx.fillRect(-(p.width||100)*t.anchor[0],-(p.height||100)*t.anchor[1],p.width||100,p.height||100)}else if(node.type==='ellipse'){ctx.fillStyle=color(p.fill,'#fff');ctx.beginPath();ctx.ellipse(0,0,(p.width||100)/2,(p.height||100)/2,0,0,Math.PI*2);ctx.fill()}else if(node.type==='line'){ctx.strokeStyle=color(p.stroke,'#fff');ctx.lineWidth=p.strokeWidth||4;ctx.beginPath();ctx.moveTo(p.x1||0,p.y1||0);ctx.lineTo(p.x2||100,p.y2||0);ctx.stroke()}else if(node.type==='text'){ctx.fillStyle=color(p.fill,'#fff');ctx.font=(p.fontWeight||600)+' '+(p.fontSize||64)+'px '+(p.fontFamily||'sans-serif');ctx.textAlign=p.textAlign||'center';ctx.textBaseline='middle';ctx.fillText(p.text||node.name,0,0)}ctx.restore()}};
</script></body></html>`;

export interface AnimationRenderOptions {
  outputPath: string;
  fps: Rational;
  signal?: AbortSignal | undefined;
  onProgress?: ((progress: number) => void) | undefined;
}

export async function renderAnimation(document: AnimationDocument, config: StudioConfig, options: AnimationRenderOptions): Promise<Record<string, unknown>> {
  if (document.mode === "html" && !document.html?.trim()) throw new StudioException("HTML_REQUIRED", "HTML animations require a self-contained html document.", "input");
  const perFrame = ticksPerFrame(options.fps);
  const frameCount = Math.ceil(document.durationTick / perFrame);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 108_000 || document.canvas.width * document.canvas.height > 8_294_400 || document.canvas.width < 1 || document.canvas.height < 1) throw new StudioException("RENDER_LIMIT", "Animation must fit 4K pixels and 108000 frames.", "policy");
  if (options.signal?.aborted) throw new StudioException("CANCELLED", "Animation render cancelled.", "runtime");
  const scratch = path.join(config.scratchDir, `animation-${randomUUID()}`);
  const frames = path.join(scratch, "frames");
  await mkdir(frames, { recursive: true });
  const browser = await chromium.launch({ headless: true, env: browserEnvironment() }).catch(async error=>{await rm(scratch,{recursive:true,force:true}).catch(()=>undefined);throw error;});
  const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, viewport: { width: document.canvas.width, height: document.canvas.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
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
    if (document.mode === "declarative") await page.evaluate(([w,h,bg]) => { (window as unknown as {__setup:(w:unknown,h:unknown,bg:unknown)=>void}).__setup(w,h,bg); }, [document.canvas.width, document.canvas.height, document.canvas.background], false);
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (options.signal?.aborted) throw new StudioException("CANCELLED", "Animation render was cancelled.", "runtime");
      const tick = frame * perFrame;
      if (document.mode === "declarative") {
        const state = evaluateAnimation(document, tick);
        await page.evaluate(nodes => { (window as unknown as {__applyState:(nodes:unknown)=>void}).__applyState(nodes); }, state, false);
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
      await page.screenshot({ path: path.join(frames, `${String(frame).padStart(8, "0")}.png`), type: "png", omitBackground: document.canvas.background === "transparent", animations: "allow", caret: "hide" });
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
