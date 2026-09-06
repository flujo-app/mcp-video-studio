import type {EvaluatedAnimationNode} from "./evaluate.js";
import type {AnimationFrame,AnimationHitRegion} from "./painter.js";
type Painter=(nodes:EvaluatedAnimationNode[],frame:AnimationFrame)=>Promise<AnimationHitRegion[]>;
/** Self-contained browser function: redraw the same immutable frame after bounded backing-store loss. */
export function createAnimationCapture(initialCanvas:HTMLCanvasElement,makePainter:(canvas:HTMLCanvasElement)=>Painter){
 let canvas=initialCanvas,paint:Painter|undefined;
 return async(nodes:EvaluatedAnimationNode[],frame:AnimationFrame):Promise<{png:string;recoveries:number}>=>{
  for(let attempt=0;attempt<3;attempt++){
   if(!paint){canvas.width=frame.width;canvas.height=frame.height;paint=makePainter(canvas);}
   await paint(nodes,frame);
   const context=canvas.getContext("2d");
   if(!context)throw new Error("Animation canvas context is missing.");
   if(!context.isContextLost()){
    const png=canvas.toDataURL("image/png");
    if(!context.isContextLost()&&png.startsWith("data:image/png;base64,"))return{png,recoveries:attempt};
   }
   if(attempt===2)throw new Error("Animation canvas context could not be restored after three frame attempts.");
   const replacement=canvas.cloneNode(false) as HTMLCanvasElement;
   canvas.replaceWith(replacement);canvas=replacement;paint=undefined;
   await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  }
  throw new Error("Animation frame capture failed.");
 };
}
