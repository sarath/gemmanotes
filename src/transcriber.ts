/**
 * Transcription backend.
 *
 * The backend is kept behind an interface so a remote endpoint could be added
 * later without touching the rest of the plugin. `GemmaBackend` is the default
 * in-process implementation using transformers.js + Gemma 4 ONNX.
 */

// Electron renderer presents a global `process` object with process.release.name === 'node'.
// This fools transformers.js into thinking it's in a pure Node.js environment,
// which breaks model loading (it attempts to return paths and load via Node fs).
// We override process.release.name to 'electron' so that transformers.js correctly
// uses the web/browser configuration (loading via Uint8Array buffers and using WASM/WebGPU).
if (typeof process !== "undefined" && process?.release?.name === "node") {
  Object.defineProperty(process, "release", {
    value: { ...process.release, name: "electron" },
    configurable: true,
    writable: true,
  });
}

import type { ModelVariant, Style, TranscriptionModelVariant, RewriteModelVariant } from "./types";
import { MODEL_REPOS } from "./types";

interface TransformersEnv {
  allowLocalModels: boolean;
  useBrowserCache: boolean;
  useFSCache: boolean;
  allowRemoteModels: boolean;
  backends?: {
    onnx?: {
      wasm?: {
        wasmPaths?: unknown;
      };
    };
  };
}

interface PretrainedModelClass {
  from_pretrained(
    modelId: string,
    options?: {
      dtype?: string;
      device?: string;
      progress_callback?: (progress: ProgressEventData) => void;
    }
  ): Promise<GemmaModelInstance>;
}

interface PretrainedProcessorClass {
  from_pretrained(
    modelId: string,
    options?: {
      progress_callback?: (progress: ProgressEventData) => void;
    }
  ): Promise<GemmaProcessorInstance>;
}

interface GemmaModelInstance {
  dispose?(): Promise<void>;
  generate(options: unknown): Promise<GemmaTensor>;
}

interface GemmaProcessorInstance {
  (prompt: string, arg2: null, audio: Float32Array | null, options: unknown): Promise<GemmaInputs>;
  apply_chat_template(messages: unknown, options: { enable_thinking: boolean; add_generation_prompt: boolean }): string;
  batch_decode(outputs: unknown, options: { skip_special_tokens: boolean }): string[];
}

interface GemmaInputs {
  input_ids: GemmaTensor;
  [key: string]: unknown;
}

interface GemmaTensor {
  dims: number[];
  dispose?(): void;
  slice(arg1: null, range: [number | null, number | null]): GemmaTensor;
}

interface ProgressEventData {
  progress?: number;
  status?: string;
  file?: string;
}

interface WhisperPipelineInstance {
  (audio: Float32Array): Promise<{ text: string } | null>;
  dispose?(): Promise<void>;
  model?: {
    dispose?(): Promise<void>;
  };
}

interface PretrainedPipelineClass {
  (
    task: "automatic-speech-recognition",
    repo: string,
    options?: {
      device?: string;
      progress_callback?: (progress: ProgressEventData) => void;
    }
  ): Promise<WhisperPipelineInstance>;
}

export interface ProgressUpdate {
  /** 0..1 overall download fraction, or null when indeterminate. */
  fraction: number | null;
  /** Human-readable status line. */
  label: string;
}

export interface TranscribeOptions {
  style: Style;
  /** BCP-47 code or "auto". */
  language: string;
}

export interface TranscriptionBackend {
  /** True once the model is downloaded and loaded into memory. */
  readonly ready: boolean;
  /** Download (if needed) and load the model. */
  load(onProgress: (u: ProgressUpdate) => void, allowRemote?: boolean): Promise<void>;
  /** Transcribe a single <=30 s mono 16 kHz chunk. */
  transcribeChunk(audio: Float32Array, opts: TranscribeOptions): Promise<string>;
  /** Rewrite already-transcribed text into tidy prose (text-only call). */
  rewrite(text: string): Promise<string>;
  /** Free model memory. */
  unload(): Promise<void>;
}

