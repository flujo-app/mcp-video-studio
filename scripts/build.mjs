import { build, context } from "esbuild";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "studio"), { recursive: true });

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  tsconfig: path.join(root, "tsconfig.json")
};

const serverOptions = {
  ...shared,
  entryPoints: [path.join(root, "packages/server/src/index.ts")],
  outfile: path.join(dist, "index.js"),
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@modelcontextprotocol/sdk/*",
    "@modelcontextprotocol/ext-apps/*",
    "patchright",
    "zod"
  ]
};

const studioOptions = {
  ...shared,
  entryPoints: [path.join(root, "packages/studio/src/main.tsx")],
  outfile: path.join(dist, "studio/app.js"),
  platform: "browser",
  format: "esm",
  target: ["chrome120", "firefox120", "safari17"],
  minify: true,
  loader: { ".svg": "dataurl" }
};

if (watch) {
  const server = await context(serverOptions);
  const studio = await context(studioOptions);
  await Promise.all([server.watch(), studio.watch()]);
  process.stderr.write("mcp-video-studio: watching server and studio\n");
} else {
  await Promise.all([build(serverOptions), build(studioOptions)]);
  await chmod(path.join(dist, "index.js"), 0o755);
  await writeFile(path.join(dist, "studio/index.html"), [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    "<title>MCP Video Studio</title><link rel=\"stylesheet\" href=\"/app.css\"></head>",
    "<body><div id=\"root\"></div><script type=\"module\" src=\"/app.js\"></script></body></html>"
  ].join(""), "utf8");
}
