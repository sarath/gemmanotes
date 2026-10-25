/**
 * External folder storage and local file loading for GemmaNotes models.
 *
 * Obsidian bundles `@huggingface/transformers` using its web entrypoint
 * (`transformers.web.js`), which stubs out `node:fs` (`IS_FS_AVAILABLE = false`).
 * Additionally, Chromium/Electron's `fetch()` in the `app://obsidian.md` renderer
 * cannot load arbitrary filesystem paths outside the vault.
 *
 * This module bridges `@huggingface/transformers` to Node's native `fs` API via:
 * 1. `ExternalModelCache` (`env.customCache`) to read and write model files in any
 *    local/external directory on disk.
 * 2. `createLocalAwareFetch` (`env.fetch`) so local model file checks succeed even
 *    when the model folder is outside the Obsidian vault.
 */

if (typeof process !== "undefined" && process?.release?.name === "node") {
  Object.defineProperty(process, "release", {
    value: { ...process.release, name: "electron" },
    configurable: true,
    writable: true,
  });
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as url from "url";
import { MODEL_REPOS } from "./types";
import type { ModelVariant } from "./types";

const STREAM_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MB chunks for fast streaming

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  json: "application/json",
  txt: "text/plain",
  jinja: "text/plain",
  mjs: "text/javascript",
  js: "text/javascript",
  wasm: "application/wasm",
  onnx: "application/octet-stream",
  onnx_data: "application/octet-stream",
};

export interface CacheProgressData {
  progress: number;
  loaded: number;
  total: number;
}

export interface TransformersCacheInterface {
  match(request: string): Promise<Response | undefined>;
  put(
    request: string,
    response: Response,
    progress_callback?: (data: CacheProgressData) => void,
  ): Promise<void>;
  delete?(request: string): Promise<boolean>;
}

export interface ConfigurableTransformersEnv {
  allowLocalModels: boolean;
  localModelPath?: string;
  useFS?: boolean;
  useBrowserCache: boolean;
  useFSCache: boolean;
  cacheDir?: string | null;
  useCustomCache?: boolean;
  customCache?: TransformersCacheInterface | null;
  allowRemoteModels: boolean;
  fetch?: typeof fetch;
  backends?: {
    onnx?: {
      wasm?: {
        wasmPaths?: unknown;
      };
    };
  };
}

const BASE_FETCH_MAP = new WeakMap<typeof fetch, typeof fetch>();

/** Convert a Windows or POSIX path to forward slashes for URL/transformers.js path joining. */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Resolve the effective model storage folder from user settings and vault paths.
 *
 * - If `configuredFolder` is non-empty, expands leading `~` to the user home
 *   directory and resolves relative paths against `vaultBasePath` (if available).
 * - If `configuredFolder` is empty, falls back to `<vault>/<pluginDir>/.cache`.
 */
export function resolveModelFolder(
  configuredFolder: string | undefined,
  vaultBasePath: string | null,
  pluginDir: string,
): string {
  const trimmed = configuredFolder?.trim() ?? "";
  if (trimmed.length > 0) {
    let expanded = trimmed;
    if (
      expanded === "~" ||
      expanded.startsWith("~/") ||
      expanded.startsWith("~\\")
    ) {
      expanded = path.join(os.homedir(), expanded.slice(1));
    }
    if (path.isAbsolute(expanded)) {
      return path.normalize(expanded);
    }
    if (vaultBasePath) {
      return path.resolve(vaultBasePath, expanded);
    }
    return path.resolve(expanded);
  }

  if (vaultBasePath) {
    return path.join(vaultBasePath, pluginDir, ".cache");
  }
  return path.join(pluginDir, ".cache");
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext] ?? "application/octet-stream";
}

function safeJoin(baseDir: string, ...parts: string[]): string {
  const resolvedBase = path.resolve(baseDir);
  const sanitizedSegments = parts
    .flatMap((part) => part.replace(/\\/g, "/").split("/"))
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");
  return path.resolve(resolvedBase, ...sanitizedSegments);
}

function isRegularFile(filePath: string): { exists: true; size: number } | { exists: false } {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      return { exists: true, size: stat.size };
    }
  } catch {
    // File does not exist or cannot be accessed
  }
  return { exists: false };
}

/**
 * Create a standard Web `Response` whose body lazily streams a local file from disk
 * using Node's `fs.promises.open`. No file descriptor is opened until the body is read.
 */
