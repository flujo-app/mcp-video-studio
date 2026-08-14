import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { framesToTicks, type AnimationDocument } from "@mcp-video-studio/contracts";
import { renderAnimation } from "@mcp-video-studio/animation";
import { loadConfig, probeMedia } from "@mcp-video-studio/media";

const integration = process.env.RUN_BROWSER_INTEGRATION === "1" ? it : it.skip;

describe("headless HTML animation integration", () => {
  integration("captures an offline deterministic frame hook into FFV1", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-video-studio-animation-"));
    try {
      const fps = { numerator: 10, denominator: 1 };
      const document: AnimationDocument = {
        id: "html", name: "HTML test", durationTick: framesToTicks(3, fps), canvas: { width: 160, height: 90, background: "transparent" }, seed: 42, mode: "html", nodes: [], operations: [],
        html: `<!doctype html><style>html,body,#frame{margin:0;width:100%;height:100%}</style><div id="frame"></div><script>window.renderFrame=({frame})=>{document.getElementById('frame').style.background=frame%2?'#00ff00':'#ff0066'}</script>`
      };
      const outputPath = path.join(root, "animation.mkv");
      const config = loadConfig({ ...process.env, VIDEO_STUDIO_DATA_DIR: root, VIDEO_STUDIO_SCRATCH_DIR: path.join(root, "scratch") });
      const result = await renderAnimation(document, config, { outputPath, fps });
      expect(result.frameCount).toBe(3);
      const probe = await probeMedia(outputPath, config);
      expect(probe.videoCodec).toBe("ffv1");
      expect(probe.width).toBe(160);
      expect(probe.height).toBe(90);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
