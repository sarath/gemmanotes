import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinModules } from "node:module";

const rootDir = process.cwd();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gemmanotes-tests-"));
const outFile = path.join(tmpDir, "test-bundle.cjs");

try {
  await esbuild.build({
    entryPoints: ["tests/external-model-folder.test.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2022",
    outfile: outFile,
    sourcemap: "inline",
    alias: {
      obsidian: path.resolve(rootDir, "tests/mocks/obsidian.ts"),
      "onnxruntime-node": "onnxruntime-web/webgpu",
      "@huggingface/transformers": path.resolve(
        rootDir,
        "node_modules/@huggingface/transformers/dist/transformers.web.js",
      ),
    },
    external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    logLevel: "warning",
  });

  const result = spawnSync(process.execPath, ["--test", outFile], {
    stdio: "inherit",
    cwd: rootDir,
  });

  process.exit(result.status ?? 1);
} finally {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}