export function createFileResponse(filePath: string, size?: number): Response {
  const fileSize = size ?? fs.statSync(filePath).size;
  const contentType = getContentType(filePath);
  let handle: fs.promises.FileHandle | null = null;
  let position = 0;

  const closeHandle = async () => {
    if (handle) {
      const current = handle;
      handle = null;
      try {
        await current.close();
      } catch {
        // Ignore close errors
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (!handle) {
          handle = await fs.promises.open(filePath, "r");
        }
        const remaining = fileSize - position;
        if (remaining <= 0) {
          await closeHandle();
          controller.close();
          return;
        }
        const bytesToRead = Math.min(STREAM_CHUNK_BYTES, remaining);
        const chunk = new Uint8Array(bytesToRead);
        const { bytesRead } = await handle.read(chunk, 0, bytesToRead, position);
        if (bytesRead <= 0) {
          await closeHandle();
          controller.close();
          return;
        }
        position += bytesRead;
        controller.enqueue(bytesRead === bytesToRead ? chunk : chunk.subarray(0, bytesRead));
        if (position >= fileSize) {
          await closeHandle();
          controller.close();
        }
      } catch (err) {
        await closeHandle();
        controller.error(err);
      }
    },
    async cancel() {
      await closeHandle();
    },
  });

  return new Response(stream, {
    status: 200,
    statusText: "OK",
    headers: {
      "content-length": String(fileSize),
      "content-type": contentType,
    },
  });
}

interface ParsedModelRequest {
  org: string;
  repo: string;
  revision: string;
  filePath: string;
}

function parseHttpUrl(input: string): URL | null {
  if (!/^https?:\/\//i.test(input)) {
    return null;
  }
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function parseModelRequest(request: string, cacheDir: string): ParsedModelRequest | null {
  const httpUrl = parseHttpUrl(request);
  if (httpUrl) {
    // Match Hugging Face Hub resolve URLs: /<org>/<repo>/resolve/<revision>/<filePath>
    const hfMatch = httpUrl.pathname.match(/^\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+)$/);
    if (hfMatch) {
      return {
        org: decodeURIComponent(hfMatch[1]),
        repo: decodeURIComponent(hfMatch[2]),
        revision: decodeURIComponent(hfMatch[3]),
        filePath: hfMatch[4].replace(/^\/+/, ""),
      };
    }
    return null;
  }

  let local = request;
  if (local.startsWith("file://")) {
    try {
      local = url.fileURLToPath(local);
    } catch {
      // Keep original string if fileURLToPath fails
    }
  }

  const posixCacheDir = toPosixPath(path.resolve(cacheDir)).replace(/\/+$/, "");
  const posixRawCacheDir = toPosixPath(cacheDir).replace(/\/+$/, "");
  let posixLocal = toPosixPath(local);

  const isWin = process.platform === "win32";
  const startsWithDir = (target: string, prefix: string): boolean => {
    if (!prefix) return false;
    if (isWin) {
      return target.toLowerCase().startsWith(prefix.toLowerCase() + "/");
    }
    return target.startsWith(prefix + "/");
  };

  if (startsWithDir(posixLocal, posixCacheDir)) {
    posixLocal = posixLocal.slice(posixCacheDir.length + 1);
  } else if (startsWithDir(posixLocal, posixRawCacheDir)) {
    posixLocal = posixLocal.slice(posixRawCacheDir.length + 1);
  } else if (posixLocal.startsWith("/models/")) {
    posixLocal = posixLocal.slice("/models/".length);
  }

  const segments = posixLocal
    .split("/")
    .filter((s) => s.length > 0 && s !== "." && s !== "..");

  if (segments.length >= 3) {
    return {
      org: segments[0],
      repo: segments[1],
      revision: "main",
      filePath: segments.slice(2).join("/"),
    };
  }

  return null;
}

/**
 * Filesystem-backed cache implementing the Web Cache API interface expected by
 * `@huggingface/transformers` (`env.customCache`).
 *
 * Works in Electron/Obsidian even when `transformers.web.js` is bundled without `node:fs`
 * and when the target `cacheDir` is outside the Obsidian vault.
 */
export class ExternalModelCache implements TransformersCacheInterface {
  readonly cacheDir: string;

  constructor(cacheDir: string) {
    this.cacheDir = path.resolve(cacheDir);
  }

