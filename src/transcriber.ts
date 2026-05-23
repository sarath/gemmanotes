/**
 * Transcription backend.
 *
 * The backend is kept behind an interface so a remote endpoint could be added
 * later without touching the rest of the plugin. `GemmaBackend` is the default
 * in-process implementation using transformers.js + Gemma 4 ONNX.
 */

import type { ModelVariant, Style } from "./types";
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

    // --- diagnostic + Branch A test ---
    console.log("[gn] env.backends:", env.backends);
    console.log("[gn] env.backends.onnx:", env.backends?.onnx);
    console.log("[gn] env.backends.onnx.wasm:", env.backends?.onnx?.wasm);
    console.log("[gn] wasmPaths before:", env.backends?.onnx?.wasm?.wasmPaths);
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths =
        "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";
      env.backends.onnx.wasm.numThreads = 1;
    }
    console.log("[gn] wasmPaths after:", env.backends?.onnx?.wasm?.wasmPaths);
    // --- end diagnostic ---

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