/** True when the renderer exposes a usable WebGPU adapter. */
export async function detectWebGPU(): Promise<boolean> {
  // Use activeWindow.navigator for Obsidian popout window compatibility
  const gpu = (activeWindow.navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}


/**
 * Wraps a progress callback to throttle updates during high-frequency download events.
 * It will trigger immediately if:
 * 1. The progress represents a final state (fraction is 1.0, null, or label contains "ready" or "memory").
 * 2. The rounded integer percentage changes AND at least intervalMs (default 300ms) has passed since the last trigger.
 */
function throttleProgress(
  onProgress: (u: ProgressUpdate) => void,
  intervalMs = 300
): (u: ProgressUpdate) => void {
  let lastTriggerTime = 0;
  let lastPercent = -1;

  return (u: ProgressUpdate) => {
    const fraction = u.fraction;
    const isFinal =
      fraction === 1.0 ||
      fraction === null ||
      u.label.includes("ready") ||
      u.label.includes("memory") ||
      u.label.includes("ready.");

    const percent = fraction !== null ? Math.round(fraction * 100) : -1;
    const now = Date.now();

    if (isFinal || (percent !== lastPercent && now - lastTriggerTime >= intervalMs)) {
      lastTriggerTime = now;
      lastPercent = percent;
      onProgress(u);
    }
  };
}

export class GemmaBackend implements TranscriptionBackend {
  private model: GemmaModelInstance | null = null;
  private processor: GemmaProcessorInstance | null = null;
  readonly variant: ModelVariant;
  private device: "webgpu" | "wasm" = "wasm";
  private cacheDir: string;

  constructor(variant: ModelVariant, useWebGPU: boolean, cacheDir: string) {
    this.variant = variant;
    this.device = useWebGPU ? "webgpu" : "wasm";
    this.cacheDir = cacheDir;
  }

  get ready(): boolean {
    return this.model != null && this.processor != null;
  }

  async load(onProgress: (u: ProgressUpdate) => void, allowRemote = true): Promise<void> {
    if (this.ready) return;

    const throttledProgress = throttleProgress(onProgress, 300);

    // transformers.js is bundled; ONNX runtime assets resolve from the CDN.
    const tfjs = (await import("@huggingface/transformers")) as unknown as {
      AutoProcessor: PretrainedProcessorClass;
      Gemma4ForConditionalGeneration: PretrainedModelClass;
      env: TransformersEnv;
    };
    const { AutoProcessor, Gemma4ForConditionalGeneration, env } = tfjs;

    // Cache model files in the browser Cache API so subsequent loads are offline.
    env.allowLocalModels = true;
    env.useBrowserCache = true;
    env.useFSCache = false;
    env.allowRemoteModels = allowRemote;

    // --- diagnostic: confirm ORT-Web wired up by the alias ---
    console.debug("[gn] env.backends.onnx keys:", Object.keys(env.backends?.onnx ?? {}));
    console.debug("[gn] env.backends.onnx.wasm:", env.backends?.onnx?.wasm);
    console.debug("[gn] wasmPaths:", env.backends?.onnx?.wasm?.wasmPaths);

    const repo = MODEL_REPOS[this.variant];
    const seen = new Map<string, number>();
    const progress_callback = (p: ProgressEventData) => {
      // transformers.js emits per-file "progress" events and may also emit an
      // aggregate "progress_total"; handle whichever arrives.
      if (typeof p?.progress === "number" && p.status !== "done") {
        seen.set(p.file ?? p.status ?? "model", p.progress);
        const avg = [...seen.values()].reduce((a, b) => a + b, 0) / seen.size;
        throttledProgress({ fraction: avg / 100, label: `Downloading ${p.file ?? "model"}` });
      } else if (p?.status === "ready" || p?.status === "done") {
        throttledProgress({ fraction: 1, label: "Loading model into memory…" });
      }
    };

    this.processor = await AutoProcessor.from_pretrained(repo, { progress_callback });
    this.model = await Gemma4ForConditionalGeneration.from_pretrained(repo, {
      dtype: "q4f16",
      device: this.device,
      progress_callback,
    });
    throttledProgress({ fraction: 1, label: "Model ready." });
  }

  async unload(): Promise<void> {
    if (this.model) {
      await this.model.dispose?.();
      this.model = null;
    }
    this.processor = null;
  }

  async transcribeChunk(audio: Float32Array, opts: TranscribeOptions): Promise<string> {
    const lang =
      opts.language === "auto" ? "" : ` The audio is spoken in ${opts.language}.`;
    const instruction =
      opts.style === "verbatim"
        ? "Transcribe the following audio exactly as spoken, including filler " +
          "words and false starts."
        : "Transcribe the following audio. Remove filler words such as 'um' " +
          "and 'uh', and add natural punctuation and capitalization, but do " +
          "not rephrase or change the wording.";
    const prompt = `${instruction}${lang} Output only the transcription with no preamble.`;

    const messages = [
      { role: "user", content: [{ type: "audio" }, { type: "text", text: prompt }] },
    ];
    return this.generate(messages, audio);
  }

  async rewrite(text: string): Promise<string> {
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Rewrite the following note into clear, well-structured prose. " +
              "Preserve all meaning; fix grammar and flow. Output only the " +
              `rewritten text with no preamble.\n\n${text}`,
          },
        ],
      },
    ];
    return this.generate(messages);
  }

  /**
   * Run one generation pass, following the transformers.js sample for
   * `onnx-community/gemma-4-E*-it-ONNX`: `apply_chat_template` builds a prompt
   * string, then the processor tokenizes it together with any media.
   */
  private async generate(messages: unknown, audio?: Float32Array): Promise<string> {
    if (!this.ready || !this.processor || !this.model) throw new Error("Model is not loaded.");

    const prompt = this.processor.apply_chat_template(messages, {
      enable_thinking: false,
      add_generation_prompt: true,
    });

    // Signature: processor(prompt, image, audio, options).
    const inputs = await this.processor(prompt, null, audio ?? null, {
      add_special_tokens: false,
    });

    const outputs = await this.model.generate({
      ...inputs,
      max_new_tokens: 512,
      do_sample: false,
    });

    const slicedOutputs = outputs.slice(null, [inputs.input_ids.dims.at(-1) ?? null, null]);
    const decoded: string[] = this.processor.batch_decode(
      slicedOutputs,
      { skip_special_tokens: true },
    );

    // Dispose of intermediate tensors to prevent GPU/VRAM memory accumulation
    if (inputs) {
      for (const value of Object.values(inputs)) {
        if (value && typeof (value as GemmaTensor).dispose === "function") {
          (value as GemmaTensor).dispose!();
        }
      }
    }
    if (outputs && typeof outputs.dispose === "function") {
      outputs.dispose();
    }
    if (slicedOutputs && typeof slicedOutputs.dispose === "function") {
      slicedOutputs.dispose();
    }

    return decoded[0]?.trim() ?? "";
  }
}