  /**
   * Map a cache key (Hugging Face URL, CDN WASM URL, or local path) to the canonical
   * destination path inside `this.cacheDir`.
   */
  resolveTargetFilePath(request: string): string {
    const parsedModel = parseModelRequest(request, this.cacheDir);
    if (parsedModel) {
      const { org, repo, revision, filePath } = parsedModel;
      if (revision === "main") {
        return safeJoin(this.cacheDir, org, repo, filePath);
      }
      return safeJoin(this.cacheDir, org, repo, revision, filePath);
    }

    const httpUrl = parseHttpUrl(request);
    if (httpUrl) {
      return safeJoin(
        this.cacheDir,
        ".wasm",
        httpUrl.hostname,
        httpUrl.pathname.replace(/^\/+/, ""),
      );
    }

    let local = request;
    if (local.startsWith("file://")) {
      try {
        local = url.fileURLToPath(local);
      } catch {
        // Ignore conversion errors
      }
    }

    const posixCacheDir = toPosixPath(this.cacheDir).replace(/\/+$/, "");
    let posixLocal = toPosixPath(local);
    if (posixLocal.startsWith("/models/")) {
      posixLocal = posixLocal.slice("/models/".length);
    } else if (
      process.platform === "win32"
        ? posixLocal.toLowerCase().startsWith(posixCacheDir.toLowerCase() + "/")
        : posixLocal.startsWith(posixCacheDir + "/")
    ) {
      posixLocal = posixLocal.slice(posixCacheDir.length + 1);
    }

    return safeJoin(this.cacheDir, posixLocal);
  }

  /**
   * Locate an existing file on disk for `request`, supporting:
   * 1. Canonical `<cacheDir>/<org>/<repo>/<filePath>` (and `<revision>` subfolder)
   * 2. Flat `<cacheDir>/<repo>/<filePath>` (e.g. a cloned repo folder without `<org>/`)
   * 3. Direct model folder `<cacheDir>/<filePath>` when `basename(cacheDir) === repo`
   * 4. Hugging Face Hub CLI layout `<cacheDir>/models--<org>--<repo>/snapshots/<hash>/<filePath>`
   * 5. Direct absolute path if `request` already points to an existing file on disk
   */
  resolveExistingFilePath(request: string): string | null {
    const candidates: string[] = [this.resolveTargetFilePath(request)];

    const parsed = parseModelRequest(request, this.cacheDir);
    if (parsed) {
      const { org, repo, revision, filePath } = parsed;
      if (revision !== "main") {
        candidates.push(safeJoin(this.cacheDir, org, repo, filePath));
      }
      // Flat repo folder: <cacheDir>/<repo>/<filePath>
      candidates.push(safeJoin(this.cacheDir, repo, filePath));

      // Direct folder: <cacheDir>/<filePath> when cacheDir is named after the repo
      if (path.basename(this.cacheDir).toLowerCase() === repo.toLowerCase()) {
        candidates.push(safeJoin(this.cacheDir, filePath));
      }

      // Hugging Face CLI hub cache: <cacheDir>/models--<org>--<repo>/snapshots/<rev>/<filePath>
      const hfSnapshotsDir = safeJoin(this.cacheDir, `models--${org}--${repo}`, "snapshots");
      try {
        if (fs.existsSync(hfSnapshotsDir) && fs.statSync(hfSnapshotsDir).isDirectory()) {
          const snapshots = fs.readdirSync(hfSnapshotsDir);
          for (const snap of snapshots) {
            candidates.push(safeJoin(hfSnapshotsDir, snap, filePath));
          }
        }
      } catch {
        // Ignore directory read errors
      }
    }

    if (!parseHttpUrl(request)) {
      let rawPath = request;
      if (rawPath.startsWith("file://")) {
        try {
          rawPath = url.fileURLToPath(rawPath);
        } catch {
          // Ignore
        }
      }
      if (!rawPath.startsWith("/models/") && path.isAbsolute(rawPath)) {
        candidates.push(path.normalize(rawPath));
      }
    }

    for (const candidate of candidates) {
      const check = isRegularFile(candidate);
      if (check.exists) {
        return candidate;
      }
    }

    return null;
  }

  async match(request: string): Promise<Response | undefined> {
    const existingPath = this.resolveExistingFilePath(request);
    if (!existingPath) {
      return undefined;
    }
    try {
      const stat = await fs.promises.stat(existingPath);
      if (!stat.isFile()) {
        return undefined;
      }
      return createFileResponse(existingPath, stat.size);
    } catch {
      return undefined;
    }
  }

