import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { execSync } from "child_process";

const production = process.argv[2] === "production";

let commitId = process.env.COMMIT_ID || "";
if (!commitId) {
  try {
    commitId = execSync("git rev-parse --short HEAD").toString().trim();
  } catch (e) {
    commitId = "unknown";
  }
}

const banner = `/* GemmaNotes — generated bundle. Do not edit directly. */`;

const ctx = await esbuild.context({
  banner: { js: banner },
  define: {
    __COMMIT_ID__: JSON.stringify(commitId),
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  // Obsidian runs in Electron renderer, where `process` exists — transformers.js
  // takes its Node branch and tries to load `onnxruntime-node`'s native binding
  // (which we don't ship). Redirect that import to ORT-Web so the same branch
  // gets a working browser runtime.
  alias: {
    "onnxruntime-node": "onnxruntime-web/webgpu",
    "node:fs": "fs",
    "node:path": "path",
    "node:url": "url",
    "node:stream": "stream",
    "node:os": "os",
  },
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
});

if (production) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
