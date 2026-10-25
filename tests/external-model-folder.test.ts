import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

import {
  configureTransformersEnv,
  createFileResponse,
  createLocalAwareFetch,
  ExternalModelCache,
  isModelCached,
  resolveModelFolder,
} from "../src/model-storage";
import { DualBackend, GemmaBackend, WhisperBackend } from "../src/transcriber";
import { MODEL_REPOS } from "../src/types";
import GemmaNotesPlugin from "../src/main";
import { GemmaNotesSettingTab } from "../src/settings";
import { FileSystemAdapter } from "./mocks/obsidian";
import type { Setting } from "./mocks/obsidian";

describe("External model folder resolution (resolveModelFolder)", () => {
  it("falls back to <vault>/<pluginDir>/.cache when configuredFolder is empty", () => {
    const vaultPath = path.resolve("/tmp/my-vault");
    const pluginDir = ".obsidian/plugins/gemmanotes";
    const resolved = resolveModelFolder("", vaultPath, pluginDir);
    assert.equal(resolved, path.join(vaultPath, pluginDir, ".cache"));
  });

  it("falls back to <pluginDir>/.cache when vaultBasePath is null and configuredFolder is blank", () => {
    const pluginDir = ".obsidian/plugins/gemmanotes";
    const resolved = resolveModelFolder("   ", null, pluginDir);
    assert.equal(resolved, path.join(pluginDir, ".cache"));
  });

  it("preserves an absolute external folder path outside the vault", () => {
    const vaultPath = path.resolve("/tmp/my-vault");
    const externalPath = path.resolve("/var/data/shared-ai-models");
    const resolved = resolveModelFolder(externalPath, vaultPath, ".obsidian/plugins/gemmanotes");
    assert.equal(resolved, path.normalize(externalPath));
    assert.ok(!resolved.startsWith(vaultPath));
  });

  it("expands leading ~ to the user home directory", () => {
    const vaultPath = path.resolve("/tmp/my-vault");
    const resolved = resolveModelFolder("~/gemmanotes-models", vaultPath, ".obsidian/plugins/gemmanotes");
    assert.equal(resolved, path.join(os.homedir(), "gemmanotes-models"));
  });

  it("resolves relative external paths (e.g. ../models) against the vault base path", () => {
    const parentDir = path.resolve("/tmp/obsidian-workspace");
    const vaultPath = path.join(parentDir, "vault-one");
    const resolved = resolveModelFolder("../shared-models", vaultPath, ".obsidian/plugins/gemmanotes");
    assert.equal(resolved, path.join(parentDir, "shared-models"));
    assert.ok(!resolved.startsWith(vaultPath));
  });
});

