import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { readFile } from "fs/promises";

const production = process.argv[2] === "production";

const banner = `/* GemmaNotes — generated bundle. Do not edit directly. */`;

/**
 * transformers.js decides Node-vs-browser from `process.release.name`, which
 * Obsidian's Electron renderer reports as "node". That routes ONNX to the
 * onnxruntime-node backend, which cannot load in a bundled plugin. Force the
 * detection to false at build time so the onnxruntime-web path and browser
 * cache/fetch are used everywhere.
 */
const forceBrowserEnv = {
  name: "force-browser-env",
  setup(build) {
    build.onLoad(
      { filter: /transformers[\\/]src[\\/]env\.js$/ },
      async (args) => {
        const src = await readFile(args.path, "utf8");
        const patched = src.replace(
          /const IS_NODE_ENV = [^;]+;/,
          "const IS_NODE_ENV = false;",
        );
        if (patched === src) {
          throw new Error(
            "force-browser-env: IS_NODE_ENV declaration not found in env.js",
          );
        }
        return { contents: patched, loader: "js" };
      },
    );
  },
};

const ctx = await esbuild.context({
  banner: { js: banner },
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
  // transformers.js statically imports onnxruntime-node, whose native binding
  // cannot run inside a bundled plugin. Replace it with an empty stub; the web
  // runtime is forced at load time in src/transcriber.ts.
  alias: {
    "onnxruntime-node": "./onnxruntime-node-stub.js",
  },
  plugins: [forceBrowserEnv],
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
