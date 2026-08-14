import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appConstructor: vi.fn(),
  connect: vi.fn(async () => {}),
  requestDisplayMode: vi.fn(async ({ mode }: { mode: "inline" | "fullscreen" | "pip" }) => ({ mode })),
  getHostContext: vi.fn(() => ({
    displayMode: "inline" as const,
    availableDisplayModes: ["inline", "fullscreen", "pip"] as const,
  })),
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    onhostcontextchanged?: () => void;

    constructor(appInfo: unknown, capabilities: unknown, options: unknown) {
      mocks.appConstructor(appInfo, capabilities, options);
    }

    connect = mocks.connect;
    requestDisplayMode = mocks.requestDisplayMode;
    getHostContext = mocks.getHostContext;
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP App display modes", () => {
  it("advertises and requests inline, fullscreen, and picture-in-picture modes", async () => {
    vi.stubGlobal("window", { parent: {}, location: { search: "?mcpApp=1" } });

    const bridge = await import("../packages/studio/src/mcp-app.js");

    expect(bridge.STUDIO_DISPLAY_MODES).toEqual(["inline", "fullscreen", "pip"]);
    expect(mocks.appConstructor).toHaveBeenCalledWith(
      { name: "MCP Video Studio", version: "0.1.0" },
      { availableDisplayModes: ["inline", "fullscreen", "pip"] },
      { autoResize: true },
    );
    await expect(bridge.requestStudioDisplayMode("pip")).resolves.toBe("pip");
    expect(mocks.requestDisplayMode).toHaveBeenCalledWith({ mode: "pip" });
    expect(bridge.getStudioDisplayState()).toMatchObject({ connected: true, mode: "pip" });
  });
});
