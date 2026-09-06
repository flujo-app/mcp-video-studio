import path from "node:path";
import {loadConfig,runChecked} from "@mcp-video-studio/media";
/** Prepared inputs only: editor acceptance performs every project mutation through its UI. */
export async function coreEditingFixture(root:string){
 const config=loadConfig({...process.env,VIDEO_STUDIO_DATA_DIR:root,VIDEO_STUDIO_GATEWAY_PORT:"0"});
 const video=path.join(root,"Provided video.mp4"),audio=path.join(root,"Provided music.wav"),image=path.join(root,"Provided still.png");
 await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","testsrc2=s=160x90:r=30","-t","36","-c:v","libx264","-preset","ultrafast",video]);
 await runChecked(config.ffmpegPath,["-hide_banner","-y","-f","lavfi","-i","sine=frequency=220:sample_rate=48000:duration=60","-c:a","pcm_s16le",audio]);
 await runChecked(config.ffmpegPath,["-hide_banner","-y","-i",video,"-frames:v","1",image]);
 return{video,audio,image};
}