describe("ExternalModelCache & local file streaming outside the vault", () => {
  let rootTempDir: string;
  let vaultDir: string;
  let externalDir: string;

  beforeEach(() => {
    rootTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gn-ext-test-"));
    vaultDir = path.join(rootTempDir, "vault");
    externalDir = path.join(rootTempDir, "external-models");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootTempDir, { recursive: true, force: true });
  });

  it("stores and retrieves model files in an external folder via Hugging Face URLs", async () => {
    const cache = new ExternalModelCache(externalDir);
    const hfUrl =
      "https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/onnx/model_q4f16.onnx";
    const payload = new Uint8Array([0x08, 0x0a, 0x12, 0x04, 0x6f, 0x6e, 0x6e, 0x78]);

    const progressUpdates: number[] = [];
    await cache.put(
      hfUrl,
      new Response(payload, {
        headers: { "content-length": String(payload.byteLength) },
      }),
      (p) => progressUpdates.push(p.progress),
    );

    const expectedDiskPath = path.join(
      externalDir,
      "onnx-community",
      "gemma-4-E2B-it-ONNX",
      "onnx",
      "model_q4f16.onnx",
    );
    assert.ok(fs.existsSync(expectedDiskPath), "Expected file to be written inside externalDir");
    assert.ok(!expectedDiskPath.startsWith(vaultDir), "Expected file to be outside vaultDir");
    assert.ok(progressUpdates.length > 0 && progressUpdates.at(-1) === 100);

    // Match by remote URL
    const matchedByRemote = await cache.match(hfUrl);
    assert.ok(matchedByRemote, "Expected cache hit by remote URL");
    assert.equal(matchedByRemote.status, 200);
    assert.equal(matchedByRemote.headers.get("content-length"), String(payload.byteLength));
    const readBytes = new Uint8Array(await matchedByRemote.arrayBuffer());
    assert.deepEqual(readBytes, payload);

    // Match by local path (as buildResourcePaths produces)
    const localKey = `${externalDir.replace(/\\/g, "/")}/onnx-community/gemma-4-E2B-it-ONNX/onnx/model_q4f16.onnx`;
    const matchedByLocal = await cache.match(localKey);
    assert.ok(matchedByLocal, "Expected cache hit by local path");
    assert.deepEqual(new Uint8Array(await matchedByLocal.arrayBuffer()), payload);

    // Delete from cache
    const deleted = await cache.delete(hfUrl);
    assert.equal(deleted, true);
    assert.equal(await cache.match(hfUrl), undefined);
  });

  it("supports non-main revision URLs and WASM runtime binary URLs", async () => {
    const cache = new ExternalModelCache(externalDir);

    const revUrl =
      "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/v2.1/config.json";
    await cache.put(revUrl, new Response(JSON.stringify({ model_type: "whisper" })));

    const matchedRev = await cache.match(revUrl);
    assert.ok(matchedRev);
    assert.deepEqual(await matchedRev.json(), { model_type: "whisper" });

    const wasmUrl =
      "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort-wasm-simd-threaded.asyncify.wasm";
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    await cache.put(wasmUrl, new Response(wasmBytes));

    const matchedWasm = await cache.match(wasmUrl);
    assert.ok(matchedWasm);
    assert.deepEqual(new Uint8Array(await matchedWasm.arrayBuffer()), wasmBytes);
  });

  it("resolves pre-populated external model folders in flat, direct, and HF hub layouts", async () => {
    // 1. Flat repo layout: <externalDir>/gemma-4-E2B-it-ONNX/config.json (without org prefix)
    const flatDir = path.join(rootTempDir, "flat-external");
    const flatConfigPath = path.join(flatDir, "gemma-4-E2B-it-ONNX", "config.json");
    fs.mkdirSync(path.dirname(flatConfigPath), { recursive: true });
    fs.writeFileSync(flatConfigPath, JSON.stringify({ layout: "flat" }));

    const flatCache = new ExternalModelCache(flatDir);
    const flatResp = await flatCache.match(
      "https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX/resolve/main/config.json",
    );
    assert.ok(flatResp, "Should match flat repo folder without org prefix");
    assert.deepEqual(await flatResp.json(), { layout: "flat" });

    // 2. Direct model folder layout: <rootTempDir>/gemma-4-E4B-it-ONNX/config.json
    const directDir = path.join(rootTempDir, "gemma-4-E4B-it-ONNX");
    fs.mkdirSync(directDir, { recursive: true });
    fs.writeFileSync(path.join(directDir, "config.json"), JSON.stringify({ layout: "direct" }));

    const directCache = new ExternalModelCache(directDir);
    const directResp = await directCache.match(
      "https://huggingface.co/onnx-community/gemma-4-E4B-it-ONNX/resolve/main/config.json",
    );
    assert.ok(directResp, "Should match direct repo folder when basename matches repo");
    assert.deepEqual(await directResp.json(), { layout: "direct" });

    // Ensure direct folder does NOT falsely match a different model repo's config.json
    const wrongRepoResp = await directCache.match(
      "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json",
    );
    assert.equal(wrongRepoResp, undefined);

    // 3. Hugging Face Hub CLI layout: <hfDir>/models--onnx-community--whisper-tiny.en/snapshots/<sha>/config.json
    const hfDir = path.join(rootTempDir, "hf-hub-cache");
    const snapConfig = path.join(
      hfDir,
      "models--onnx-community--whisper-tiny.en",
      "snapshots",
      "abc12345def",
      "config.json",
    );
    fs.mkdirSync(path.dirname(snapConfig), { recursive: true });
    fs.writeFileSync(snapConfig, JSON.stringify({ layout: "hf-hub" }));

    const hfCache = new ExternalModelCache(hfDir);
    const hfResp = await hfCache.match(
      "https://huggingface.co/onnx-community/whisper-tiny.en/resolve/main/config.json",
    );
    assert.ok(hfResp, "Should match Hugging Face Hub CLI snapshots layout");
    assert.deepEqual(await hfResp.json(), { layout: "hf-hub" });
  });

  it("streams multi-megabyte model files across multiple chunks without data corruption", async () => {
    const largeFilePath = path.join(externalDir, "large_weights.onnx_data");
    // 6.5 MB (> 4 MB chunk size so multiple pull() calls are exercised)
    const size = Math.floor(6.5 * 1024 * 1024);
    const original = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      original[i] = (i * 31 + 17) & 0xff;
    }
    fs.writeFileSync(largeFilePath, original);

    const response = createFileResponse(largeFilePath);
    assert.equal(response.headers.get("content-length"), String(size));

    const streamed = new Uint8Array(await response.arrayBuffer());
    assert.equal(streamed.byteLength, size);
    assert.equal(Buffer.compare(Buffer.from(streamed), Buffer.from(original)), 0);
  });

  it("loads local files via createLocalAwareFetch for both OS paths and file:// URLs outside the vault", async () => {
    const filePath = path.join(
      externalDir,
      "onnx-community",
      "gemma-4-E2B-it-ONNX",
      "tokenizer_config.json",
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ bos_token: "<bos>" }));

    const customFetch = createLocalAwareFetch(externalDir, async () => {
      throw new Error("Network fetch should not be called for local files");
    });

    // Fetch via absolute OS path outside vault
    const res1 = await customFetch(filePath);
    assert.equal(res1.status, 200);
    assert.deepEqual(await res1.json(), { bos_token: "<bos>" });

    // Fetch via file:// URL
    const fileUrl = url.pathToFileURL(filePath).toString();
    const res2 = await customFetch(fileUrl);
    assert.equal(res2.status, 200);
    assert.deepEqual(await res2.json(), { bos_token: "<bos>" });

    // Fetch missing local file returns 404 Response without throwing
    const resMissing = await customFetch(path.join(externalDir, "missing.json"));
    assert.equal(resMissing.status, 404);
  });
});

