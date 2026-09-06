import {expect,it} from "vitest";
import {createDefaultProject,defaultTrack,defaultClip,secondsToTicks,ticksPerSample} from "@mcp-video-studio/contracts";
import {applyProjectCommands} from "@mcp-video-studio/core";
import {envelopeValue} from "../packages/core/src/envelope.js";
it("ducking uses enabled voice regions, joins overlapping ramps, preserves unrelated automation and restores music",()=>{
 const p=createDefaultProject("VO mix"),s=p.sequences[0]!,voice=s.tracks.find(t=>t.type==="audio")!,music=defaultTrack(s.id,"audio",4,"Music");s.tracks.push(music);
 for(const [start,duration] of [[1,1],[2.1,.5],[4,.5]] as const){const clip=defaultClip(voice.id,{type:"color",color:"#fff"},"VO",secondsToTicks(duration));clip.startTick=secondsToTicks(start);s.clips.push(clip);}
 s.automation.push({id:"existing",sequenceId:s.id,target:"track:"+music.id+":gainDbOffset",enabled:true,points:[{tick:0,value:-3,curve:"hold"}]});
 const result=applyProjectCommands(p,[{type:"audio.duck",sequenceId:s.id,musicTrackId:music.id,voiceTrackIds:[voice.id],attenuationDb:-12,attackTick:secondsToTicks(.1),releaseTick:secondsToTicks(.3)}]).project.sequences[0]!;
 expect(result.automation[0]).toEqual(s.automation[0]);const lane=result.automation[1]!,q=ticksPerSample(p.settings.sampleRate);
 expect(lane.points.every(point=>point.tick%q===0)).toBe(true);
 for(const [seconds,value] of [[.5,0],[.95,-6],[1,-12],[2.05,-12],[2.75,-6],[3,0],[4,-12],[5,0]] as const)expect(envelopeValue(lane.points,secondsToTicks(seconds))).toBeCloseTo(value,8);
 expect(()=>applyProjectCommands(p,[{type:"audio.duck",sequenceId:s.id,musicTrackId:music.id,voiceTrackIds:[music.id],attenuationDb:-12,attackTick:0,releaseTick:0}])).toThrow(/distinct/);
});
