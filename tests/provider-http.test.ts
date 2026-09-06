import { createServer,type ServerResponse } from "node:http";
import { afterEach,expect,it } from "vitest";
import { providerFetch,validateProviderUrl } from "../packages/server/src/provider-http.js";
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{await Promise.all(closers.splice(0).map(close=>close()));});
async function endpoint(handler:(response:ServerResponse,path:string)=>void){const server=createServer((q,r)=>handler(r,q.url??""));await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));closers.push(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});return "http://127.0.0.1:"+(server.address() as {port:number}).port;}
it("never follows provider redirects or returns provider error bodies/secret-bearing request IDs",async()=>{
 let destination=0;const url=await endpoint((res,p)=>{if(p==="/redirect"){res.writeHead(302,{location:"/target"});res.end();}else if(p==="/error"){res.writeHead(400);res.end("secret-key");}else{destination++;res.end("no");}});
 expect((await providerFetch(url+"/redirect",{method:"POST"})).status).toBe(302);expect(destination).toBe(0);
 expect(await (await providerFetch(url+"/error",{})).text()).toBe("");
});
it("bounds declared and streamed response sizes and redacts known credentials from JSON",async()=>{
 const url=await endpoint((res,p)=>{if(p==="/large"){res.writeHead(200,{"content-type":"application/json","content-length":"3000000"});res.end();}else if(p==="/stream"){res.writeHead(200,{"content-type":"application/json"});res.end("x".repeat(2_000_001));}else{res.writeHead(200,{"content-type":"application/json","x-request-id":"secret-key"});res.end(JSON.stringify({echo:"secret-key"}));}});
 for(const path of ["/large","/stream"])await expect(providerFetch(url+path,{})).rejects.toThrow("byte limit");
 const response=await providerFetch(url+"/redacted",{},["secret-key"]);expect(await response.json()).toEqual({echo:"[REDACTED]"});expect(response.headers.get("x-request-id")).toBeNull();
});
it("retries only explicit quota rejections, bounds retries and respects cancellation",async()=>{
 let count=0;const url=await endpoint((res)=>{count++;res.writeHead(429,{"retry-after":"0"});res.end("rate-limited");});
 expect((await providerFetch(url,{})).status).toBe(429);expect(count).toBe(2);
 const controller=new AbortController();controller.abort();await expect(providerFetch(url,{signal:controller.signal})).rejects.toThrow("cancelled");
});
it("requires secure explicit endpoints and rejects URL credentials",()=>{
 for(const url of ["http://example.com/v1","https://user:secret@example.com/v1","https://example.com/v1?api_key=secret","file:///tmp/model"])expect(()=>validateProviderUrl(url)).toThrow();
 expect(validateProviderUrl("http://127.0.0.1:1234/v1").hostname).toBe("127.0.0.1");
});
