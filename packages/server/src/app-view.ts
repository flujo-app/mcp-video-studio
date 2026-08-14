function scriptString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function createStudioAppHtml(studioUrl: string): string {
  const embeddedUrl = new URL(studioUrl);
  embeddedUrl.searchParams.set("mcpApp", "1");
  const serializedUrl = scriptString(embeddedUrl.toString());

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,iframe{border:0;margin:0;width:100%;height:100%;min-height:760px;background:#080b10}iframe{display:block}</style></head><body><iframe id="studio" allow="autoplay; fullscreen; picture-in-picture" title="MCP Video Studio"></iframe><script>(()=>{const frame=document.getElementById("studio");const host=window.parent;if(host!==window){window.addEventListener("message",event=>{if(event.source===frame.contentWindow){host.postMessage(event.data,"*");}else if(event.source===host){frame.contentWindow?.postMessage(event.data,"*");}});}frame.src=${serializedUrl};})();</script></body></html>`;
}