describe("Integration with @huggingface/transformers web bundle", () => {
  let rootTempDir: string;
  let vaultDir: string;
  let externalDir: string;

  beforeEach(() => {
    rootTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gn-tfjs-test-"));
    vaultDir = path.join(rootTempDir, "vault");
    externalDir = path.join(rootTempDir, "external-models");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootTempDir, { recursive: true, force: true });
  });

  it("loads model JSON and ONNX binary buffers from external folder outside vault with allowRemote=false", async () => {
    const tfjs = (await import("@huggingface/transformers")) as unknown as {
      env: Parameters<typeof configureTransformersEnv>[0];
      PretrainedConfig: {
        from_pretrained(
          id: string,
          opts: { cache_dir?: string; local_files_only?: boolean },
        ): Promise<Record<string, unknown>>;
      };
    };

    const repo = MODEL_REPOS["Whisper-Tiny"];
    const modelDir = path.join(externalDir, ...repo.split("/"));
    const onnxDir = path.join(modelDir, "onnx");
    fs.mkdirSync(onnxDir, { recursive: true });

    const configData = {
      model_type: "whisper",
      architectures: ["WhisperForConditionalGeneration"],
      d_model: 384,
    };
    const onnxWeights = new Uint8Array([0x08, 0x07, 0x12, 0x0c, 0x77, 0x68, 0x69, 0x73, 0x70, 0x65, 0x72]);

    fs.writeFileSync(path.join(modelDir, "config.json"), JSON.stringify(configData));
    fs.writeFileSync(path.join(onnxDir, "encoder_model.onnx"), onnxWeights);

    // Block all remote network access to prove files are loaded locally from externalDir
    tfjs.env.fetch = (async (input: RequestInfo | URL) => {
      throw new Error(`Unexpected network fetch to ${String(input)}`);
    }) as typeof fetch;

    configureTransformersEnv(tfjs.env, externalDir, false);
    assert.equal(tfjs.env.useFS, false);
    assert.equal(tfjs.env.useCustomCache, true);

    const loadedConfig = await tfjs.PretrainedConfig.from_pretrained(repo, {
      cache_dir: externalDir,
      local_files_only: true,
    });
    assert.equal(loadedConfig.model_type, "whisper");
    assert.equal(loadedConfig.d_model, 384);

    // Also verify binary ONNX file loading via customCache + env.fetch
    const cachedOnnx = await tfjs.env.customCache?.match(
      `${externalDir.replace(/\\/g, "/")}/${repo}/onnx/encoder_model.onnx`,
    );
    assert.ok(cachedOnnx);
    assert.deepEqual(new Uint8Array(await cachedOnnx.arrayBuffer()), onnxWeights);
  });

  it("downloads model files from remote into the external folder and reloads them offline", async () => {
    const tfjs = (await import("@huggingface/transformers")) as unknown as {
      env: Parameters<typeof configureTransformersEnv>[0];
      PretrainedConfig: {
        from_pretrained(
          id: string,
          opts: { cache_dir?: string; local_files_only?: boolean },
        ): Promise<Record<string, unknown>>;
      };
    };

    const repo = MODEL_REPOS.E2B;
    let networkCalls = 0;

    // Mock remote Hugging Face Hub server
    tfjs.env.fetch = (async (input: RequestInfo | URL) => {
      const reqUrl = typeof input === "string" ? input : input.toString();
      networkCalls++;
      if (reqUrl.endsWith("/config.json")) {
        const body = JSON.stringify({
          model_type: "gemma4",
          hidden_size: 2048,
          text_config: {
            model_type: "gemma4_text",
            hidden_size: 2048,
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    // Step 1: Download with allowRemote = true into externalDir
    configureTransformersEnv(tfjs.env, externalDir, true);
    const downloadedConfig = await tfjs.PretrainedConfig.from_pretrained(repo, {
      cache_dir: externalDir,
      local_files_only: false,
    });
    assert.equal(downloadedConfig.model_type, "gemma4");
    assert.equal(downloadedConfig.hidden_size, 2048);
    assert.ok(networkCalls >= 1, "Expected remote fetch during initial download");

    // Verify file was persisted inside externalDir (outside vaultDir)
    const savedConfigPath = path.join(externalDir, ...repo.split("/"), "config.json");
    assert.ok(fs.existsSync(savedConfigPath), "Expected config.json to be saved in externalDir");
    assert.ok(!fs.existsSync(path.join(vaultDir, ...repo.split("/"), "config.json")));

    // Step 2: Disable network completely and load offline from externalDir
    tfjs.env.fetch = (async () => {
      throw new Error("Offline mode: network should not be accessed");
    }) as typeof fetch;
    configureTransformersEnv(tfjs.env, externalDir, false);

    const offlineConfig = await tfjs.PretrainedConfig.from_pretrained(repo, {
      cache_dir: externalDir,
      local_files_only: true,
    });
    assert.equal(offlineConfig.model_type, "gemma4");
    assert.equal(offlineConfig.hidden_size, 2048);
  });
});

describe("isModelCached, DualBackend, GemmaNotesPlugin, and Settings UI", () => {
  let rootTempDir: string;
  let vaultDir: string;
  let externalDirA: string;
  let externalDirB: string;

  beforeEach(() => {
    rootTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gn-plugin-test-"));
    vaultDir = path.join(rootTempDir, "vault");
    externalDirA = path.join(rootTempDir, "external-models-a");
    externalDirB = path.join(rootTempDir, "external-models-b");
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.mkdirSync(externalDirA, { recursive: true });
    fs.mkdirSync(externalDirB, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(rootTempDir, { recursive: true, force: true });
  });

  function populateFakeModel(baseDir: string, variant: "E2B" | "E4B" | "Whisper-Tiny"): void {
    const repo = MODEL_REPOS[variant];
    const modelDir = path.join(baseDir, ...repo.split("/"));
    const onnxDir = path.join(modelDir, "onnx");
    fs.mkdirSync(onnxDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "config.json"), JSON.stringify({ variant }));
    fs.writeFileSync(path.join(onnxDir, "model_q4f16.onnx"), new Uint8Array([1, 2, 3, 4]));
  }

  it("detects whether a model variant is cached in an external folder via isModelCached", () => {
    assert.equal(isModelCached(externalDirA, "E2B"), false);

    populateFakeModel(externalDirA, "E2B");
    assert.equal(isModelCached(externalDirA, "E2B"), true);
    assert.equal(isModelCached(externalDirA, "E4B"), false);
  });

  it("recreates backend instances in DualBackend.updateVariants when cacheDir changes", async () => {
    const dual = new DualBackend("E2B", "E2B", false, externalDirA);
    assert.equal(dual.cacheDir, externalDirA);

    const initialTx = (dual as unknown as { txBackend: GemmaBackend }).txBackend;
    assert.equal(initialTx.cacheDir, externalDirA);

    // Same variant + same cacheDir -> reuses backend instance
    await dual.updateVariants("E2B", "E2B", false, externalDirA);
    const sameTx = (dual as unknown as { txBackend: GemmaBackend }).txBackend;
    assert.equal(sameTx, initialTx);

    // Same variant + different external cacheDir -> creates new backend with new cacheDir
    await dual.updateVariants("E2B", "E2B", false, externalDirB);
    const updatedTx = (dual as unknown as { txBackend: GemmaBackend }).txBackend;
    assert.notEqual(updatedTx, initialTx);
    assert.equal(updatedTx.cacheDir, externalDirB);
    assert.equal(dual.cacheDir, externalDirB);

    // WhisperBackend also receives the external cacheDir
    await dual.updateVariants("Whisper-Tiny", "E2B", false, externalDirB);
    const whisperTx = (dual as unknown as { txBackend: WhisperBackend }).txBackend;
    assert.ok(whisperTx instanceof WhisperBackend);
    assert.equal(whisperTx.cacheDir, externalDirB);
  });

  it("configures transformers env and passes external cache_dir in GemmaBackend.load", async () => {
    const tfjs = (await import("@huggingface/transformers")) as unknown as {
      AutoProcessor: {
        from_pretrained: (
          id: string,
          opts?: { cache_dir?: string; local_files_only?: boolean },
        ) => Promise<unknown>;
      };
      Gemma4ForConditionalGeneration: {
        from_pretrained: (
          id: string,
          opts?: { cache_dir?: string; local_files_only?: boolean; dtype?: string; device?: string },
        ) => Promise<unknown>;
      };
      env: Parameters<typeof configureTransformersEnv>[0];
    };

    const origProc = tfjs.AutoProcessor.from_pretrained;
    const origModel = tfjs.Gemma4ForConditionalGeneration.from_pretrained;

    const capturedCalls: Array<{ fn: string; id: string; opts: Record<string, unknown> | undefined }> = [];

    tfjs.AutoProcessor.from_pretrained = async (id, opts) => {
      capturedCalls.push({ fn: "processor", id, opts });
      return Object.assign(
        async () => ({ input_ids: { dims: [1, 4], dispose() {} } }),
        {
          apply_chat_template: () => "prompt",
          batch_decode: () => ["transcribed text"],
        },
      );
    };
    tfjs.Gemma4ForConditionalGeneration.from_pretrained = async (id, opts) => {
      capturedCalls.push({ fn: "model", id, opts });
      return {
        generate: async () => ({
          dims: [1, 8],
          slice: () => ({ dims: [1, 4], dispose() {} }),
          dispose() {},
        }),
        dispose: async () => {},
      };
    };

    try {
      const backend = new GemmaBackend("E2B", false, externalDirA);
      const progressEvents: string[] = [];
      await backend.load((u) => progressEvents.push(u.label), false);

      assert.equal(backend.ready, true);
      assert.equal(tfjs.env.useCustomCache, true);
      assert.equal(tfjs.env.cacheDir, path.resolve(externalDirA));
      assert.equal(tfjs.env.allowRemoteModels, false);
      assert.equal(capturedCalls.length, 2);
      assert.equal(capturedCalls[0]?.opts?.cache_dir, externalDirA);
      assert.equal(capturedCalls[0]?.opts?.local_files_only, true);
      assert.equal(capturedCalls[1]?.opts?.cache_dir, externalDirA);
      assert.equal(capturedCalls[1]?.opts?.local_files_only, true);

      const text = await backend.transcribeChunk(new Float32Array(1600), {
        style: "cleaned",
        language: "en",
      });
      assert.equal(text, "transcribed text");
      await backend.unload();
      assert.equal(backend.ready, false);
    } finally {
      tfjs.AutoProcessor.from_pretrained = origProc;
      tfjs.Gemma4ForConditionalGeneration.from_pretrained = origModel;
    }
  });

  it("syncs downloadedModels state and updates backend cacheDir when switching external model folders in GemmaNotesPlugin", async () => {
    // Pre-populate E2B in externalDirA (outside vaultDir), leave externalDirB empty
    populateFakeModel(externalDirA, "E2B");

    const mockApp = {
      vault: {
        adapter: new FileSystemAdapter(vaultDir),
      },
      workspace: {
        onLayoutReady: () => {},
        on: () => ({}),
      },
    };

    const plugin = new GemmaNotesPlugin(mockApp as never, {
      id: "gemmanotes",
      dir: ".obsidian/plugins/gemmanotes",
    });

    await plugin.loadSettings();

    // Default cacheDir is inside vaultDir
    assert.equal(
      plugin.getCacheDir(),
      path.join(vaultDir, ".obsidian/plugins/gemmanotes", ".cache"),
    );
    assert.equal(plugin.settings.downloadedModels.E2B, false);

    // Stub loadModelsIfDownloaded to avoid starting a full Gemma4 inference session in this unit test
    (plugin as unknown as { loadModelsIfDownloaded: () => Promise<void> }).loadModelsIfDownloaded =
      async () => {};

    // Point plugin to externalDirA where E2B is already stored
    await plugin.setModelFolder(externalDirA);
    assert.equal(plugin.getCacheDir(), externalDirA);
    assert.equal(
      plugin.settings.downloadedModels.E2B,
      true,
      "Should automatically detect E2B in externalDirA",
    );
    assert.equal(
      (plugin as unknown as { backend: DualBackend }).backend.cacheDir,
      externalDirA,
    );

    // Switch to empty externalDirB -> downloadedModels.E2B should reset to false
    await plugin.setModelFolder(externalDirB);
    assert.equal(plugin.getCacheDir(), externalDirB);
    assert.equal(
      plugin.settings.downloadedModels.E2B,
      false,
      "Should mark E2B as not downloaded when switching to empty externalDirB",
    );
    assert.equal(
      (plugin as unknown as { backend: DualBackend }).backend.cacheDir,
      externalDirB,
    );

    // Render settings tab and verify changing External model folder updates UI status
    const settingTab = new GemmaNotesSettingTab(mockApp as never, plugin);
    settingTab.display();

    const settingsList = settingTab.containerEl.settings ?? [];
    const folderSetting = settingsList.find((s: Setting) => s.name === "External model folder");
    const filesSetting = settingsList.find((s: Setting) => s.name === "Model files");

    assert.ok(folderSetting, "Expected 'External model folder' setting to be rendered");
    assert.ok(filesSetting, "Expected 'Model files' setting to be rendered");
    assert.match(filesSetting.desc, /Not downloaded/);

    // Simulate user entering externalDirA in the External model folder setting input
    const textInput = folderSetting.textComponents[0];
    assert.ok(textInput);
    await textInput.onChangeCallback?.(externalDirA);

    assert.equal(plugin.settings.modelFolder, externalDirA);
    assert.equal(plugin.settings.downloadedModels.E2B, true);
    assert.equal(filesSetting.desc, "E2B: Downloaded.");
    assert.equal(filesSetting.buttonComponents[0]?.buttonText, "Re-download");
  });
});
