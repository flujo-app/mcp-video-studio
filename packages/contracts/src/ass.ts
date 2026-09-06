import {framesToTicks,secondsToTicks,ticksToFrames,ticksToSeconds,type Rational} from "./time.js";
import type {CaptionCue,CaptionStyle,Raster} from "./types.js";
type Row=Record<string,string>;
function invalid(message:string):never{throw new Error("ASS: "+message);}
function values(text:string,fields:string[],lastText=false):Row{if(new Set(fields).size!==fields.length||fields.length>40||fields.some(field=>!field))invalid("Format fields must be unique and bounded.");const items=text.split(",");if(lastText){if(fields.at(-1)!=="text")invalid("Events Format must put Text last.");items.splice(fields.length-1,items.length,items.slice(fields.length-1).join(","));}if(items.length!==fields.length)invalid("Record does not match its Format fields.");return Object.fromEntries(fields.map((field,index)=>[field,items[index]!.trim()]));}
function numeric(value:string|undefined,fallback:number,min:number,max:number):number{if(value===undefined||value==="")return fallback;const result=Number(value);if(!Number.isFinite(result)||result<min||result>max)invalid("Style numbers exceed supported bounds.");return result;}
function rgba(value:string|undefined,fallback:string):string{if(!value)return fallback;const match=/^&H([0-9a-f]{1,8})&?$/i.exec(value);if(!match)invalid("Use hexadecimal &HAABBGGRR colors.");const n=Number.parseInt(match[1]!,16);return "#"+[n&255,(n>>>8)&255,(n>>>16)&255,255-(n>>>24)].map(v=>v.toString(16).padStart(2,"0")).join("");}
function assColor(value:string):string{const match=/^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);if(!match)invalid("Sidecar colors must be hexadecimal.");return "&H"+(255-Number.parseInt(match[2]??"ff",16)).toString(16).padStart(2,"0")+match[1]!.slice(4,6)+match[1]!.slice(2,4)+match[1]!.slice(0,2);}
function time(value:string|undefined):number{const m=/^(\d{1,3}):([0-5]\d):([0-5]\d)\.(\d{2})$/.exec(value??"");if(!m)invalid("Use H:MM:SS.cc timestamps.");return Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/100;}
function style(row:Row|undefined,fallback:CaptionStyle,raster:Raster,source:Raster):CaptionStyle{
 if(!row)return structuredClone(fallback);
 for(const field of ["bold","italic","underline","strikeout","spacing","angle"])if(numeric(row[field],0,-10000,10000)!==0)invalid("This caption editor does not support "+field+" styling; flatten it in the source or use an animation title.");
 for(const field of ["scalex","scaley"])if(numeric(row[field],100,1,1000)!==100)invalid("Non-default text scaling requires an animation title.");
 const alignment=numeric(row.alignment,2,1,9);if(!Number.isInteger(alignment))invalid("Alignment must be an integer.");
 const border=numeric(row.borderstyle,1,1,3);if(border!==1&&border!==3)invalid("BorderStyle must be 1 or 3.");
 const sy=raster.height/source.height,sx=raster.width/source.width;
 return{fontFamily:row.fontname||fallback.fontFamily,fontSize:numeric(row.fontsize,fallback.fontSize,1,500)*sy,color:rgba(row.primarycolour,fallback.color),background:border===3?rgba(row.outlinecolour,"#000000ff"):"#00000000",outlineColor:rgba(row.outlinecolour,"#000000ff"),outlineWidth:border===1?numeric(row.outline,0,0,32)*sy:0,shadowColor:rgba(row.backcolour,"#000000ff"),shadowOffset:border===1?numeric(row.shadow,0,0,32)*sy:0,marginLeft:numeric(row.marginl,0,0,8192)*sx,marginRight:numeric(row.marginr,0,0,8192)*sx,marginVertical:numeric(row.marginv,0,0,8192)*sy,position:alignment>=7?"top":alignment>=4?"center":"bottom",align:(alignment-1)%3===0?"left":(alignment-1)%3===1?"center":"right"};
}
export function parseAss(text:string,trackId:string,fps:Rational,fallback:CaptionStyle,raster:Raster={width:1920,height:1080}):CaptionCue[]{
 let section="",styleFields:string[]=[],eventFields:string[]=[];const styles=new Map<string,Row>(),events:Row[]=[],source={...raster};let recognized=false;
 for(const raw of text.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").split("\n")){
  const line=raw.trim();if(!line||line.startsWith(";"))continue;
  if(/^\[.*\]$/.test(line)){section=line.toLowerCase();if(section==="[fonts]"||section==="[graphics]")invalid("Embedded attachments must be imported separately.");continue;}
  const separator=line.indexOf(":");if(separator<0)continue;const key=line.slice(0,separator).trim().toLowerCase(),value=line.slice(separator+1).trimStart();
  if(section==="[script info]"){if(key==="scripttype"){if(value.trim().toLowerCase()!=="v4.00+")invalid("Only Advanced SubStation Alpha v4.00+ is supported.");recognized=true;}if(key==="playresx")source.width=numeric(value,raster.width,1,8192);if(key==="playresy")source.height=numeric(value,raster.height,1,8192);}
  if(section==="[v4+ styles]"){if(key==="format")styleFields=value.split(",").map(x=>x.trim().toLowerCase());if(key==="style"){if(!styleFields.length)invalid("Styles require a Format record.");const row=values(value,styleFields);if(!row.name||styles.has(row.name))invalid("Style names must be unique.");styles.set(row.name,row);}}
  if(section==="[events]"){if(key==="format")eventFields=value.split(",").map(x=>x.trim().toLowerCase());if(key==="dialogue"){if(!eventFields.length)invalid("Events require a Format record.");events.push(values(value,eventFields,true));if(events.length>1000)invalid("Import at most 1000 captions per transaction.");}}
 }
 if(!recognized)invalid("Missing ScriptType: v4.00+ header.");
 return events.map(row=>{
  if(row.effect?.trim())invalid("Scrolling or banner effects require an animation title.");
  if(row.text?.includes("{")||row.text?.includes("}"))invalid("Inline override tags require flattening before caption import; use animation titles for animated typography.");
  if(row.style&&!styles.has(row.style))invalid("Dialogue references a missing style.");
  const start=time(row.start),end=time(row.end);if(end<=start||end>7*86400)invalid("Caption end must follow its start within seven days.");
  const startTick=framesToTicks(ticksToFrames(secondsToTicks(start),fps,"round"),fps),endTick=framesToTicks(ticksToFrames(secondsToTicks(end),fps,"round"),fps),content=(row.text??"").replace(/\\N/g,"\n").replace(/\\n/g," ").replace(/\\h/g,"\u00a0").trim();
  if(!content||content.length>10000||endTick<=startTick)invalid("Caption text/timing is empty or exceeds limits.");
  const selected=style(styles.get(row.style??""),fallback,raster,source);
  for(const [field,property,scale] of [["marginl","marginLeft",raster.width/source.width],["marginr","marginRight",raster.width/source.width],["marginv","marginVertical",raster.height/source.height]] as const){const n=numeric(row[field],0,0,8192);if(n)selected[property]=n*scale;}
  return{id:crypto.randomUUID(),trackId,startTick,durationTick:endTick-startTick,text:content,style:selected};
 });
}
function formatTime(tick:number){const total=Math.round(ticksToSeconds(tick)*100);return Math.floor(total/360000)+":"+String(Math.floor(total/6000)%60).padStart(2,"0")+":"+String(Math.floor(total/100)%60).padStart(2,"0")+"."+String(total%100).padStart(2,"0");}
export function serializeAss(captions:CaptionCue[],raster:Raster={width:1920,height:1080}):string{
 const sorted=[...captions].sort((a,b)=>a.startTick-b.startTick);
 const lines=["[Script Info]","ScriptType: v4.00+","PlayResX: "+raster.width,"PlayResY: "+raster.height,"WrapStyle: 2","","[V4+ Styles]","Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding"];
 sorted.forEach((cue,i)=>{const s=cue.style;if(/[,\r\n]/.test(s.fontFamily))invalid("Font family cannot contain commas or line breaks.");const alignment=(s.position==="top"?7:s.position==="center"?4:1)+(s.align==="left"?0:s.align==="center"?1:2),boxed=!/^#[0-9a-f]{6}00$/i.test(s.background);if(boxed&&((s.outlineWidth??0)>0||(s.shadowOffset??0)>0))invalid("ASS cannot preserve a box together with this outline/shadow style.");lines.push("Style: "+["Cue"+i,s.fontFamily,s.fontSize,assColor(s.color),assColor(s.color),assColor(boxed?s.background:s.outlineColor??"#000000ff"),assColor(s.shadowColor??"#000000ff"),0,0,0,0,100,100,0,0,boxed?3:1,boxed?18:s.outlineWidth??0,s.shadowOffset??0,alignment,s.marginLeft??raster.width*.05,s.marginRight??raster.width*.05,s.marginVertical??raster.height*(s.position==="top"?.07:.08),1].join(","));});
 lines.push("","[Events]","Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");
 sorted.forEach((cue,i)=>{if(formatTime(cue.startTick)===formatTime(cue.startTick+cue.durationTick)||ticksToSeconds(cue.startTick+cue.durationTick)>7*86400)invalid("Caption timing cannot be represented by ASS centiseconds within seven days.");if(/[{}\\]/.test(cue.text))invalid("Literal braces/backslashes cannot be exported without changing ASS interpretation; use SRT or WebVTT for this text.");lines.push("Dialogue: 0,"+formatTime(cue.startTick)+","+formatTime(cue.startTick+cue.durationTick)+",Cue"+i+",,0,0,0,,"+cue.text.replace(/\r\n?/g,"\n").replace(/\n/g,"\\N").replace(/\u00a0/g,"\\h"));});return lines.join("\n")+"\n";
}