export class WhisperBackend implements TranscriptionBackend {
  readonly variant: TranscriptionModelVariant = "Whisper-Tiny";
  private pipeline: WhisperPipelineInstance | null = null;
  private device: "webgpu" | "wasm" = "wasm";
  private cacheDir: string;

  constructor(useWebGPU: boolean, cacheDir: string) {
    this.device = useWebGPU ? "webgpu" : "wasm";
    this.cacheDir = cacheDir;
  }

  get ready(): boolean {
    return this.pipeline != null;
  }

  async load(onProgress: (u: ProgressUpdate) => void, allowRemote = true): Promise<void> {
    if (this.ready) return;

    const throttledProgress = throttleProgress(onProgress, 300);

    const tfjs = (await import("@huggingface/transformers")) as unknown as {
      pipeline: PretrainedPipelineClass;
      env: TransformersEnv;
    };
    const { pipeline, env } = tfjs;

    // Cache model files in the browser Cache API so subsequent loads are offline.
    env.allowLocalModels = true;
    env.useBrowserCache = true;
    env.useFSCache = false;
    env.allowRemoteModels = allowRemote;

    const repo = MODEL_REPOS["Whisper-Tiny"];
    const seen = new Map<string, number>();
    const progress_callback = (p: ProgressEventData) => {
      if (typeof p?.progress === "number" && p.status !== "done") {
        seen.set(p.file ?? p.status ?? "model", p.progress);
        const avg = [...seen.values()].reduce((a, b) => a + b, 0) / seen.size;
        throttledProgress({ fraction: avg / 100, label: `Downloading ${p.file ?? "model"}` });
      } else if (p?.status === "ready" || p?.status === "done") {
        throttledProgress({ fraction: 1, label: "Loading model into memory…" });
      }
    };

    this.pipeline = await pipeline("automatic-speech-recognition", repo, {
      device: this.device,
      progress_callback,
    });
    throttledProgress({ fraction: 1, label: "Model ready." });
  }

  async unload(): Promise<void> {
    if (this.pipeline) {
      if (typeof this.pipeline.dispose === "function") {
        await this.pipeline.dispose();
      } else if (this.pipeline.model) {
        await this.pipeline.model.dispose?.();
      }
      this.pipeline = null;
    }
  }

