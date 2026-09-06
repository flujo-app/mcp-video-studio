import type { Browser, BrowserContext, Frame, Page } from "patchright";
import { StudioException } from "@mcp-video-studio/core";

export function browserEnvironment(): Record<string,string> {
  const env:Record<string,string>={};
  for(const name of ["PATH","HOME","USERPROFILE","SYSTEMROOT","WINDIR","TEMP","TMP","TMPDIR","XDG_CACHE_HOME","XDG_RUNTIME_DIR","FONTCONFIG_PATH"]) if(process.env[name]) env[name]=process.env[name]!;
  return env;
}
export async function prepareSandbox(browser:Browser,page:Page,context:BrowserContext,html:string,seed:number):Promise<Frame> {
  await context.route("**/*",route=>route.abort("blockedbyclient"));
  await context.routeWebSocket("**/*",socket=>socket.close());
  context.on("page",popup=>{if(popup!==page)void popup.close();});
  page.on("download",download=>void download.cancel());
  const bootstrap=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><script>
  (()=>{let now=0,state=${seed>>>0};const NativeDate=Date;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296};
  class Clock extends NativeDate {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  Object.defineProperty(window,'Date',{value:Clock});Object.defineProperty(performance,'now',{value:()=>now});Math.random=random;
  window.__studioFrame=(time,frame)=>{now=time*1000;state=((${seed>>>0})+frame)>>>0;};
  window.open=()=>null;
  const disabled=()=>{throw new Error('Use renderFrame(state) instead of wall-clock timers or animation callbacks');};
  for(const name of ['setTimeout','setInterval','requestAnimationFrame','requestIdleCallback'])Object.defineProperty(window,name,{value:disabled});
  for(const name of ['clearTimeout','clearInterval','cancelAnimationFrame','cancelIdleCallback'])Object.defineProperty(window,name,{value:()=>{}});
  Object.defineProperty(performance,'timeOrigin',{value:0});
  for(const name of ['getEntries','getEntriesByName','getEntriesByType'])Object.defineProperty(performance,name,{value:()=>[]});
  const randomValues=value=>{
    if(!ArrayBuffer.isView(value)||value instanceof DataView||value instanceof Float32Array||value instanceof Float64Array)throw new TypeError('Use an integer typed array');
    if(value.byteLength>65536)throw new RangeError('Random array is limited to 65536 bytes');
    const bytes=new Uint8Array(value.buffer,value.byteOffset,value.byteLength);for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(random()*256);return value;
  };
  Object.defineProperty(crypto,'getRandomValues',{value:randomValues});
  Object.defineProperty(crypto,'randomUUID',{value:()=>{const a=randomValues(new Uint8Array(16));a[6]=(a[6]&15)|64;a[8]=(a[8]&63)|128;const hex=Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);}});
  window.addEventListener('error',event=>{window.__studioFailure=String(event.message).slice(0,1000);});

  for(const name of ['Worker','SharedWorker','WebSocket','EventSource'])Object.defineProperty(window,name,{value:class{constructor(){throw new Error('Disabled in offline animation');}}});
  })();
  </script>`;
  await page.setContent('<!doctype html><style>html,body{margin:0;overflow:hidden;background:transparent}iframe{border:0;display:block;width:100vw;height:100vh}</style><iframe id="animation" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>');
  await page.locator("iframe").evaluate((element,source)=>{(element as HTMLIFrameElement).srcdoc=source;},bootstrap+html);
  await page.waitForFunction(()=>document.querySelector("iframe")?.getAttribute("srcdoc")!==null);
  const frame=await page.locator("iframe").elementHandle().then(element=>element?.contentFrame());
  if(!frame)throw new StudioException("SANDBOX_FAILED","Could not initialize the animation sandbox.","runtime");
  const allowNavigation=(target:Frame)=>target!==frame||target.url()==="about:srcdoc";
  if(!allowNavigation(frame)){await page.close();throw new StudioException("ANIMATION_NAVIGATION","HTML animations must remain in their original offline document.","policy");}
  page.on("framenavigated",target=>{if(!allowNavigation(target))void page.close();});

  const deadline=Date.now()+10000;
  while(!await frame.evaluate(()=>typeof (window as unknown as {__studioFrame?:unknown}).__studioFrame==="function",undefined,false)){if(Date.now()>deadline)throw new StudioException("SANDBOX_FAILED","Animation did not initialize before the deadline.","runtime");await new Promise(resolve=>setTimeout(resolve,25));}
  await frame.evaluate(()=>document.fonts.ready.then(()=>undefined));
  return frame;
}
