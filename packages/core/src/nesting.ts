import type {StudioProject} from "@mcp-video-studio/contracts";
import {StudioException} from "./errors.js";
export function sequenceDependencies(project:StudioProject,sequenceId:string,includeDisabled=false){
 const sequences=new Set<string>(),media=new Set<string>(),animations=new Set<string>(),byId=new Map(project.sequences.map(sequence=>[sequence.id,sequence]));
 const depths=new Map<string,number>();let edges=0;
 const visit=(id:string,ancestors:string[]):number=>{
  if(ancestors.includes(id))throw new StudioException("NESTED_SEQUENCE_CYCLE","Nested sequences cannot reference themselves through another sequence.","input");
  if(ancestors.length>=8)throw new StudioException("NESTED_SEQUENCE_DEPTH","Nested sequences are limited to eight levels.","input");
  const knownDepth=depths.get(id);if(knownDepth!==undefined){if(ancestors.length+knownDepth>8)throw new StudioException("NESTED_SEQUENCE_DEPTH","Nested sequences are limited to eight levels.","input");return knownDepth;}
  let depth=1;
  const sequence=byId.get(id);if(!sequence)throw new StudioException("MISSING_SEQUENCE","A nested source sequence does not exist.","input");
  sequences.add(id);
  for(const clip of sequence.clips){
   if(++edges>100000)throw new StudioException("NESTED_SEQUENCE_LIMIT","Sequence dependency inspection exceeds 100,000 clips.","policy");
   if(!includeDisabled&&!clip.enabled)continue;
   if(clip.source.type==="media")media.add(clip.source.mediaId);
   if(clip.source.type==="animation")animations.add(clip.source.animationId);
   if(clip.source.type==="sequence")depth=Math.max(depth,1+visit(clip.source.sequenceId,[...ancestors,id]));
  }
  depths.set(id,depth);return depth;
 };
 visit(sequenceId,[]);return{sequences,media,animations};
}
