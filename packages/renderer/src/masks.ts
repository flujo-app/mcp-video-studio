import {MaskParametersSchema} from "@mcp-video-studio/contracts";
import {StudioException} from "@mcp-video-studio/core";
/** Numeric, frame-independent coverage. No caller text enters the expression language. */
export function maskFilters(parameters:Record<string,unknown>,labelPrefix="mask"):string[]{
 if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(labelPrefix))throw new Error("Invalid internal mask label.");
 const parsed=MaskParametersSchema.safeParse(parameters);
 if(!parsed.success)throw new StudioException("INVALID_MASK","Mask requires bounded rectangle/ellipse geometry and scalar controls.","input");
 const m=parsed.data,x="(X+0.5)",y="(Y+0.5)";
 const distance=m.shape==="rectangle"?
  `min(min(${x}-${m.x}*W,${m.x+m.width}*W-${x}),min(${y}-${m.y}*H,${m.y+m.height}*H-${y}))`:
  `(1-sqrt(pow((${x}-${m.x+m.width/2}*W)/(${m.width/2}*W),2)+pow((${y}-${m.y+m.height/2}*H)/(${m.height/2}*H),2)))*min(${m.width/2}*W,${m.height/2}*H)`;
 const inside=m.feather===0?`gte(${distance},0)`:`clip((${distance})/(${m.feather}*min(W,H)),0,1)`;
 const coverage=(m.invert?"(1-("+inside+"))":inside)+"*"+m.opacity;
 // Extract alpha before planar RGB conversion: swscale can round 8-bit alpha upward.
 return[`format=rgba,split=2[${labelPrefix}rgb][${labelPrefix}src];[${labelPrefix}src]alphaextract,geq=lum='lum(X,Y)*(${coverage})':interpolation=nearest[${labelPrefix}alpha];[${labelPrefix}rgb][${labelPrefix}alpha]alphamerge`];
}
