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
  load(onProgress: (u: ProgressUpdate) => void): Promise<void>;
  /** Transcribe a single <=30 s mono 16 kHz chunk. */
  transcribeChunk(audio: Float32Array, opts: TranscribeOptions): Promise<string>;
  /** Rewrite already-transcribed text into tidy prose (text-only call). */
  rewrite(text: string): Promise<string>;
  /** Free model memory. */
  unload(): void;
}

/** True when the renderer exposes a usable WebGPU adapter. */
export async function detectWebGPU(): Promise<boolean> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

export class GemmaBackend implements TranscriptionBackend {
  private model: any = null;
  private processor: any = null;
  private variant: ModelVariant;
  private device: "webgpu" | "wasm" = "wasm";

  constructor(variant: ModelVariant, useWebGPU: boolean) {
    this.variant = variant;
    this.device = useWebGPU ? "webgpu" : "wasm";
  }

  get ready(): boolean {
    return this.model != null && this.processor != null;
  }

  async load(onProgress: (u: ProgressUpdate) => void): Promise<void> {
    if (this.ready) return;

    // transformers.js is bundled; ONNX runtime assets resolve from the CDN.
    const tfjs = await import("@huggingface/transformers");
    const { AutoProcessor, Gemma4ForConditionalGeneration, env } = tfjs as any;

    // Only allow remote model files; cache them in the browser Cache API so
    // subsequent loads are fully offline.
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    // --- diagnostic: confirm ORT-Web wired up by the alias ---
    console.log("[gn] env.backends.onnx keys:", Object.keys(env.backends?.onnx ?? {}));
    console.log("[gn] env.backends.onnx.wasm:", env.backends?.onnx?.wasm);
    console.log("[gn] wasmPaths:", env.backends?.onnx?.wasm?.wasmPaths);

    const repo = MODEL_REPOS[this.variant];
    const seen = new Map<string, number>();
    const progress_callback = (p: any) => {
      // transformers.js emits per-file "progress" events and may also emit an
      // aggregate "progress_total"; handle whichever arrives.
      if (typeof p?.progress === "number" && p.status !== "done") {
        seen.set(p.file ?? p.status, p.progress);
        const avg = [...seen.values()].reduce((a, b) => a + b, 0) / seen.size;
        onProgress({ fraction: avg / 100, label: `Downloading ${p.file ?? "model"}` });
      } else if (p?.status === "ready" || p?.status === "done") {
        onProgress({ fraction: 1, label: "Loading model into memory…" });
      }
    };

    this.processor = await AutoProcessor.from_pretrained(repo, { progress_callback });
    this.model = await Gemma4ForConditionalGeneration.from_pretrained(repo, {
      dtype: "q4f16",
      device: this.device,
      progress_callback,
    });
    onProgress({ fraction: 1, label: "Model ready." });
  }

  unload(): void {
    this.model?.dispose?.();
    this.model = null;
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
    if (!this.ready) throw new Error("Model is not loaded.");

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

    const decoded: string[] = this.processor.batch_decode(
      outputs.slice(null, [inputs.input_ids.dims.at(-1), null]),
      { skip_special_tokens: true },
    );
    return decoded[0]?.trim() ?? "";
  }
}

export class WhisperBackend implements TranscriptionBackend {
  private pipeline: any = null;
  private device: "webgpu" | "wasm" = "wasm";

  constructor(useWebGPU: boolean) {
    this.device = useWebGPU ? "webgpu" : "wasm";
  }

  get ready(): boolean {
    return this.pipeline != null;
  }

  async load(onProgress: (u: ProgressUpdate) => void): Promise<void> {
    if (this.ready) return;

    const tfjs = await import("@huggingface/transformers");
    const { pipeline, env } = tfjs as any;

    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const repo = MODEL_REPOS["Whisper-Tiny"];
    const seen = new Map<string, number>();
    const progress_callback = (p: any) => {
      if (typeof p?.progress === "number" && p.status !== "done") {
        seen.set(p.file ?? p.status, p.progress);
        const avg = [...seen.values()].reduce((a, b) => a + b, 0) / seen.size;
        onProgress({ fraction: avg / 100, label: `Downloading ${p.file ?? "model"}` });
      } else if (p?.status === "ready" || p?.status === "done") {
        onProgress({ fraction: 1, label: "Loading model into memory…" });
      }
    };

    this.pipeline = await pipeline("automatic-speech-recognition", repo, {
      device: this.device,
      progress_callback,
    });
    onProgress({ fraction: 1, label: "Model ready." });
  }

  unload(): void {
    this.pipeline?.model?.dispose?.();
    this.pipeline = null;
  }

  async transcribeChunk(audio: Float32Array, opts: TranscribeOptions): Promise<string> {
    if (!this.ready) throw new Error("Whisper model is not loaded.");

    const result = await this.pipeline(audio, {
      task: "transcribe",
    });

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
    useWebGPU: boolean
  ) {
    if (txVariant === "Whisper-Tiny") {
      this.txBackend = new WhisperBackend(useWebGPU);
    } else {
      this.txBackend = new GemmaBackend(txVariant, useWebGPU);
    }

    if ((txVariant as string) === rxVariant) {
      this.rxBackend = this.txBackend;
    } else {
      this.rxBackend = new GemmaBackend(rxVariant, useWebGPU);
    }
  }

  get ready(): boolean {
    return this.txBackend.ready && this.rxBackend.ready;
  }

  async load(onProgress: (u: ProgressUpdate) => void): Promise<void> {
    if (this.txBackend === this.rxBackend) {
      await this.txBackend.load(onProgress);
    } else {
      onProgress({ fraction: 0.0, label: "Loading transcription model..." });
      await this.txBackend.load((u) => {
        onProgress({
          fraction: u.fraction ? u.fraction * 0.5 : 0.25,
          label: `[Transcription] ${u.label}`,
        });
      });

      onProgress({ fraction: 0.5, label: "Loading rewriting model..." });
      await this.rxBackend.load((u) => {
        onProgress({
          fraction: u.fraction ? 0.5 + u.fraction * 0.5 : 0.75,
          label: `[Rewriting] ${u.label}`,
        });
      });

      onProgress({ fraction: 1.0, label: "All models ready." });
    }
  }

  async transcribeChunk(audio: Float32Array, opts: TranscribeOptions): Promise<string> {
    return this.txBackend.transcribeChunk(audio, opts);
  }

  async rewrite(text: string): Promise<string> {
    return this.rxBackend.rewrite(text);
  }

  unload(): void {
    this.txBackend.unload();
    if (this.txBackend !== this.rxBackend) {
      this.rxBackend.unload();
    }
  }
}
