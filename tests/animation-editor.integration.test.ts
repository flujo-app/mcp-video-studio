import {mkdtemp,rm} from "node:fs/promises";import path from "node:path";import os from "node:os";import {expect,it} from "vitest";import {chromium} from "patchright";import axe from "axe-core";
import {Client} from "@modelcontextprotocol/client";import {StdioClientTransport} from "@modelcontextprotocol/client/stdio";import type {StudioProject} from "@mcp-video-studio/contracts";
const integration=process.env.RUN_BROWSER_INTEGRATION==="1"?it:it.skip;
integration("human edits animation hierarchy, canvas objects and operation keyframes with durable undo and accessible controls",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"studio-animation-editor-")),client=new Client({name:"animation-editor-test",version:"1"},{versionNegotiation:{mode:"auto"}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.resolve("dist/index.js"),"--stdio"],env:{...Object.fromEntries(Object.entries(process.env).filter((p):p is[string,string]=>typeof p[1]==="string")),VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"},stderr:"pipe"});
 const browser=await chromium.launch({headless:true});try{
  await client.connect(transport);const response=await client.callTool({name:"open_studio",arguments:{}}),url=(response.structuredContent as{studioUrl:string}).studioUrl;
  const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(10000);await page.goto(url);await page.getByLabel("Name",{exact:true}).fill("Animation edit");await page.getByRole("button",{name:"Create project",exact:true}).click();
  await page.getByRole("button",{name:"Editing workflows",exact:true}).click();await page.getByLabel("Template title").fill("Animation title");await page.getByRole("button",{name:"Add template at playhead",exact:true}).click();await page.waitForFunction(()=>document.body.textContent?.includes("rev 1"));await page.getByRole("button",{name:"Close editing workflows"}).click();
  await page.locator(".timeline-clip").first().press("Enter");await page.getByRole("tree",{name:"Animation hierarchy"}).waitFor();
  let revision=1;const saved=async()=>{revision++;await page.getByText("Saved revision "+revision,{exact:true}).waitFor();};
  const change=async(label:string,value:string)=>{await page.getByLabel(label,{exact:true}).fill(value);await page.getByLabel(label,{exact:true}).press("Tab");await saved();};
  await page.getByLabel("New object type").selectOption("group");await page.getByRole("button",{name:"Add animation object",exact:true}).click();await saved();await change("Object name","Diagram group");
  await page.getByLabel("New object type").selectOption("rect");await page.getByRole("button",{name:"Add animation object",exact:true}).click();await saved();await change("Object name","Editable box");await change("Object X","80");await change("Object Y","40");await change("Object width","20");await change("Object height","20");
  await page.getByLabel("Parent group").selectOption({label:"Diagram group"});await saved();
  await page.getByLabel("Target X",{exact:true}).fill("120");await page.getByLabel("Target X",{exact:true}).press("Tab");await page.getByRole("button",{name:"Add operation",exact:true}).click();await saved();
  await page.getByLabel("Operation",{exact:true}).selectOption({label:"transform at frame 0"});
  await page.getByLabel("Keyframe duration frames").fill("15");await page.getByLabel("Keyframe duration frames").press("Tab");await page.getByRole("button",{name:"Save operation",exact:true}).click();await saved();
  const canvas=page.getByLabel("Animation canvas; click an object or use arrow keys to move the selected object");
  await canvas.press("ArrowRight");await saved();
  await page.getByRole("button",{name:"Undo",exact:true}).click();await page.getByText("Undone",{exact:true}).waitFor();revision++;
  await page.getByRole("button",{name:"Redo",exact:true}).click();await page.getByText("Redone",{exact:true}).waitFor();revision++;
  const state=await page.evaluate(async()=>{const headers={authorization:"Bearer "+sessionStorage.getItem("mcp-video-studio:access")},list=await fetch("/api/projects",{headers}).then(r=>r.json()) as {projects:Array<{path:string}>},projectPath=list.projects[0]!.path;return await fetch("/api/project?projectPath="+encodeURIComponent(projectPath),{headers}).then(r=>r.json()) as{project:StudioProject};});
  const animation=state.project.animations[0]!,box=animation.nodes.find(node=>node.name==="Editable box")!,group=animation.nodes.find(node=>node.name==="Diagram group")!;
  expect(box.parentId).toBe(group.id);expect(box.transform.position).toEqual([81,40]);expect(animation.operations.find(operation=>operation.targetId===box.id)).toMatchObject({type:"transform",durationTick:17640000,parameters:{to:{position:[120,40]}}});expect(state.project.sequences[0]!.clips[0]!.startTick).toBe(0);
  await page.reload();await page.getByText("Project loaded",{exact:true}).waitFor();await page.locator(".timeline-clip").first().press("Enter");await page.getByRole("treeitem",{name:"Editable box (rect)",exact:true}).click();expect(await page.getByLabel("Object X",{exact:true}).inputValue()).toBe("81");
  await page.getByRole("treeitem",{name:"Diagram group (group)",exact:true}).click();await page.getByRole("treeitem",{name:"Diagram group (group)",exact:true}).press("ArrowRight");expect(await page.getByLabel("Object name",{exact:true}).inputValue()).toBe("Editable box");
  await page.getByRole("treeitem",{name:"Diagram group (group)",exact:true}).click();const bounds=await canvas.boundingBox();expect(bounds).not.toBeNull();await canvas.click({position:{x:81/1920*bounds!.width,y:40/1080*bounds!.height}});expect(await page.getByLabel("Object name",{exact:true}).inputValue()).toBe("Editable box");
  await page.evaluate(axe.source,undefined,false);const accessibility=await page.evaluate(async()=>await(window as unknown as{axe:typeof axe}).axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}}),undefined,false);expect(accessibility.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)}))).toEqual([]);
 }finally{await browser.close();await client.close();await rm(root,{recursive:true,force:true});}
},60000);
