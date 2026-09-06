import React,{useEffect,useState} from "react";
import {ticksToSeconds,type JobRecord,type ProjectCommand,type Sequence,type StudioProject} from "@mcp-video-studio/contracts";
type Check={id:string;status:string;message:string;checkId?:string;startTick?:number;endTick?:number;clipIds?:string[];captionIds?:string[];allowanceId?:string;observed?:Record<string,unknown>};
type Props={project:StudioProject;sequence:Sequence;jobs:JobRecord[];projectPath:string;request(route:string,input:Record<string,unknown>):Promise<unknown>;onMutate(commands:ProjectCommand[]):Promise<void>;onNavigate(tick:number,clipIds:string[],captionIds?:string[]):void;onError(message:string):void};
export function QualityControl({project,sequence,jobs,projectPath,request,onMutate,onNavigate,onError}:Props){
 const [filePath,setFilePath]=useState(""),[busy,setBusy]=useState(false),[reason,setReason]=useState("");
 const render=jobs.find(job=>job.type==="render"&&job.status==="completed"&&job.result?.projectId===project.projectId&&job.result?.sequenceId===sequence.id);
 useEffect(()=>{if(typeof render?.result?.outputPath==="string")setFilePath(render.result.outputPath);},[render?.id]);
 const report=jobs.find(job=>job.type==="qc"&&job.status==="completed"&&job.result?.projectId===project.projectId&&job.result?.sequenceId===sequence.id);
 const checks=Array.isArray(report?.result?.checks)?report.result.checks as Check[]:[];
 const run=async()=>{setBusy(true);try{await request("/api/qc",{projectPath,sequenceId:sequence.id,filePath});}catch(error){onError(error instanceof Error?error.message:String(error));}finally{setBusy(false);}};
 const allow=(check:Check)=>{if(check.startTick===undefined||check.endTick===undefined||!reason.trim()||!["video.black","video.freeze","audio.silence"].includes(check.checkId??""))return;void onMutate([{type:"qc.allowance.set",sequenceId:sequence.id,allowance:{id:crypto.randomUUID(),checkId:check.checkId as "video.black"|"video.freeze"|"audio.silence",startTick:check.startTick,endTick:check.endTick,reason:reason.trim()}}]);};
 return <section aria-label="Quality control"><h3>Quality control</h3>
 <label>File to inspect<input value={filePath} onChange={event=>setFilePath(event.currentTarget.value)}/></label>
 <button disabled={!filePath||busy} onClick={()=>void run()}>Analyze export</button>
 <p>Review detected ranges on the timeline. Intentional black, freeze or silence allowances are saved with the project and appear in the next report.</p>
 <label>Intentional range reason<input maxLength={1000} value={reason} onChange={event=>setReason(event.currentTarget.value)}/></label>
 {report&&<p role="status">QC revision {String(report.result?.revision)}{report.result?.revision!==project.revision?" — project changed; analyze again":""}</p>}
 <ol className="qc-checks">{checks.map(check=><li key={check.id} data-qc-check={check.checkId??check.id}><strong>{check.status} {check.checkId??check.id}</strong><p>{check.message}</p>
 {check.startTick!==undefined&&<><button aria-label={"Jump to "+check.id} onClick={()=>onNavigate(check.startTick!,check.clipIds??[],check.captionIds)}>{ticksToSeconds(check.startTick).toFixed(3)}–{ticksToSeconds(check.endTick??check.startTick).toFixed(3)}s · Show on timeline</button>
 {!check.allowanceId&&["video.black","video.freeze","audio.silence"].includes(check.checkId??"")&&<button disabled={!reason.trim()||report?.result?.revision!==project.revision} onClick={()=>allow(check)}>Mark intentional {check.checkId}</button>}</>}
 {check.observed&&<details><summary>Measured values</summary><pre>{JSON.stringify(check.observed,null,2)}</pre></details>}</li>)}</ol>
 {!!sequence.qcAllowances?.length&&<fieldset><legend>Saved intentional ranges</legend>{sequence.qcAllowances.map(item=><div key={item.id}><p>{item.checkId}: {ticksToSeconds(item.startTick).toFixed(3)}–{ticksToSeconds(item.endTick).toFixed(3)}s — {item.reason}</p><button onClick={()=>void onMutate([{type:"qc.allowance.remove",sequenceId:sequence.id,allowanceId:item.id}])}>Remove allowance {item.checkId}</button></div>)}</fieldset>}
 </section>;
}
