import {mkdtemp,writeFile,rm,readFile} from "node:fs/promises";import {spawn} from "node:child_process";import path from "node:path";import os from "node:os";import assert from "node:assert/strict";
import {Client} from "@modelcontextprotocol/client";import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";
const npm=process.platform==="win32"?"npm.cmd":"npm",root=path.resolve(import.meta.dirname,"..");
function command(executable,args,env=process.env){return new Promise((resolve,reject)=>{const child=spawn(executable,args,{cwd:root,env,stdio:["ignore","pipe","pipe"],shell:process.platform==="win32"&&executable.endsWith(".cmd")});let out="",err="";child.stdout.on("data",chunk=>out+=chunk);child.stderr.on("data",chunk=>err+=chunk);child.once("error",reject);child.once("close",code=>code===0?resolve(out):reject(new Error(executable+" failed: "+err+out)));});}
const temp=await mkdtemp(path.join(os.tmpdir(),"studio-package-"));
try{
 const packed=JSON.parse(await command(npm,["pack","--ignore-scripts","--json","--pack-destination",temp]))[0];
 const install=path.join(temp,"installed");await command(process.execPath,["-e","require('fs').mkdirSync(process.argv[1],{recursive:true})",install]);
 await writeFile(path.join(install,"package.json"),JSON.stringify({name:"studio-package-acceptance",private:true,type:"module"}));
 await command(npm,["install","--prefix",install,"--ignore-scripts","--omit=dev",path.join(temp,packed.filename)]);
 const entry=path.join(install,"node_modules","mcp-video-studio","dist","index.js"),manifest=JSON.parse(await readFile(path.join(install,"node_modules","mcp-video-studio","package.json"),"utf8"));
 let projectPath;
 const env={...process.env,VIDEO_STUDIO_DATA_DIR:path.join(temp,"data"),VIDEO_STUDIO_GATEWAY_PORT:"0"};
 for(const mode of ["auto","legacy"]){
  const client=new Client({name:"packed-acceptance",version:"1"},{versionNegotiation:{mode}}),transport=new StdioClientTransport({command:process.execPath,args:[entry,"--stdio"],env,stderr:"pipe"});
  let logs="";transport.stderr?.on("data",chunk=>logs+=chunk);
  try{
   await client.connect(transport);assert.equal(client.getProtocolEra(),mode==="auto"?"modern":"legacy");
   assert.equal(client.getServerVersion()?.version,manifest.version);
   const catalog=await client.listTools();for(const name of ["slip_clip","edit_animation","import_captions","export_project_archive","set_clip_mask","retime_clip"])assert(catalog.tools.some(tool=>tool.name===name));
   if(!projectPath){const result=await client.callTool({name:"create_project",arguments:{name:"Packed persistence"}});assert(!result.isError);projectPath=result.structuredContent.projectPath;}
   const result=await client.callTool({name:"get_project",arguments:{projectPath}});assert.equal(result.structuredContent.project.name,"Packed persistence");
   const resource=await client.readResource({uri:"ui://mcp-video-studio/studio-v1.html"});assert.equal(resource.contents[0].mimeType,"text/html;profile=mcp-app");
   assert(!logs.includes("?token="));
   console.log(JSON.stringify({installedVersion:manifest.version,mode,era:client.getProtocolEra(),protocol:client.getNegotiatedProtocolVersion(),tools:catalog.tools.length,persistence:true}));
  }finally{await client.close();}
 }
 // EOF must close the gateway/process without relying on transport force-kill.
 await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[entry,"--stdio"],{env,stdio:["pipe","ignore","pipe"]}),timer=setTimeout(()=>{child.kill();reject(new Error("Packed stdio process did not exit on EOF"));},10000);child.once("error",reject);child.once("exit",code=>{clearTimeout(timer);code===0?resolve():reject(new Error("EOF exit "+code));});child.stdin.end();});
 if(process.env.RUN_BROWSER_INTEGRATION==="1")await command(npm,["exec","--","vitest","run","tests/studio-browser.integration.test.ts","tests/export-browser.integration.test.ts","tests/video-mask-browser.integration.test.ts","tests/retiming-browser.integration.test.ts"],{...process.env,STUDIO_TEST_ENTRY:entry});
 console.log(JSON.stringify({package:packed.filename,integrity:packed.integrity,installedArtifact:true,stdioEof:true,browser:process.env.RUN_BROWSER_INTEGRATION==="1"}));
}finally{await rm(temp,{recursive:true,force:true});}
