import { defineConfig } from "vitest/config";
import path from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      "@mcp-video-studio/contracts": path.join(root, "packages/contracts/src/index.ts"),
      "@mcp-video-studio/core": path.join(root, "packages/core/src/index.ts"),
      "@mcp-video-studio/media": path.join(root, "packages/media/src/index.ts"),
      "@mcp-video-studio/renderer": path.join(root, "packages/renderer/src/index.ts"),
      "@mcp-video-studio/animation": path.join(root, "packages/animation/src/index.ts")
    }
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
