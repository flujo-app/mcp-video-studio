import type {EvaluatedAnimationNode} from "./evaluate.js";
export interface AnimationFrame {width:number;height:number;background:string;seed:number;time:number}
export interface AnimationHitRegion {id:string;x:number;y:number;width:number;height:number}
/** Self-contained so the same painter runs in the editor and isolated export browser. */
export function createAnimationPainter(canvas:HTMLCanvasElement){
 const context=canvas.getContext("2d");if(!context)throw new Error("A 2D canvas is required.");const ctx=context;
 const assets=new Map<string,Promise<HTMLImageElement|HTMLVideoElement>>();
 const number=(value:unknown,fallback:number)=>typeof value==="number"&&Number.isFinite(value)?value:fallback;
 const color=(value:unknown,fallback:string)=>typeof value==="string"?value:fallback;
 const asset=(type:string,src:string)=>{
  let pending=assets.get(src);if(!pending){
   pending=new Promise<HTMLImageElement|HTMLVideoElement>((resolve,reject)=>{
    if(!/^data:(?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,/.test(src)||src.length>12*1024*1024){reject(new Error("Animation assets must be bounded self-contained data URLs."));return;}
    const image=type==="image"?new Image():document.createElement("video");
    const timeout=setTimeout(()=>reject(new Error("Animation asset decode timed out.")),10000);
    const finish=()=>{clearTimeout(timeout);resolve(image);};
    image.onerror=()=>{clearTimeout(timeout);reject(new Error("Animation asset cannot be decoded."));};
    if(image instanceof HTMLVideoElement){image.muted=true;image.preload="auto";image.requestVideoFrameCallback(()=>finish());}else image.onload=finish;
    image.src=src;
   });assets.set(src,pending);
  }return pending;
 };
 const transform=(node:EvaluatedAnimationNode)=>{
  const t=node.transform;ctx.globalAlpha*=Math.max(0,Math.min(1,t.opacity));ctx.translate(t.position[0],t.position[1]);ctx.rotate(t.rotation*Math.PI/180);ctx.scale(t.scale[0],t.scale[1]);
  if(node.type==="group")ctx.translate(-number(node.properties.width,0)*t.anchor[0],-number(node.properties.height,0)*t.anchor[1]);
 };
 return async(nodes:EvaluatedAnimationNode[],frame:AnimationFrame):Promise<AnimationHitRegion[]>=>{
  if(canvas.width!==frame.width)canvas.width=frame.width;if(canvas.height!==frame.height)canvas.height=frame.height;
  ctx.setTransform(1,0,0,1,0,0);ctx.globalAlpha=1;ctx.clearRect(0,0,canvas.width,canvas.height);
  if(frame.background!=="transparent"){ctx.fillStyle=frame.background;ctx.fillRect(0,0,canvas.width,canvas.height);}
  const byId=new Map(nodes.map(node=>[node.id,node])),regions:AnimationHitRegion[]=[];
  const camera=nodes.find(node=>node.type==="camera"&&node.visible&&node.properties.active!==false);
  ctx.save();
  if(camera){const t=camera.transform,zoom=Math.max(.0001,number(camera.properties.zoom,1));ctx.translate(frame.width*t.anchor[0],frame.height*t.anchor[1]);ctx.scale(zoom*t.scale[0],zoom*t.scale[1]);ctx.rotate(-t.rotation*Math.PI/180);ctx.translate(-frame.width*t.anchor[0]-t.position[0],-frame.height*t.anchor[1]-t.position[1]);}
  for(const node of nodes){
   if(!node.visible||node.type==="camera"||node.type==="group")continue;
   const ancestors:EvaluatedAnimationNode[]=[];let parent=node.parentId;
   while(parent){const owned=byId.get(parent);if(!owned||ancestors.length>2000||ancestors.includes(owned))throw new Error("Invalid animation hierarchy.");ancestors.unshift(owned);parent=owned.parentId;}
   if(ancestors.some(ancestor=>!ancestor.visible||ancestor.transform.opacity<=0)||node.transform.opacity<=0)continue;
   ctx.save();for(const ancestor of ancestors)transform(ancestor);transform(node);
   const p=node.properties,t=node.transform,w=number(p.width,100),h=number(p.height,100),x=-w*t.anchor[0],y=-h*t.anchor[1];
   ctx.fillStyle=color(p.fill,"#ffffff");ctx.strokeStyle=color(p.stroke,"#ffffff");ctx.lineWidth=number(p.strokeWidth,4);
   let bounds={x,y,width:w,height:h};
   if(node.type==="rect"){if(p.fill!=="none")ctx.fillRect(x,y,w,h);if(p.stroke)ctx.strokeRect(x,y,w,h);}
   else if(node.type==="ellipse"){ctx.beginPath();ctx.ellipse(x+w/2,y+h/2,w/2,h/2,0,0,Math.PI*2);if(p.fill!=="none")ctx.fill();if(p.stroke)ctx.stroke();}
   else if(node.type==="line"){
    const x1=number(p.x1,0),y1=number(p.y1,0),x2=number(p.x2,100),y2=number(p.y2,0);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();bounds={x:Math.min(x1,x2)-ctx.lineWidth,y:Math.min(y1,y2)-ctx.lineWidth,width:Math.abs(x2-x1)+2*ctx.lineWidth,height:Math.abs(y2-y1)+2*ctx.lineWidth};
   }else if(node.type==="path"){
    const shape=new Path2D(String(p.path??p.d??""));ctx.translate(x,y);if(p.fill!=="none")ctx.fill(shape);if(p.stroke)ctx.stroke(shape);ctx.translate(-x,-y);
   }else if(node.type==="text"){
    ctx.font=String(p.fontWeight??600)+" "+number(p.fontSize,64)+"px "+String(p.fontFamily??"sans-serif");ctx.textAlign=(p.textAlign==="left"||p.textAlign==="right"?p.textAlign:"center");ctx.textBaseline="middle";
    const text=String(p.text??node.name),glyphs=Array.from(new Intl.Segmenter(undefined,{granularity:"grapheme"}).segment(text),segment=>segment.segment),visible=glyphs.slice(0,Math.ceil(glyphs.length*Math.max(0,Math.min(1,number(p.reveal,1))))).join("");
    ctx.fillText(visible,0,0);const metrics=ctx.measureText(text);bounds={x:ctx.textAlign==="center"?-metrics.width/2:ctx.textAlign==="right"?-metrics.width:0,y:-number(p.fontSize,64)/2,width:metrics.width,height:number(p.fontSize,64)};
   }else if(node.type==="particles"){
    const count=Math.max(1,Math.min(5000,Math.floor(number(p.count,100)))),lifetime=Math.max(.001,number(p.lifetime,2)),size=number(p.size,3),speed=number(p.speed,60),spread=number(p.spread,360),gravity=number(p.gravity,0);
    let seed=(frame.seed^Array.from(node.id).reduce((hash,ch)=>(Math.imul(hash,31)+ch.charCodeAt(0))|0,0))>>>0;
    const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    for(let i=0;i<count;i++){const phase=random()*lifetime,angle=(number(p.direction,-90)+(random()-.5)*spread)*Math.PI/180,velocity=speed*(.5+random()),age=((frame.time+phase)%lifetime+lifetime)%lifetime;ctx.save();ctx.globalAlpha*=1-age/lifetime;ctx.beginPath();ctx.arc(Math.cos(angle)*velocity*age,Math.sin(angle)*velocity*age+gravity*age*age/2,size,0,Math.PI*2);ctx.fill();ctx.restore();}
   }else if(node.type==="image"||node.type==="video"){
    const image=await asset(node.type,String(p.src??""));
    if(image instanceof HTMLVideoElement){
     const target=Math.max(0,Math.min(Math.max(0,image.duration-.000001),number(p.sourceTime,0)+frame.time));
     if(Math.abs(image.currentTime-target)>.0000001)await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error("Animation video seek timed out.")),10000);image.requestVideoFrameCallback(()=>{clearTimeout(timeout);resolve();});image.currentTime=target;});
    }
    ctx.drawImage(image,x,y,w,h);
   }else throw new Error("Unsupported animation node "+node.type);
   const matrix=ctx.getTransform(),corners=[[bounds.x,bounds.y],[bounds.x+bounds.width,bounds.y],[bounds.x,bounds.y+bounds.height],[bounds.x+bounds.width,bounds.y+bounds.height]].map(([px,py])=>matrix.transformPoint({x:px!,y:py!})),xs=corners.map(point=>point.x),ys=corners.map(point=>point.y);
   regions.push({id:node.id,x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)});ctx.restore();
  }
  ctx.restore();return regions;
 };
}
