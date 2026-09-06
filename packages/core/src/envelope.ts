import type {AutomationPoint} from "@mcp-video-studio/contracts";
import {StudioException} from "./errors.js";
function invalid(message:string):never{throw new StudioException("INVALID_AUTOMATION",message,"input");}
export function envelopeValue(points:AutomationPoint[],tick:number):number{
 const before=[...points].reverse().find(point=>point.tick<=tick);
 if(!before)return 0;
 const after=points.find(point=>point.tick>tick);
 if(!after||before.curve==="hold")return before.value;
 return before.value+(after.value-before.value)*(tick-before.tick)/(after.tick-before.tick);
}
/** Replace only the selected sample interval, including discontinuities at its edges. */
export function spliceEnvelope(input:AutomationPoint[],start:number,end:number,value:number,sample:number):AutomationPoint[]{
 const points=[...input].sort((a,b)=>a.tick-b.tick);
 if(!Number.isSafeInteger(sample)||sample<1||start<0||end<=start||start%sample||end%sample||!Number.isFinite(value))invalid("Envelope edits must use a positive sample-aligned interval.");
 for(let index=0;index<points.length;index++){const point=points[index]!;if(point.tick<0||point.tick%sample||!Number.isFinite(point.value)||!["hold","linear"].includes(point.curve)||index>0&&points[index-1]!.tick===point.tick)invalid("Envelope points require unique sample times and hold/linear curves.");}
 const result=new Map(points.filter(point=>point.tick<start||point.tick>=end).map(point=>[point.tick,{...point}]));
 if(start>0)result.set(start-sample,{tick:start-sample,value:envelopeValue(points,start-sample),curve:"hold"});
 result.set(start,{tick:start,value,curve:"hold"});
 const previous=[...points].reverse().find(point=>point.tick<=end);
 result.set(end,{tick:end,value:envelopeValue(points,end),curve:previous?.curve??"hold"});
 return [...result.values()].sort((a,b)=>a.tick-b.tick);
}
