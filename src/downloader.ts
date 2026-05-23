/**
 * Model file downloader.
 *
 * Pre-fetches HuggingFace model files into the plugin directory, then exposes a
 * `fetch()` shim so transformers.js can load them as if they were on a CDN.
 * This sidesteps transformers.js's File System Cache entirely, which doesn't
 * work in the Obsidian renderer (its `process.release.name === "node"` guard
 * is intentionally bypassed elsewhere to force the ORT-Web runtime).
 */

import type { Vault } from "obsidian";

export interface DownloadProgress {
  /** 0..1 fraction of total bytes, or null if total is unknown. */
  fraction: number | null;
  /** Human-readable status line. */
  label: string;
}

interface TreeEntry {
  type: "file" | "directory";
  path: string;
  size: number;
}

interface ManifestFile {
  path: string;
  size: number;
}

interface CompletionManifest {
  version: 1;
  repo: string;
  dtype: string | null;
  files: ManifestFile[];
  completedAt: string;
}

/** Sentinel host; the fetch shim intercepts any URL starting with this prefix. */
const SENTINEL = "https://gemmanotes-local.invalid/";

const HF_API = "https://huggingface.co/api/models";
const HF_RESOLVE = "https://huggingface.co";

const RETRY_DELAYS_MS = [1000, 4000, 16000];

export class ModelDownloader {
  private originalFetch: typeof fetch | null = null;
  private activeDownloads = new Set<string>();

  constructor(private vault: Vault, private pluginDir: string) {}

  /** URL prefix to use as `env.localModelPath`. */
  get sentinel(): string {
    return SENTINEL;
  }

