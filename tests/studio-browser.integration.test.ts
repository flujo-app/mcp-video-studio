import { mkdtemp,rm } from "node:fs/promises";import path from "node:path";import os from "node:os";
import { expect,it } from "vitest";import { chromium } from "patchright";import axe from "axe-core";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { browserEnvironment } from "../packages/animation/src/sandbox.js";
const integration=process.env.RUN_BROWSER_INTEGRATION==="1"?it:it.skip;
integration("actual stdio editor supports bootstrap, reload, keyboard edits, captions, templates and accessible workflows",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-ui-")),client=new Client({name:"studio-acceptance",version:"1"},{versionNegotiation:{mode:"auto"}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve(process.env.STUDIO_TEST_ENTRY??"dist/index.js"),"--stdio"],env:{...Object.fromEntries(Object.entries(process.env).filter((p):p is [string,string]=>typeof p[1]==="string")),VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"},stderr:"pipe"});
 const browser=await chromium.launch({headless:true,env:browserEnvironment()});
 try{
  await client.connect(transport);
  const response=await client.callTool({name:"open_studio",arguments:{}}),data=response.structuredContent as {studioUrl:string};
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
  await page.goto(data.studioUrl);
  await page.getByLabel("Name",{exact:true}).fill("Browser edit");
  await page.getByRole("button",{name:"Create project",exact:true}).click();
  await page.getByRole("button",{name:"Color",exact:true}).waitFor({state:"visible"});await page.getByRole("button",{name:"Color",exact:true}).click();
  await page.getByText("Saved revision 1",{exact:true}).waitFor();
  expect(page.url()).not.toContain("token=");
  await page.reload();await page.getByRole("button",{name:"Editing workflows",exact:true}).click();
  await page.getByLabel("Caption source").fill("1\n00:00:00,000 --> 00:00:01,000\nBrowser caption");
  await page.getByRole("button",{name:"Import captions",exact:true}).click();
  await page.waitForFunction(()=>document.body.textContent?.includes("rev 2"));
  await page.getByRole("combobox",{name:/^Template/}).selectOption("lower-third");
  await page.getByLabel("Template title").fill("Browser title");
  await page.getByRole("button",{name:"Add template at playhead",exact:true}).click();
  await page.waitForFunction(()=>document.body.textContent?.includes("rev 3"));
  await page.getByRole("button",{name:"Close editing workflows"}).click();
  await page.getByRole("button",{name:"Undo",exact:true}).click();await page.getByText("Undone",{exact:true}).waitFor();
  await page.getByRole("button",{name:"Redo",exact:true}).click();await page.getByText("Redone",{exact:true}).waitFor();
  await page.evaluate(axe.source,undefined,false);
  const result=await page.evaluate(async()=>await (window as unknown as {axe:typeof axe}).axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}),undefined,false);
  expect(result.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))).toEqual([]);
  await page.getByRole("button",{name:"Lock editor",exact:true}).click();await page.getByLabel("Editor access token").waitFor();
  expect(await page.evaluate(()=>sessionStorage.getItem("mcp-video-studio:access"))).toBeNull();
 }finally{await browser.close();await client.close();await rm(root,{recursive:true,force:true});}
},60000);