  async put(
    request: string,
    response: Response,
    progress_callback?: (data: CacheProgressData) => void,
  ): Promise<void> {
    const targetPath = this.resolveTargetFilePath(request);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    const pid = typeof process !== "undefined" ? process.pid : 0;
    const suffix = Math.random().toString(36).slice(2, 10);
    const tmpPath = `${targetPath}.tmp.${pid}.${Date.now()}.${suffix}`;

    const contentLength = response.headers?.get("content-length") ?? response.headers?.get("Content-Length");
    const total = contentLength ? parseInt(contentLength, 10) || 0 : 0;
    let loaded = 0;

    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(tmpPath, "w");
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            await handle.write(value, 0, value.byteLength);
            loaded += value.byteLength;
            const progress = total > 0 ? (loaded / total) * 100 : 0;
            progress_callback?.({ progress, loaded, total });
          }
        }
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 0) {
          await handle.write(bytes, 0, bytes.byteLength);
        }
        loaded = bytes.byteLength;
        progress_callback?.({ progress: 100, loaded, total: total || loaded });
      }

      await handle.close();
      handle = null;

      try {
        await fs.promises.rename(tmpPath, targetPath);
      } catch {
        // On Windows, rename can fail if targetPath already exists; remove and retry
        try {
          await fs.promises.unlink(targetPath);
        } catch {
          // Ignore if targetPath did not exist
        }
        await fs.promises.rename(tmpPath, targetPath);
      }
    } catch (err) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Ignore close errors
        }
      }
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // Ignore unlink errors
      }
      throw err;
    }
  }

  async delete(request: string): Promise<boolean> {
    const target = this.resolveExistingFilePath(request) ?? this.resolveTargetFilePath(request);
    try {
      await fs.promises.unlink(target);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Create a `fetch` implementation that loads local filesystem paths (including external
 * folders outside the Obsidian vault and `file://` URLs) via Node `fs`, while delegating
 * `http:`, `https:`, `blob:`, and `data:` requests to the standard network `fetch`.
 */
export function createLocalAwareFetch(
  cacheDir: string,
  baseFetch?: typeof fetch,
): typeof fetch {
  const unwrappedBase = baseFetch ? (BASE_FETCH_MAP.get(baseFetch) ?? baseFetch) : undefined;
  const fallbackFetch =
    unwrappedBase ??
    (typeof window !== "undefined" && typeof window.fetch === "function"
      ? window.fetch.bind(window)
      : undefined);

  const cache = new ExternalModelCache(cacheDir);

  const localAwareFetch: typeof fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (/^(https?|blob|data):/i.test(rawUrl)) {
      if (!fallbackFetch) {
        throw new Error(`Fetch is not available to request "${rawUrl}".`);
      }
      return fallbackFetch(input, init);
    }

    const existingPath = cache.resolveExistingFilePath(rawUrl);
    if (!existingPath) {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }

    try {
      const stat = await fs.promises.stat(existingPath);
      if (!stat.isFile()) {
        return new Response(null, { status: 404, statusText: "Not Found" });
      }
      return createFileResponse(existingPath, stat.size);
    } catch {
      return new Response(null, { status: 404, statusText: "Not Found" });
    }
  };

  if (fallbackFetch) {
    BASE_FETCH_MAP.set(localAwareFetch, fallbackFetch);
  }
  return localAwareFetch;
}

/**
 * Configure `@huggingface/transformers` environment to store and load models
 * from `cacheDir` (which may be outside the Obsidian vault).
 */
export function configureTransformersEnv(
  env: ConfigurableTransformersEnv,
  cacheDir: string,
  allowRemote = true,
): ExternalModelCache {
  const resolvedDir = path.resolve(cacheDir);
  const modelCache = new ExternalModelCache(resolvedDir);

  env.allowLocalModels = true;
  env.localModelPath = toPosixPath(resolvedDir);
  env.useFS = false;
  env.useBrowserCache = false;
  env.useFSCache = false;
  env.cacheDir = resolvedDir;
  env.useCustomCache = true;
  env.customCache = modelCache;
  env.allowRemoteModels = allowRemote;
  env.fetch = createLocalAwareFetch(resolvedDir, env.fetch);

  return modelCache;
}

/**
 * Check whether the given model variant has its core configuration and ONNX model files
 * present on disk inside `cacheDir`.
 */
export function isModelCached(cacheDir: string, variant: ModelVariant): boolean {
  if (!cacheDir) return false;
  const repo = MODEL_REPOS[variant];
  if (!repo) return false;

  const cache = new ExternalModelCache(cacheDir);
  const configPath = cache.resolveExistingFilePath(`${repo}/config.json`);
  if (!configPath) {
    return false;
  }

  const modelRoot = path.dirname(configPath);
  const onnxDir = path.join(modelRoot, "onnx");
  try {
    if (fs.existsSync(onnxDir) && fs.statSync(onnxDir).isDirectory()) {
      const files = fs.readdirSync(onnxDir);
      if (files.some((f) => f.endsWith(".onnx"))) {
        return true;
      }
    }
    const rootFiles = fs.readdirSync(modelRoot);
    if (rootFiles.some((f) => f.endsWith(".onnx"))) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}