  async transcribeChunk(audio: Float32Array, opts: TranscribeOptions): Promise<string> {
    if (!this.ready || !this.pipeline) throw new Error("Whisper model is not loaded.");

    const result = await this.pipeline(audio);

    return result?.text?.trim() ?? "";
  }

  async rewrite(text: string): Promise<string> {
    throw new Error("Rewriting is not supported by the Whisper model. Please switch to a Gemma model in settings.");
  }
}

export class DualBackend implements TranscriptionBackend {
  private txBackend: TranscriptionBackend;
  private rxBackend: TranscriptionBackend;

  constructor(
    txVariant: TranscriptionModelVariant,
    rxVariant: RewriteModelVariant,
    useWebGPU: boolean,
    cacheDir: string
  ) {
    if (txVariant === "Whisper-Tiny") {
      this.txBackend = new WhisperBackend(useWebGPU, cacheDir);
    } else {
      this.txBackend = new GemmaBackend(txVariant, useWebGPU, cacheDir);
    }

    if ((txVariant as string) === rxVariant) {
      this.rxBackend = this.txBackend;
    } else {
      this.rxBackend = new GemmaBackend(rxVariant, useWebGPU, cacheDir);
    }
  }

  get ready(): boolean {
    return this.txBackend.ready && this.rxBackend.ready;
  }

  async load(onProgress: (u: ProgressUpdate) => void, allowRemote = true): Promise<void> {
    if (this.txBackend === this.rxBackend) {
      await this.txBackend.load(onProgress, allowRemote);
    } else {
      onProgress({ fraction: 0.0, label: "Loading transcription model..." });
      await this.txBackend.load((u) => {
        onProgress({
          fraction: u.fraction ? u.fraction * 0.5 : 0.25,
          label: `[Transcription] ${u.label}`,
        });
      }, allowRemote);

      onProgress({ fraction: 0.5, label: "Loading rewriting model..." });
      await this.rxBackend.load((u) => {
        onProgress({
          fraction: u.fraction ? 0.5 + u.fraction * 0.5 : 0.75,
          label: `[Rewriting] ${u.label}`,
        });
      }, allowRemote);

      onProgress({ fraction: 1.0, label: "All models ready." });
    }
  }

  async transcribeChunk(audio: Float32Array, opts: TranscribeOptions): Promise<string> {
    return this.txBackend.transcribeChunk(audio, opts);
  }

  async rewrite(text: string): Promise<string> {
    return this.rxBackend.rewrite(text);
  }

  async updateVariants(
    txVariant: TranscriptionModelVariant,
    rxVariant: RewriteModelVariant,
    useWebGPU: boolean,
    cacheDir: string
  ): Promise<void> {
    const existing = new Set<TranscriptionBackend>();
    if (this.txBackend) existing.add(this.txBackend);
    if (this.rxBackend) existing.add(this.rxBackend);

    let newTxBackend: TranscriptionBackend;
    let newRxBackend: TranscriptionBackend;

    // Find or create txBackend
    const foundTx = Array.from(existing).find(
      (b) =>
        (b instanceof GemmaBackend && b.variant === txVariant) ||
        (b instanceof WhisperBackend && txVariant === "Whisper-Tiny")
    );
    if (foundTx) {
      newTxBackend = foundTx;
    } else {
      newTxBackend =
        txVariant === "Whisper-Tiny"
          ? new WhisperBackend(useWebGPU, cacheDir)
          : new GemmaBackend(txVariant, useWebGPU, cacheDir);
    }

    // Find or create rxBackend
    if ((txVariant as string) === rxVariant) {
      newRxBackend = newTxBackend;
    } else {
      const foundRx = Array.from(existing).find(
        (b) => b instanceof GemmaBackend && b.variant === rxVariant
      );
      if (foundRx) {
        newRxBackend = foundRx;
      } else {
        newRxBackend = new GemmaBackend(rxVariant, useWebGPU, cacheDir);
      }
    }

    // Determine backends to unload
    const toUnload = Array.from(existing).filter(
      (b) => b !== newTxBackend && b !== newRxBackend
    );

    // Unload them in parallel and await their disposal
    await Promise.all(toUnload.map((b) => b.unload()));

    // Assign new backends
    this.txBackend = newTxBackend;
    this.rxBackend = newRxBackend;
  }

  async unload(): Promise<void> {
    const promises = [];
    if (this.txBackend) {
      promises.push(this.txBackend.unload());
    }
    if (this.rxBackend && this.rxBackend !== this.txBackend) {
      promises.push(this.rxBackend.unload());
    }
    await Promise.all(promises);
  }
}
