import type {AnimationDocument} from "./types.js";

const pathToken=/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
export function pathTokens(value:string):Array<string|number>{
 if(value.length>64000)throw new Error("SVG path exceeds 64,000 characters.");
 const matches=value.match(pathToken)??[];
 if(!matches.length||!/^[Mm]$/.test(matches[0]!)||value.replace(pathToken,"").replace(/[\s,]/g,""))throw new Error("Use SVG path commands and finite coordinates.");
 const tokens=matches.map(token=>/^[a-z]$/i.test(token)?token:Number(token));
 if(tokens.length>8192||tokens.some(token=>typeof token==="number"&&(!Number.isFinite(token)||Math.abs(token)>1000000)))throw new Error("SVG path exceeds coordinate limits.");
 let command="",count=0;
 const arity:Record<string,number>={M:2,L:2,H:1,V:1,C:6,S:4,Q:4,T:2,A:7,Z:0};
 const check=()=>{if(command&&(arity[command.toUpperCase()]===0?count!==0:count===0||count % arity[command.toUpperCase()]! !== 0))throw new Error("SVG path command has the wrong number of coordinates.");};
 for(const token of tokens){if(typeof token==="string"){check();command=token;count=0;}else{if(!command||command.toUpperCase()==="Z")throw new Error("SVG coordinates require a command.");count++;}}
 check();return tokens;
}
export function morphPath(from:string,to:string,progress:number):string{
 const a=pathTokens(from),b=pathTokens(to);
 if(a.length!==b.length||a.some((value,index)=>typeof value!==typeof b[index]||typeof value==="string"&&value!==b[index]))throw new Error("Morph paths must use the same commands and coordinate counts.");
 if(a.some(value=>value==="A"||value==="a"))throw new Error("Convert SVG arcs to cubic curves before morphing.");
 return a.map((value,index)=>typeof value==="number"?value+((b[index] as number)-value)*progress:value).join(" ");
}
export function animationProblems(document:AnimationDocument):string[]{
 if(document.mode!=="declarative")return[];
 const problems:string[]=[],nodes=new Map(document.nodes.map(node=>[node.id,node]));
 if(document.nodes.length>2000||document.operations.length>10000)problems.push("Animation supports at most 2,000 nodes and 10,000 operations.");
 if(document.nodes.filter(node=>node.type==="camera"&&node.properties.active!==false).length>1)problems.push("Use only one active camera.");
 for(const node of document.nodes){
  const properties=node.properties;
  if(node.parentId&&nodes.get(node.parentId)?.type!=="group")problems.push("Only group nodes can own children.");
  if(node.type==="path"){try{pathTokens(String(properties.path??properties.d??""));}catch(error){problems.push((error as Error).message);}}
  if(node.type==="image"||node.type==="video"){
   const src=properties.src;
   const pattern=node.type==="image"?/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/:/^data:video\/(?:mp4|webm);base64,[A-Za-z0-9+/]+={0,2}$/;
   if(typeof src!=="string"||src.length>12*1024*1024||!pattern.test(src))problems.push("Image/video nodes require a self-contained PNG, JPEG, WebP, MP4 or WebM base64 data URL of at most 12 MiB; remote and filesystem URLs are forbidden.");
  }
  for(const name of ["width","height","fontSize","strokeWidth","zoom","lifetime","size"]){const value=properties[name];if(value!==undefined&&(typeof value!=="number"||!Number.isFinite(value)||value<0||value>100000))problems.push("Animation property "+name+" must be a finite nonnegative number no greater than 100,000.");}
  if(node.type==="particles"&&properties.count!==undefined&&(!Number.isSafeInteger(properties.count)||Number(properties.count)<1||Number(properties.count)>5000))problems.push("Particle count must be an integer from 1 to 5,000.");
 }
 for(const operation of document.operations){
  if(operation.type==="morph"){const node=nodes.get(operation.targetId);try{if(node?.type!=="path")throw new Error("Morph operations target path nodes.");morphPath(String(operation.parameters.from??node.properties.path??node.properties.d??""),String(operation.parameters.to??""),.5);}catch(error){problems.push((error as Error).message);}}
  if(operation.type==="property"){
   const color=operation.parameters.property==="fill"||operation.parameters.property==="stroke";
   for(const field of ["from","to"]){const value=operation.parameters[field];if(field==="from"&&value===undefined)continue;if(color?typeof value!=="string"||!/^#[0-9a-f]{6}$/i.test(value):typeof value!=="number"||!Number.isFinite(value)||value<0||value>100000)problems.push("Property keyframes need bounded numeric geometry or six-digit hexadecimal colors.");}
  }
  if(operation.type==="property"&&(!["width","height","fontSize","strokeWidth","zoom","size","fill","stroke"].includes(String(operation.parameters.property))||!["number","string"].includes(typeof operation.parameters.to)))problems.push("Property keyframes support geometry, font size, camera zoom, particle size, fill and stroke.");
 }
 return problems;
}
