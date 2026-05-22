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
    const { AutoProcessor, AutoModelForImageTextToText, env } = tfjs as any;

    // Only allow remote model files; cache them in the browser Cache API so
    // subsequent loads are fully offline.
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    const repo = MODEL_REPOS[this.variant];
    const seenFiles = new Map<string, number>();
    const progress_callback = (p: any) => {
      if (p.status === "progress" && typeof p.progress === "number") {
        seenFiles.set(p.file, p.progress);
        const avg =
          [...seenFiles.values()].reduce((a, b) => a + b, 0) / seenFiles.size;
        onProgress({ fraction: avg / 100, label: `Downloading ${p.file}` });
      } else if (p.status === "ready" || p.status === "done") {
        onProgress({ fraction: 1, label: "Loading model into memory…" });
      }
    };

    this.processor = await AutoProcessor.from_pretrained(repo, { progress_callback });
    this.model = await AutoModelForImageTextToText.from_pretrained(repo, {
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
   * Run one generation pass.
   *
   * NOTE: the exact processor/model call surface for Gemma 4 audio in
   * transformers.js should be confirmed against the model card's sample code;
   * this follows the documented image-text-to-text pattern with an `audio`
   * input added to `apply_chat_template`.
   */
  private async generate(messages: unknown, audio?: Float32Array): Promise<string> {
    if (!this.ready) throw new Error("Model is not loaded.");

    const inputs = await this.processor.apply_chat_template(messages, {
      add_generation_prompt: true,
      tokenize: true,
      return_dict: true,
      ...(audio ? { audio: [audio] } : {}),
    });

    const output = await this.model.generate({
      ...inputs,
      max_new_tokens: 512,
      do_sample: false,
    });

    const promptLen = inputs.input_ids.dims.at(-1);
    const decoded: string[] = this.processor.batch_decode(
      output.slice(null, [promptLen, null]),
      { skip_special_tokens: true },
    );
    return decoded[0]?.trim() ?? "";
  }
}
