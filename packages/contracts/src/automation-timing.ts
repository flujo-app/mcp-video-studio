import type {AutomationPoint} from "./types.js";
export function isAudioAutomation(target:string):boolean{return /^(clip|track):[^:]+:(gainDbOffset|audio\.)/.test(target);}
function valueAt(points:AutomationPoint[],tick:number):AutomationPoint|undefined{
 const before=[...points].reverse().find(point=>point.tick<=tick);if(!before)return undefined;
 const after=points.find(point=>point.tick>tick);
 return{tick,value:!after||before.curve==="hold"?before.value:before.value+(after.value-before.value)*(tick-before.tick)/(after.tick-before.tick),curve:before.curve};
}
/** Shift a lane onto its target clock. Later authored points win rounding collisions. */
export function shiftAutomationPoints(input:AutomationPoint[],offset:number,quantum=1):AutomationPoint[]{
 const points=[...input].sort((a,b)=>a.tick-b.tick),result=new Map<number,AutomationPoint>();
 const first=valueAt(points,-offset);if(offset<0&&first)result.set(0,{...first,tick:0});
 for(const point of points)if(point.tick+offset>=0){const tick=Math.max(0,Math.round((point.tick+offset)/quantum)*quantum);result.set(tick,{...point,tick});}
 return [...result.values()].sort((a,b)=>a.tick-b.tick);
}
/** Splice a hold/linear sampled envelope without stretching retained ramps. */
export function rippleAutomationPoints(input:AutomationPoint[],tick:number,amount:number,quantum:number):AutomationPoint[]{
 const points=[...input].sort((a,b)=>a.tick-b.tick),result=new Map<number,AutomationPoint>(),start=amount>0?tick:tick+amount;
 const first=Math.ceil(start/quantum)*quantum,left=first-quantum;
 const put=(at:number,source:number,hold=false)=>{const value=valueAt(points,source);if(value)result.set(at,{...value,tick:at,...(hold?{curve:"hold" as const}:{})});};
 if(amount>0){put(first,tick,true);const resume=Math.ceil((tick+amount)/quantum)*quantum;put(resume,resume-amount);}
 else put(first,first-amount);
 for(const point of points){
  if(amount<0&&point.tick>=start&&point.tick<tick)continue;
  const mapped=point.tick>=tick?point.tick+amount:point.tick;
  const at=Math.max(0,Math.round(mapped/quantum)*quantum);result.set(at,{...point,tick:at});
 }
 if(left>=0)put(left,left,true);
 return [...result.values()].sort((a,b)=>a.tick-b.tick);
}
