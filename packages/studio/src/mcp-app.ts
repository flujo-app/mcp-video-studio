import { App } from "@modelcontextprotocol/ext-apps";

export type McpUiDisplayMode = "inline" | "fullscreen" | "pip";

export const STUDIO_DISPLAY_MODES: McpUiDisplayMode[] = ["inline", "fullscreen", "pip"];

export interface StudioDisplayState {
  embedded: boolean;
  connected: boolean;
  mode: McpUiDisplayMode;
  availableDisplayModes: readonly McpUiDisplayMode[];
  error: string | undefined;
}

type DisplayStateListener = () => void;

const embedded = window.parent !== window && new URLSearchParams(window.location.search).get("mcpApp") === "1";
const mcpApp = embedded
  ? new App(
      { name: "MCP Video Studio", version: "0.1.0" },
      { availableDisplayModes: STUDIO_DISPLAY_MODES },
      { autoResize: true },
    )
  : undefined;
const listeners = new Set<DisplayStateListener>();
let displayState: StudioDisplayState = {
  embedded,
  connected: false,
  mode: "inline",
  availableDisplayModes: embedded ? STUDIO_DISPLAY_MODES : ["inline"],
  error: undefined,
};

function publish(next: Partial<StudioDisplayState>): void {
  displayState = { ...displayState, ...next };
  for (const listener of listeners) listener();
}

function syncHostContext(): void {
  const context = mcpApp?.getHostContext();
  publish({
    connected: true,
    mode: context?.displayMode ?? displayState.mode,
    availableDisplayModes: context?.availableDisplayModes ?? displayState.availableDisplayModes,
    error: undefined,
  });
}

if (mcpApp) mcpApp.onhostcontextchanged = syncHostContext;

const connection = mcpApp
  ? mcpApp.connect()
      .then(syncHostContext)
      .catch((error: unknown) => {
        publish({
          connected: false,
          error: error instanceof Error ? error.message : String(error),
        });
      })
  : Promise.resolve();

export function subscribeToStudioDisplayState(listener: DisplayStateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStudioDisplayState(): StudioDisplayState {
  return displayState;
}

export async function requestStudioDisplayMode(mode: McpUiDisplayMode): Promise<McpUiDisplayMode> {
  if (!mcpApp) throw new Error("Display modes are only available inside an MCP App host.");
  await connection;
  if (!displayState.connected) throw new Error(displayState.error ?? "The MCP App host is not connected.");
  if (!displayState.availableDisplayModes.includes(mode)) throw new Error(`${mode} mode is not available in this host.`);
  const result = await mcpApp.requestDisplayMode({ mode });
  publish({ mode: result.mode, error: undefined });
  return result.mode;
}