  /** Install a global fetch shim that serves SENTINEL-prefixed URLs from disk. */
  installFetchShim(): void {
    if (this.originalFetch) return;
    this.originalFetch = globalThis.fetch.bind(globalThis);
    const orig = this.originalFetch;
    const vault = this.vault;
    const pluginDir = this.pluginDir;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(SENTINEL)) {
        const rel = url.slice(SENTINEL.length);
        const diskPath = `${pluginDir}/models/${rel}`;
        try {
          const buf = await vault.adapter.readBinary(diskPath);
          return new Response(buf, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        } catch (e) {
          return new Response(null, { status: 404, statusText: `Not found: ${rel}` });
        }
      }
      return orig(input as any, init);
    };
  }

  uninstallFetchShim(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }

  /** True if a complete manifest exists for this repo. */
  async isDownloaded(repo: string): Promise<boolean> {
    const manifestPath = this.manifestPath(repo);
    return await this.vault.adapter.exists(manifestPath);
  }

  /**
   * Ensure all files for the given repo are downloaded. Idempotent: if the
   * completion manifest is present, returns immediately.
   */
  async ensureDownloaded(
    repo: string,
    dtype: string | null,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<void> {
    if (this.activeDownloads.has(repo)) {
      throw new Error(`Download for ${repo} is already in progress.`);
    }
    this.activeDownloads.add(repo);
    try {
      if (await this.isDownloaded(repo)) {
        onProgress({ fraction: 1, label: `${repo} already downloaded.` });
        return;
      }

      onProgress({ fraction: null, label: `Fetching file list for ${repo}…` });
      const tree = await this.fetchTree(repo);
      const wanted = tree.filter((e) => e.type === "file" && this.shouldInclude(e.path, dtype));
      if (wanted.length === 0) {
        throw new Error(`No matching files found in ${repo} for dtype=${dtype}.`);
      }

      const totalBytes = wanted.reduce((a, b) => a + (b.size || 0), 0);
      let doneBytes = 0;

      await this.ensureDir(`${this.pluginDir}/models/${repo}`);

      for (const file of wanted) {
        const finalPath = `${this.pluginDir}/models/${repo}/${file.path}`;
        if (await this.vault.adapter.exists(finalPath)) {
          const stat = await this.vault.adapter.stat(finalPath);
          if (stat && stat.size === file.size) {
            doneBytes += file.size;
            continue;
          }
          await this.vault.adapter.remove(finalPath);
        }

        await this.ensureDir(this.dirname(finalPath));
        const fileStartBytes = doneBytes;
        await this.downloadFileWithRetry(repo, file, (bytesInFile) => {
          const frac = totalBytes > 0 ? (fileStartBytes + bytesInFile) / totalBytes : null;
          onProgress({ fraction: frac, label: `Downloading ${file.path}` });
        });
        doneBytes += file.size;
      }

      const manifest: CompletionManifest = {
        version: 1,
        repo,
        dtype,
        files: wanted.map((f) => ({ path: f.path, size: f.size })),
        completedAt: new Date().toISOString(),
      };
      await this.vault.adapter.write(this.manifestPath(repo), JSON.stringify(manifest, null, 2));
      onProgress({ fraction: 1, label: `${repo} downloaded.` });
    } finally {
      this.activeDownloads.delete(repo);
    }
  }

  /** Delete all files for one repo. */
  async deleteRepo(repo: string): Promise<void> {
    const dir = `${this.pluginDir}/models/${repo}`;
    if (await this.vault.adapter.exists(dir)) {
      await this.vault.adapter.rmdir(dir, true);
    }
  }

  /** Wipe both the new models/ tree and the legacy .cache/ tree. */
  async cleanAll(): Promise<void> {
    for (const dir of [`${this.pluginDir}/models`, `${this.pluginDir}/.cache`]) {
      if (await this.vault.adapter.exists(dir)) {
        await this.vault.adapter.rmdir(dir, true);
      }
    }
  }

  /** Total bytes on disk under models/, plus per-repo breakdown. */
  async list(): Promise<Array<{ repo: string; bytes: number }>> {
    const root = `${this.pluginDir}/models`;
    if (!(await this.vault.adapter.exists(root))) return [];
    const out: Array<{ repo: string; bytes: number }> = [];
    const top = await this.vault.adapter.list(root);
    // Layout is models/<org>/<name>/...; HF repos are org-prefixed.
    for (const orgDir of top.folders) {
      const inner = await this.vault.adapter.list(orgDir);
      for (const repoDir of inner.folders) {
        const repo = repoDir.slice(`${root}/`.length);
        const bytes = await this.dirSize(repoDir);
        out.push({ repo, bytes });
      }
    }
    return out;
  }

  // --- internals ---------------------------------------------------------

  private manifestPath(repo: string): string {
    return `${this.pluginDir}/models/${repo}/.gemmanotes.manifest.json`;
  }

  private async fetchTree(repo: string): Promise<TreeEntry[]> {
    const url = `${HF_API}/${repo}/tree/main?recursive=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HF tree API failed (${res.status}) for ${repo}`);
    const json = (await res.json()) as TreeEntry[];
    return json;
  }

  /**
   * Filter rule: keep all non-ONNX files (configs, tokenizers). For ONNX
   * weight files keep only those matching the requested dtype; or if no
   * dtype is requested, keep files with no dtype suffix.
   *
   * ONNX weight files include `.onnx`, `.onnx_data`, and numbered external
   * data parts like `.onnx_data_1`, `.onnx_data_2`, ... (protobuf 2 GB cap
   * forces large weight files to spill across multiple parts).
   */
  private shouldInclude(path: string, dtype: string | null): boolean {
    const onnxExt = /\.onnx(_data(_\d+)?)?$/;
    if (!onnxExt.test(path)) return true;
    const base = path.slice(path.lastIndexOf("/") + 1);
    const stem = base.replace(onnxExt, "");

    // Always include the encoder_model, as transformers.js loads the unquantized
    // encoder_model even when dtype is set to 'quantized'.
    if (stem === "encoder_model") {
      return true;
    }

    // Known dtype tokens transformers.js may produce.
    const dtypeRe = /_(fp16|fp32|q4|q4f16|int8|uint8|q8|bnb4|quantized)$/;
    const m = stem.match(dtypeRe);
    if (dtype == null) {
      // No dtype specified: take the unsuffixed default.
      return !m;
    }
    return m != null && m[1] === dtype;
  }

  private async downloadFileWithRetry(
    repo: string,
    file: TreeEntry,
    onBytes: (n: number) => void,
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      try {
        await this.downloadFile(repo, file, onBytes);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
    }
    throw new Error(`Failed to download ${file.path} after retries: ${String(lastErr)}`);
  }

  private async downloadFile(
    repo: string,
    file: TreeEntry,
    onBytes: (n: number) => void,
  ): Promise<void> {
    const finalPath = `${this.pluginDir}/models/${repo}/${file.path}`;

    // If finalPath already exists and has the correct size, skip downloading entirely.
    // This can happen if a concurrent download finished, or if a retry occurs
    // after a successful download of this file.
    if (await this.vault.adapter.exists(finalPath)) {
      const stat = await this.vault.adapter.stat(finalPath);
      if (stat && stat.size === file.size) {
        onBytes(file.size);
        return;
      }
    }

    const url = `${HF_RESOLVE}/${repo}/resolve/main/${file.path}`;
    const tmpPath = `${finalPath}.tmp`;

    // Clean stale tmp from a prior aborted run.
    if (await this.vault.adapter.exists(tmpPath)) {
      await this.vault.adapter.remove(tmpPath);
    }

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    if (!res.body) throw new Error(`Empty response body for ${url}`);

    const reader = res.body.getReader();
    let received = 0;

    const adapter = this.vault.adapter;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Extract only the current chunk's bytes as an ArrayBuffer and append it
      const chunkBuf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      await (adapter as any).appendBinary(tmpPath, chunkBuf);

      received += value.length;
      onBytes(received);
    }

    // Ensure finalPath does not exist before rename, as adapter.rename fails on existing destination.
    if (await this.vault.adapter.exists(finalPath)) {
      await this.vault.adapter.remove(finalPath);
    }
    // adapter.rename is the atomic step that publishes the file.
    await this.vault.adapter.rename(tmpPath, finalPath);
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!(await this.vault.adapter.exists(dir))) {
      await this.vault.adapter.mkdir(dir);
    }
  }

  private dirname(p: string): string {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  }

  private async dirSize(dir: string): Promise<number> {
    let total = 0;
    const entries = await this.vault.adapter.list(dir);
    for (const f of entries.files) {
      const st = await this.vault.adapter.stat(f);
      if (st) total += st.size;
    }
    for (const sub of entries.folders) {
      total += await this.dirSize(sub);
    }
    return total;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
