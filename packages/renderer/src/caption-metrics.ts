/** Extract only standalone numeric expression logs, including newer FFmpeg Eval contexts. */
export function drawtextMetricValues(stderr:string,count:number):Map<number,number>{
 const numbers=stderr.split(/\r?\n/).flatMap(line=>{
  const plain=line.replace(/\u001b\[[0-9;]*m/g,""),match=/^\s*(?:\[[^\]\r\n]{1,200}\]\s*)*(\d+(?:\.\d+)?)\s*$/.exec(plain);
  return match?[Number(match[1])]:[];
 }),values=new Map<number,number>();
 for(let i=0;i<numbers.length-1;i++){const marker=numbers[i]!,value=numbers[i+1]!;if(Number.isInteger(marker)&&marker>=900000000&&marker<900000000+count*2&&value>=0&&value<900000000)values.set(marker,value);}
 return values;
}
