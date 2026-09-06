import {z} from "zod";
export const MaskParametersSchema=z.object({
 shape:z.enum(["rectangle","ellipse"]).default("rectangle"),
 x:z.number().finite().min(0).max(1).default(.25),
 y:z.number().finite().min(0).max(1).default(.25),
 width:z.number().finite().min(.001).max(1).default(.5),
 height:z.number().finite().min(.001).max(1).default(.5),
 feather:z.number().finite().min(0).max(.5).default(0),
 opacity:z.number().finite().min(0).max(1).default(1),
 invert:z.boolean().default(false)
}).strict().superRefine((mask,context)=>{
 if(mask.x+mask.width>1.000000001||mask.y+mask.height>1.000000001)context.addIssue({code:"custom",message:"Mask bounds must fit inside the clip rectangle."});
 if(mask.feather>Math.min(mask.width,mask.height)/2)context.addIssue({code:"custom",message:"Feather cannot exceed half the smaller mask dimension."});
});
export type MaskParameters=z.infer<typeof MaskParametersSchema>;
