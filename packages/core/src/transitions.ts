import type {Clip,Sequence,StudioProject} from "@mcp-video-studio/contracts";
import {ticksPerFrame,ticksPerSample} from "@mcp-video-studio/contracts";
import {StudioException} from "./errors.js";
const styles:Record<string,"cut"|"crossfade"|"wipeleft"|"wiperight">={cut:"cut",crossfade:"crossfade",dissolve:"crossfade",fade:"crossfade",wipeleft:"wipeleft","wipe-left":"wipeleft",wiperight:"wiperight","wipe-right":"wiperight"};
export function transitionStyle(type:string):"cut"|"crossfade"|"wipeleft"|"wiperight"{
 const style=Object.hasOwn(styles,type)?styles[type]:undefined;if(!style)throw new StudioException("UNSUPPORTED_TRANSITION","Supported transitions are cut, crossfade/dissolve, wipeleft and wiperight.","input");return style;
}
function sourceHandles(project:StudioProject,clip:Clip):void{
 let available:number|undefined;
 if(clip.source.type==="media"){const media=project.media.find(item=>clip.source.type==="media"&&item.id===clip.source.mediaId);if(media?.kind!=="image")available=media?.probe.durationTick;}
 else if(clip.source.type==="animation")available=project.animations.find(item=>clip.source.type==="animation"&&item.id===clip.source.animationId)?.durationTick;
 if(clip.sourceInTick<0||(available!==undefined&&clip.sourceInTick+Math.round(clip.durationTick*clip.playbackRate.numerator/clip.playbackRate.denominator)>available+ticksPerSample(project.settings.sampleRate)))throw new StudioException("TRANSITION_HANDLES","Trim the clips to leave enough source handles for this transition.","input",{clipId:clip.id});
}
/** Center each transition on its cut while keeping the authored sequence duration. */
export function prepareTransitionTimeline(project:StudioProject,original:Sequence):Sequence{
 const sequence=structuredClone(original),incoming=new Set<string>(),outgoing=new Set<string>();
 for(const transition of original.transitions){
  const style=transitionStyle(transition.type);if(style==="cut")continue;
  const from=original.clips.find(clip=>clip.id===transition.fromClipId),to=original.clips.find(clip=>clip.id===transition.toClipId);
  if(!from||!to||from.trackId!==to.trackId||from.startTick+from.durationTick!==to.startTick||!from.enabled||!to.enabled)throw new StudioException("TRANSITION_CUT","A transition joins enabled adjacent clips on the same track.","input");
  if(from.blendMode!=="normal"||to.blendMode!=="normal")throw new StudioException("TRANSITION_BLEND","Use normal clip blend mode at a transition cut.","input");
  if(incoming.has(to.id)||outgoing.has(from.id))throw new StudioException("TRANSITION_DUPLICATE","Each clip edge can have one transition.","input");
  incoming.add(to.id);outgoing.add(from.id);
  const track=sequence.tracks.find(item=>item.id===from.trackId),unit=track?.type==="audio"?ticksPerSample(project.settings.sampleRate):ticksPerFrame(project.settings.fps);
  if(transition.durationTick%unit!==0||transition.durationTick>Math.min(from.durationTick,to.durationTick))throw new StudioException("TRANSITION_DURATION","Transition duration must align to its track grid and fit both clips.","input");
  const before=Math.floor(transition.durationTick/unit/2)*unit,after=transition.durationTick-before;
  const renderFrom=sequence.clips.find(clip=>clip.id===from.id)!,renderTo=sequence.clips.find(clip=>clip.id===to.id)!;
  renderFrom.durationTick+=after;renderTo.startTick-=before;renderTo.durationTick+=before;
  const still=to.source.type==="color"||(to.source.type==="media"&&project.media.find(media=>to.source.type==="media"&&media.id===to.source.mediaId)?.kind==="image");
  renderTo.sourceInTick-=Math.round(before*to.playbackRate.numerator/to.playbackRate.denominator);
  if(still)renderTo.sourceInTick=Math.max(0,renderTo.sourceInTick);
 }
 for(const clip of sequence.clips)sourceHandles(project,clip);
 return sequence;
}
