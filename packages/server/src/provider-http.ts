import { setTimeout as delay } from "node:timers/promises";
import { StudioException } from "@mcp-video-studio/core";

export function validateProviderUrl(value:string):URL{
 const url=new URL(value);
 if(url.username||url.password||url.hash)throw new StudioException("PROVIDER_URL","Provider URLs cannot contain credentials or fragments.","input");
 const loopback=["127.0.0.1","localhost","[::1]"].includes(url.hostname);
 if(url.protocol!=="https:"&&!(url.protocol==="http:"&&loopback))throw new StudioException("PROVIDER_URL","Use HTTPS, or HTTP for an explicit loopback provider.","input");
 for(const key of url.searchParams.keys())if(/key|token|secret|password/i.test(key))throw new StudioException("PROVIDER_URL","Credentials belong in provider headers, never URLs.","input");
 return url;
}
export async function providerFetch(value:string,init:RequestInit, secrets:string[]=[]):Promise<Response>{
 const url=validateProviderUrl(value),signal=AbortSignal.any([...(init.signal?[init.signal]:[]),AbortSignal.timeout(180000)]);
 try{
  for(let attempt=0;;attempt++){
   const response=await fetch(url,{...init,signal,redirect:"manual"});
   if(response.status===429&&attempt===0){await response.body?.cancel();const seconds=Math.max(0,Math.min(2,Number(response.headers.get("retry-after"))||1));await delay(seconds*1000,undefined,{signal});continue;}
   if(!response.ok){await response.body?.cancel();return new Response(null,{status:response.status});}
   const type=response.headers.get("content-type")??"",limit=type.includes("json")||type.startsWith("text/")?2_000_000:64_000_000;
   const size=Number(response.headers.get("content-length"));
   if(size>limit){await response.body?.cancel();throw new StudioException("PROVIDER_RESPONSE_LIMIT","Provider response exceeds the configured byte limit.","runtime");}
   const reader=response.body?.getReader(),parts:Uint8Array[]=[];let total=0;
   if(reader){try{for(;;){const {done,value:chunk}=await reader.read();if(done)break;total+=chunk.byteLength;if(total>limit){await reader.cancel();throw new StudioException("PROVIDER_RESPONSE_LIMIT","Provider response exceeds the configured byte limit.","runtime");}parts.push(chunk);}}finally{reader.releaseLock();}}
   let bytes:Uint8Array<ArrayBuffer>=new Uint8Array(total);let offset=0;for(const chunk of parts){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   if(type.includes("json")||type.startsWith("text/")){
    let text=new TextDecoder().decode(bytes);for(const secret of secrets.filter(Boolean))text=text.split(secret).join("[REDACTED]");
    bytes=new TextEncoder().encode(text);
   }
   return new Response(bytes,{status:response.status,headers:{"content-type":type}});
  }
 }catch(error){
  if(error instanceof StudioException)throw error;
  throw new StudioException(init.signal?.aborted?"CANCELLED":signal.aborted?"PROVIDER_TIMEOUT":"PROVIDER_NETWORK",init.signal?.aborted?"Provider request cancelled.":signal.aborted?"Provider request exceeded its deadline.":"Provider request failed before a complete response. Retry explicitly after checking provider status.","runtime");
 }
}
