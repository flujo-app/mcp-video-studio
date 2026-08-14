import { describe, expect, it } from "vitest";
import { createStudioAppHtml } from "../packages/server/src/app-view.js";

describe("MCP App gateway view", () => {
  it("marks the editor as hosted, grants PiP, and relays only parent/child messages", () => {
    const html = createStudioAppHtml("http://127.0.0.1:8788/?token=a%20token");

    expect(html).toContain("mcpApp=1");
    expect(html).toContain("autoplay; fullscreen; picture-in-picture");
    expect(html).toContain("event.source===frame.contentWindow");
    expect(html).toContain("event.source===host");
    expect(html).toContain("host.postMessage(event.data");
    expect(html).toContain("frame.contentWindow?.postMessage(event.data");
  });
});
